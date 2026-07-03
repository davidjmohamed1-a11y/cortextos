---
name: morning-brief
description: "You are at session start or your first heartbeat of the day, and you want to know what happened yesterday + what to do first — WITHOUT walking your entire comms archive + task list + memory files live at 7am. Instead, read the pre-computed brief the nightly-consolidator wrote for you overnight. If the brief file exists for today, READ IT FIRST and treat it as your ground-truth handoff. If missing, fall back to the normal session-start protocol."
triggers: ["morning brief", "session start", "first heartbeat", "resume", "what happened yesterday", "yesterday recap", "what am I doing today", "start of day", "overnight recap", "sleep-time consolidation", "consolidator"]
---

# Morning brief — read this FIRST at session start / first-heartbeat-of-day

The **nightly-consolidator cron** runs overnight (typically 03:30 UTC) and writes a pre-computed brief for each agent at:

```
~/.cortextos/default/state/morning-brief/<agent>/<YYYY-MM-DD>.md
```

Read it FIRST. It replaces the "walk comms archive + tasks + memory" phase of your normal session-start protocol. If it exists for today's date, it IS your ground truth handoff. If it doesn't exist, fall back to the standard start protocol.

## How to check + read

```bash
BRIEF="$CTX_ROOT/state/morning-brief/$CTX_AGENT_NAME/$(date -u +%Y-%m-%d).md"
if [ -f "$BRIEF" ]; then
  cat "$BRIEF"
  # Absorb it. Everything below is what you'd otherwise re-compute.
else
  echo "No brief for today — fall back to standard session-start walk."
fi
```

## Brief structure (7 sections)

1. **Yesterday recap** — comms count (inbound/outbound), tasks completed
2. **End-of-day focus** — the last inbound message + a preview of what you were doing
3. **Open threads** — in_progress + blocked tasks assigned to you
4. **Waiting on** — currently-blocked tasks + their blocker refs
5. **New learnings persisted to MEMORY.md last night** — the top-5 lines the consolidator added; you don't need to re-scan MEMORY.md to know what's new
6. **Suggested next** — highest-priority open task per boss's framework ordering
7. **Frontmatter** — `source: agent-reasoning`, `generated_at`, `by: nightly-consolidator`, `for_date`, `consolidated_dates`

## What the consolidator does + doesn't do

**Does:**
- Reads yesterday's comms archive JSONL, task completions, and daily memory
- Extracts candidate learnings via mechanical heuristics (explicit preferences, corrections, task-completion patterns, repeat topics)
- Deduplicates against your existing MEMORY.md lines (substring match — no synthesis)
- Appends the top-5 dedup-passed candidates as dated + attributed itemized lines below existing content
- Pre-computes the morning brief so it's a READ, not a 7am computation

**Does NOT (by design — ACE anti-context-collapse):**
- Read the CONTENT of existing MEMORY.md lines to summarize / rewrite them
- Touch any existing line — appends only
- Exceed the per-night cap (5 new lines)
- Do LLM synthesis — mechanical extraction only; semantic work is what YOU do when you read the brief

## Trust model

The brief is written by an automated Python cron. It's a fast starting point, not the last word. If something in the brief is wrong or missing, use it as scaffolding and do your own live walk to fill the gap. The brief NEVER replaces David's actual instructions — inbound Telegram/agent-bus overrides anything the brief suggests.

## Weekend behavior

If a night is missed (weekend, crash, David explicitly disabled the cron), the fallback is the standard session-start walk. Sunday nights consolidate Fri+Sat+Sun together (weekend grace).

## If you notice consolidator drift

If the brief has bad extracts or dedup misses (e.g. duplicate lines appear over multiple nights), flag it to boss-personal with the specific line + expected behavior. Consolidator tuning is a real class of feedback — don't silently work around it.

Ship: 2026-07-02 (per boss GO, roadmap #1 — sleep-time consolidation flagship).
