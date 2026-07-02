#!/usr/bin/env bash
# nightly-truth.test.sh — controlled-fixture tests for the reconciliation cron.
#
# Sets up a temp cortextOS root + a temp git repo, seeds task files + commits
# to exercise each classifier branch, runs the script in dry-run, and checks
# the verdicts in the resulting JSON report.
#
# Passing: exit 0. Failing: exit non-zero + diagnostic on stderr.
# Isolated: uses mktemp dirs, cleans up on exit. Doesn't touch real state.

set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/../.." && pwd)/scripts/reconciliation/nightly-truth.py"
[ -x "${SCRIPT}" ] || { echo "FAIL: ${SCRIPT} not executable" >&2; exit 1; }

TMP_ROOT="$(mktemp -d -t nightly-truth-test-XXXXXX)"
TMP_FW="$(mktemp -d -t nightly-truth-fw-XXXXXX)"
trap 'rm -rf "${TMP_ROOT}" "${TMP_FW}"' EXIT

# ---------------------------------------------------------------------------
# Set up a fake framework git repo with pre-seeded commits.
# ---------------------------------------------------------------------------
git -C "${TMP_FW}" init -q -b main
git -C "${TMP_FW}" config user.email "test@example.com"
git -C "${TMP_FW}" config user.name "test"
mkdir -p "${TMP_FW}/src"

# Commit A — has a task_id in the BODY
echo "content 1" > "${TMP_FW}/src/a.txt"
git -C "${TMP_FW}" add . && git -C "${TMP_FW}" commit -q -m "feat(a): initial

task_1000000000000_aaaaaaaa closed by this commit"

# Commit B — has verbatim task TITLE in the SUBJECT
echo "content 2" > "${TMP_FW}/src/b.txt"
git -C "${TMP_FW}" add . && git -C "${TMP_FW}" commit -q -m "fix: ship the widget improvement thing"

# Commit C — has significant word overlap with task title (weak match)
echo "content 3" > "${TMP_FW}/src/c.txt"
git -C "${TMP_FW}" add . && git -C "${TMP_FW}" commit -q -m "refactor pipeline extraction module"

# ---------------------------------------------------------------------------
# Seed task fixtures under a fake org.
# ---------------------------------------------------------------------------
TASKS_DIR="${TMP_ROOT}/orgs/testorg/tasks"
mkdir -p "${TASKS_DIR}"

# 1. STRONG: task_id in a commit body → auto_close
cat > "${TASKS_DIR}/task_1000000000000_aaaaaaaa.json" <<EOF
{"id":"task_1000000000000_aaaaaaaa","title":"Some old task with a random title","status":"open","assigned_to":"forge","org":"testorg","updated_at":"2026-06-01T00:00:00Z","created_at":"2026-06-01T00:00:00Z"}
EOF

# 2. STRONG: verbatim title in commit subject → auto_close
cat > "${TASKS_DIR}/task_1000000000001_bbbbbbbb.json" <<EOF
{"id":"task_1000000000001_bbbbbbbb","title":"ship the widget improvement thing","status":"open","assigned_to":"forge","org":"testorg","updated_at":"2026-06-01T00:00:00Z","created_at":"2026-06-01T00:00:00Z"}
EOF

# 3. WEAK: word overlap with "refactor pipeline extraction module"
cat > "${TASKS_DIR}/task_1000000000002_cccccccc.json" <<EOF
{"id":"task_1000000000002_cccccccc","title":"pipeline extraction refactor for module system","status":"open","assigned_to":"forge","org":"testorg","updated_at":"2026-06-01T00:00:00Z","created_at":"2026-06-01T00:00:00Z"}
EOF

# 4. STALE-OPEN: >14d old, status=open, no signal
cat > "${TASKS_DIR}/task_1000000000003_dddddddd.json" <<EOF
{"id":"task_1000000000003_dddddddd","title":"Some totally unrelated stale open task","status":"open","assigned_to":"forge","org":"testorg","updated_at":"2026-06-01T00:00:00Z","created_at":"2026-06-01T00:00:00Z"}
EOF

# 5. STALE-INPROGRESS: >30d old
cat > "${TASKS_DIR}/task_1000000000004_eeeeeeee.json" <<EOF
{"id":"task_1000000000004_eeeeeeee","title":"Some totally unrelated stale in-progress task","status":"in_progress","assigned_to":"forge","org":"testorg","updated_at":"2026-05-01T00:00:00Z","created_at":"2026-05-01T00:00:00Z"}
EOF

# 6. Active work skip: updated within 4h, has task_id match → should SKIP not auto_close
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "${TASKS_DIR}/task_1000000000005_ffffffff.json" <<EOF
{"id":"task_1000000000005_ffffffff","title":"Some other task","status":"in_progress","assigned_to":"forge","org":"testorg","updated_at":"${NOW_ISO}","created_at":"2026-06-01T00:00:00Z"}
EOF
# … make commit reference this id so signals would fire if not for skip
echo "content 6" > "${TMP_FW}/src/f.txt"
git -C "${TMP_FW}" add . && git -C "${TMP_FW}" commit -q -m "fix: something referencing task_1000000000005_ffffffff"

# 7. Already completed — should NOT be classified at all
cat > "${TASKS_DIR}/task_1000000000006_gggggggg.json" <<EOF
{"id":"task_1000000000006_gggggggg","title":"Already done","status":"completed","assigned_to":"forge","org":"testorg","updated_at":"2026-06-01T00:00:00Z","created_at":"2026-06-01T00:00:00Z"}
EOF

# ---------------------------------------------------------------------------
# Run in dry-run mode + inspect the JSON report.
# ---------------------------------------------------------------------------
"${SCRIPT}" \
  --ctx-root "${TMP_ROOT}" \
  --framework-root "${TMP_FW}" \
  --dry-run --no-report \
  --now "2026-07-02T12:00:00Z" > /dev/null

REPORT="${TMP_ROOT}/state/reconciliation/2026-07-02.json"
[ -f "${REPORT}" ] || { echo "FAIL: report not written" >&2; exit 1; }

check() {
  # $1 = task_id substring, $2 = expected action, $3 = optional expected reason substring
  local id="$1" want_action="$2" want_reason_sub="${3:-}"
  local got
  got="$(python3 -c "
import json, sys
r = json.load(open('${REPORT}'))
for v in r['verdicts']:
    if '$id' in v['task_id']:
        print(v['action'] + '|' + v['reason'])
        break
")"
  local action="${got%%|*}"
  local reason="${got#*|}"
  if [ "${action}" != "${want_action}" ]; then
    echo "FAIL: task ${id} expected action=${want_action}, got '${action}' (reason: ${reason})" >&2
    return 1
  fi
  if [ -n "${want_reason_sub}" ] && [[ "${reason}" != *"${want_reason_sub}"* ]]; then
    echo "FAIL: task ${id} expected reason to contain '${want_reason_sub}', got '${reason}'" >&2
    return 1
  fi
  echo "PASS: ${id} → ${action} (${reason})"
}

check "aaaaaaaa" "auto_close" "task_id in commit body" || exit 1
check "bbbbbbbb" "auto_close" "verbatim title match" || exit 1
check "cccccccc" "suggest_close" "title words overlap" || exit 1
check "dddddddd" "flag_stale" "stale-open" || exit 1
check "eeeeeeee" "flag_stale" "stale-inprogress" || exit 1
check "ffffffff" "keep" "active work" || exit 1

# 7 (completed) should not appear
if python3 -c "
import json, sys
r = json.load(open('${REPORT}'))
for v in r['verdicts']:
    if 'gggggggg' in v['task_id']:
        sys.exit(1)
sys.exit(0)
"; then
  echo "PASS: gggggggg completed task correctly excluded from verdicts"
else
  echo "FAIL: gggggggg completed task should not appear in verdicts" >&2
  exit 1
fi

# Summary check
SUMMARY="$(python3 -c "
import json
r = json.load(open('${REPORT}'))
s = r['summary']
print(f\"auto={s['auto_closed']} suggest={s['suggest_close']} stale={s['flag_stale']} kept={s['kept_open']}\")
")"
echo ""
echo "Summary counts: ${SUMMARY}"
if [ "${SUMMARY}" != "auto=2 suggest=1 stale=2 kept=1" ]; then
  echo "FAIL: unexpected summary" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Live-mode test: run without --dry-run + verify auto_close ACTUALLY modifies
# the task file.
# ---------------------------------------------------------------------------
"${SCRIPT}" \
  --ctx-root "${TMP_ROOT}" \
  --framework-root "${TMP_FW}" \
  --no-report \
  --now "2026-07-02T13:00:00Z" > /dev/null

# Task aaaaaaaa should now be status=completed
STATUS="$(python3 -c "
import json
print(json.load(open('${TASKS_DIR}/task_1000000000000_aaaaaaaa.json'))['status'])
")"
if [ "${STATUS}" != "completed" ]; then
  echo "FAIL: live-mode did not close aaaaaaaa (status=${STATUS})" >&2
  exit 1
fi
echo "PASS: live-mode auto-closed aaaaaaaa (task file mutated)"

# But dddddddd (stale-open) should still be status=open
STATUS_D="$(python3 -c "
import json
print(json.load(open('${TASKS_DIR}/task_1000000000003_dddddddd.json'))['status'])
")"
if [ "${STATUS_D}" != "open" ]; then
  echo "FAIL: stale-flag should NOT close (status=${STATUS_D})" >&2
  exit 1
fi
echo "PASS: stale-flag did not close (report only)"

echo ""
echo "ALL PASS."
