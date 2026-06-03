# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

**Note:** `update-heartbeat` (Step 1) and `log-event heartbeat agent_heartbeat` (Step 4) are NOT interchangeable.
- `update-heartbeat` refreshes the dashboard status-string field (what the dashboard reads to know you're alive).
- `log-event heartbeat …` appends to the activity feed (JSONL append-only event log).

Both are required every cycle. Skipping Step 1 leaves your dashboard view stale even though you're firing events.

## Step 2: Check inbox

```bash
cortextos bus check-inbox
```

Process ALL messages. ACK every single one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered in 5 minutes. Do not ignore them.
Target: 0 un-ACK'd messages after this step.

## Step 3: System health check (ANALYST — do this before your own tasks)

Full reference: `.claude/skills/agent-management/SKILL.md`

```bash
# Check all agent heartbeats — flag any silent for >5 hours
cortextos bus read-all-heartbeats

# Check for agents with no recent activity
cortextos bus list-tasks --status in_progress 2>/dev/null | head -20
```

For each agent: if heartbeat is older than 5 hours, send a message to that agent:
```bash
cortextos bus send-message <agent_name> normal "Heartbeat check: are you running? Last heartbeat was more than 5 hours ago."
```

If an agent is unresponsive for >8 hours, notify the orchestrator and log the issue:
```bash
cortextos bus send-message $CTX_ORCHESTRATOR_AGENT normal "Agent <name> appears unresponsive — last heartbeat >8h ago. May need restart."
cortextos bus log-event action agent_unresponsive warning --meta '{"agent":"<name>","hours_silent":8}'
```

## Step 3e: Orchestrator silent-offline watchdog (tight check, alert user direct)

Tighter check on the orchestrator specifically: if their heartbeat is stale >30 min during the user's waking hours, Telegram the user directly. The general >5h check above is too loose to catch a stalled orchestrator before the user notices — a silently-dead orchestrator means no morning briefing, no task dispatch, no approval routing.

Why direct-to-user: if the orchestrator is the one silent, messaging them would land in an inbox no one is reading. The user's Telegram is the next escalation rung.

Idempotent at the cycle level: this step runs once per heartbeat invocation. The natural gap between cycles is the cross-cycle dedup. If the orchestrator is still silent next cycle, the user gets a fresh alert — that is intentional, an unresolved outage should stay visible.

```bash
# Waking-hours window. Defaults to 07:00–23:00 in $CTX_TIMEZONE (set by the
# daemon from config.json `timezone`, falls back to system TZ). Override the
# threshold by editing WAKE_START / WAKE_END below if your operator runs on a
# different schedule.
WAKE_START=7
WAKE_END=23
LOCAL_HOUR=$(TZ="${CTX_TIMEZONE:-UTC}" date +%H)
if [ -n "$CTX_ORCHESTRATOR_AGENT" ] \
  && [ "$CTX_ORCHESTRATOR_AGENT" != "$CTX_AGENT_NAME" ] \
  && [ "$LOCAL_HOUR" -ge "$WAKE_START" ] \
  && [ "$LOCAL_HOUR" -lt "$WAKE_END" ]; then

  ORCH_HB="${CTX_ROOT:-$HOME/.cortextos/default}/state/${CTX_ORCHESTRATOR_AGENT}/heartbeat.json"
  ORCH_TS=$(jq -r '.last_heartbeat // empty' "$ORCH_HB" 2>/dev/null)
  # Treat missing / unreadable / unparseable as silent (large age sentinel).
  AGE_MIN=999
  if [ -n "$ORCH_TS" ]; then
    # Portable epoch parse: GNU `date -d` (Linux) first, fall back to BSD
    # `date -j -u -f` (macOS). The `-u` on BSD is REQUIRED — without it BSD
    # ignores the trailing "Z" and parses the timestamp as local time, which
    # shifts the epoch by the local UTC offset and produces nonsense ages.
    ORCH_EPOCH=$(date -d "$ORCH_TS" +%s 2>/dev/null) \
      || ORCH_EPOCH=$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$ORCH_TS" +%s 2>/dev/null)
    if [ -n "$ORCH_EPOCH" ]; then
      NOW_EPOCH=$(date -u +%s)
      AGE_MIN=$(( (NOW_EPOCH - ORCH_EPOCH) / 60 ))
    fi
  fi
  if [ "$AGE_MIN" -gt 30 ]; then
    echo "WATCHDOG: $CTX_ORCHESTRATOR_AGENT heartbeat stale ${AGE_MIN}m — alerting user directly"
    cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
      "Watchdog: $CTX_ORCHESTRATOR_AGENT has been silent for ${AGE_MIN} min (threshold 30 min, waking hours). Last heartbeat: ${ORCH_TS:-missing}. May need a restart."
    cortextos bus log-event action anomaly_detected warning \
      --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"anomaly\":\"orchestrator_silent_offline\",\"watched\":\"$CTX_ORCHESTRATOR_AGENT\",\"age_min\":${AGE_MIN}}"
  fi
fi
```

The three guards on the outer `if` matter:
- `CTX_ORCHESTRATOR_AGENT` non-empty — skip silently when no orchestrator is configured (early-bootstrap orgs).
- `!= CTX_AGENT_NAME` — never watch yourself; a stalled analyst can't catch its own stall, and the alert would be circular noise.
- Waking-hours gate — quiet during the user's night so an overnight orchestrator pause does not buzz Telegram at 03:00.

## Step 3b: Check own task queue + stale task detection

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

Stale tasks are visible on the dashboard. They make you look broken.

## Step 4: Log heartbeat event

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

```bash
TODAY=$(date -u +%Y-%m-%d)
LOCAL_TIME=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
MEMORY_DIR="$(pwd)/memory"
mkdir -p "$MEMORY_DIR"
cat >> "$MEMORY_DIR/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +%H:%M UTC) / $LOCAL_TIME
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Check GOALS.md

Read GOALS.md for any new objectives from the user.
If goals changed since last check, create tasks to address them:

```bash
cortextos bus create-task "<title>" --desc "<description>" --assignee $CTX_AGENT_NAME --priority normal
```

## Step 7: Resume work

Pick your highest priority task and work on it.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" "<summary of what was produced>"
```

## Step 8: Update long-term memory (if applicable)

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.
