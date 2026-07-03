#!/usr/bin/env bash
# nightly-consolidator.test.sh — controlled-fixture tests for the
# per-agent sleep-time consolidation cron.
#
# 8 test cases: no_new_learnings, explicit_preference, task_completion,
# dedup_existing, cap_enforcement, morning_brief_write, ace_no_rewrite,
# provenance_satisfied.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/../.." && pwd)/scripts/consolidation/nightly-consolidator.py"
[ -x "${SCRIPT}" ] || { echo "FAIL: ${SCRIPT} not executable" >&2; exit 1; }

TMP_CTX="$(mktemp -d -t consolidator-ctx-XXXXXX)"
TMP_FW="$(mktemp -d -t consolidator-fw-XXXXXX)"
trap 'rm -rf "${TMP_CTX}" "${TMP_FW}"' EXIT

AGENT="testagent"
ORG="testorg"

# Fixed "now" = Tue 2026-07-07T04:00Z → consolidates only Mon 2026-07-06.
NOW_ISO="2026-07-07T04:00:00Z"
YEST="2026-07-06"
YYYYMM="2026-07"

MEM_PATH="${TMP_FW}/orgs/${ORG}/agents/${AGENT}/MEMORY.md"

setup_dirs() {
  mkdir -p "${TMP_CTX}/analytics/comms/${YYYYMM}"
  mkdir -p "${TMP_CTX}/orgs/${ORG}/tasks"
  mkdir -p "${TMP_FW}/orgs/${ORG}/agents/${AGENT}/memory"
}

seed_memory() {
  cat > "${MEM_PATH}" <<'MEM'
---
source: agent-reasoning
---

- [Existing memory line about widget architecture — pre-existing]
- [Another existing pattern: never trust cache without invalidation]
MEM
}

reset_fixtures() {
  rm -f "${TMP_CTX}/analytics/comms/${YYYYMM}/${AGENT}.jsonl"
  rm -rf "${TMP_CTX}/orgs/${ORG}/tasks"
  mkdir -p "${TMP_CTX}/orgs/${ORG}/tasks"
  rm -rf "${TMP_CTX}/state"
  seed_memory
}

run_consolidator() {
  "${SCRIPT}" \
    --agent "${AGENT}" \
    --org "${ORG}" \
    --ctx-root "${TMP_CTX}" \
    --framework-root "${TMP_FW}" \
    --now "${NOW_ISO}" \
    > /dev/null
}

comms_line() {
  # Args: direction sender text (text must be a JSON-quoted string)
  local direction="$1" sender="$2" text="$3"
  local id="${RANDOM}-${RANDOM}"
  printf '{"version":1,"id":"%s","agent":"%s","direction":"%s","channel":"agent_bus","sender":"%s","recipient":"%s","timestamp":"%sT14:00:00Z","text":%s,"msg_id":"m-%s","reply_to":"","metadata":{}}\n' \
    "${id}" "${AGENT}" "${direction}" "${sender}" "${AGENT}" "${YEST}" "${text}" "${id}" \
    >> "${TMP_CTX}/analytics/comms/${YYYYMM}/${AGENT}.jsonl"
}

count_added_lines() {
  # grep -c returns 0 with exit=1 if no matches — swallow the exit code but
  # not the count. Redirect nonzero-match cases explicitly.
  local n
  n="$(grep -c "by:nightly-consolidator" "${MEM_PATH}" 2>/dev/null)" || n=0
  echo "${n}"
}

setup_dirs

# ---------------------------------------------------------------------------
# 1. no_new_learnings
# ---------------------------------------------------------------------------
reset_fixtures
comms_line inbound boss-personal '"routine ping"'
comms_line inbound boss-personal '"another ping"'
run_consolidator
n="$(count_added_lines)"
[ "${n}" = "0" ] || { echo "FAIL 1/8 (no_new_learnings): expected 0, got ${n}" >&2; exit 1; }
echo "PASS 1/8 no_new_learnings"

# ---------------------------------------------------------------------------
# 2. explicit_preference
# ---------------------------------------------------------------------------
reset_fixtures
comms_line inbound boss-personal '"From now on always cite the commit SHA in your reports. That is the rule."'
run_consolidator
n="$(count_added_lines)"
[ "${n}" -ge "1" ] || { echo "FAIL 2/8 (explicit_preference): expected >=1, got ${n}" >&2; exit 1; }
grep -qi "from now on" "${MEM_PATH}" || { echo "FAIL 2/8: preference text missing" >&2; exit 1; }
echo "PASS 2/8 explicit_preference (n=${n})"

# ---------------------------------------------------------------------------
# 3. task_completion
# ---------------------------------------------------------------------------
reset_fixtures
cat > "${TMP_CTX}/orgs/${ORG}/tasks/task_1_a.json" <<TASK
{"id":"task_1_a","title":"Ship the new lasers module","status":"completed","assigned_to":"${AGENT}","org":"${ORG}","completed_at":"${YEST}T15:00:00Z","result":"Landed as commit abc123def456. Working."}
TASK
run_consolidator
n="$(count_added_lines)"
[ "${n}" -ge "1" ] || { echo "FAIL 3/8 (task_completion): expected >=1, got ${n}" >&2; exit 1; }
grep -qi "lasers module" "${MEM_PATH}" || { echo "FAIL 3/8: task title missing" >&2; exit 1; }
grep -q "abc123d" "${MEM_PATH}" || { echo "FAIL 3/8: commit SHA missing" >&2; exit 1; }
echo "PASS 3/8 task_completion"

# ---------------------------------------------------------------------------
# 4. dedup_existing
# ---------------------------------------------------------------------------
reset_fixtures
echo "- always cite the commit SHA in your reports" >> "${MEM_PATH}"
comms_line inbound boss-personal '"From now on always cite the commit SHA in your reports."'
run_consolidator
n="$(count_added_lines)"
[ "${n}" = "0" ] || { echo "FAIL 4/8 (dedup_existing): expected 0 (dedup), got ${n}" >&2; cat "${MEM_PATH}" >&2; exit 1; }
echo "PASS 4/8 dedup_existing"

# ---------------------------------------------------------------------------
# 5. cap_enforcement
# ---------------------------------------------------------------------------
reset_fixtures
for i in 1 2 3 4 5 6 7 8 9 10; do
  cat > "${TMP_CTX}/orgs/${ORG}/tasks/task_c${i}.json" <<TASK
{"id":"task_c${i}","title":"Distinct task alpha${i} bravo charlie delta echo","status":"completed","assigned_to":"${AGENT}","org":"${ORG}","completed_at":"${YEST}T15:00:00Z","result":"shipped as commit deadbe${i}"}
TASK
done
run_consolidator
n="$(count_added_lines)"
[ "${n}" = "5" ] || { echo "FAIL 5/8 (cap_enforcement): expected 5, got ${n}" >&2; cat "${MEM_PATH}" >&2; exit 1; }
echo "PASS 5/8 cap_enforcement"

# ---------------------------------------------------------------------------
# 6. morning_brief_write
# ---------------------------------------------------------------------------
reset_fixtures
comms_line inbound boss-personal '"from now on log the SHA"'
run_consolidator
BRIEF="${TMP_CTX}/state/morning-brief/${AGENT}/2026-07-07.md"
[ -f "${BRIEF}" ] || { echo "FAIL 6/8: brief missing at ${BRIEF}" >&2; exit 1; }
for section in "# Morning brief" "## Yesterday recap" "## End-of-day focus" "## Open threads" "## Waiting on" "## New learnings persisted" "## Suggested next"; do
  grep -qF "${section}" "${BRIEF}" || { echo "FAIL 6/8: missing section '${section}'" >&2; exit 1; }
done
grep -q "^source: agent-reasoning$" "${BRIEF}" || { echo "FAIL 6/8: missing source: frontmatter" >&2; exit 1; }
echo "PASS 6/8 morning_brief_write (7 sections + frontmatter)"

# ---------------------------------------------------------------------------
# 7. ace_no_rewrite — existing content byte-identical
# ---------------------------------------------------------------------------
reset_fixtures
BEFORE="$(cat "${MEM_PATH}")"
comms_line inbound boss-personal '"from now on always log the sha"'
cat > "${TMP_CTX}/orgs/${ORG}/tasks/task_x.json" <<TASK
{"id":"task_x","title":"Some completed task title","status":"completed","assigned_to":"${AGENT}","org":"${ORG}","completed_at":"${YEST}T15:00:00Z","result":"done as abcdef1"}
TASK
run_consolidator
AFTER="$(cat "${MEM_PATH}")"
case "${AFTER}" in
  "${BEFORE}"*) : ;;
  *) echo "FAIL 7/8 (ace_no_rewrite): existing content modified" >&2; exit 1 ;;
esac
[ "${#AFTER}" -gt "${#BEFORE}" ] || { echo "FAIL 7/8: nothing appended" >&2; exit 1; }
echo "PASS 7/8 ace_no_rewrite (byte-identical prefix, ${#AFTER} > ${#BEFORE})"

# ---------------------------------------------------------------------------
# 8. provenance_satisfied — MEMORY.md still valid frontmatter
# ---------------------------------------------------------------------------
head -1 "${MEM_PATH}" | grep -q "^---$" || { echo "FAIL 8/8: missing opening fence" >&2; head -5 "${MEM_PATH}" >&2; exit 1; }
grep -q "^source: agent-reasoning$" <(head -5 "${MEM_PATH}") || { echo "FAIL 8/8: missing source: line" >&2; exit 1; }
FENCE_COUNT="$(head -5 "${MEM_PATH}" | grep -c "^---$")"
[ "${FENCE_COUNT}" -ge "2" ] || { echo "FAIL 8/8: fewer than 2 fence lines in first 5 lines" >&2; head -5 "${MEM_PATH}" >&2; exit 1; }
echo "PASS 8/8 provenance_satisfied"

echo ""
echo "ALL PASS."
