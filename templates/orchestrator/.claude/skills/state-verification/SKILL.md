---
name: state-verification
description: "David's prompt references verifiable external state (email, drafts, calendar, drive, tracker sheets, application status, follow-ups, etc.) and you are about to respond — INVOKE THIS FIRST. Prefetches current Gmail / Drive / Calendar state in parallel and dumps a STATE PREFETCH block into context so your response is based on what is actually true RIGHT NOW, not on stale memory from prior turns. The hook-state-verify UserPromptSubmit hook surfaces a system-reminder pointing here when it detects state-relevant keywords. Use this skill whenever you see that reminder, OR whenever you are about to recommend an action (send email, follow up, update tracker) where the action may already be done — verify before recommending."
triggers: ["state verification", "state-verification", "verify state", "prefetch state", "state prefetch", "check email status", "check drafts", "check calendar", "verify before responding", "state check", "did david already", "is it already sent", "is it already done"]
---

# State Verification (pre-response prefetch)

## Why this exists

A recurring failure pattern: you recommend an action David has already done, ask "did you send X" when X is verifiable in Gmail Sent, or suggest a tracker batch paste that already landed. Each instance wastes a round-trip and burns David's trust that you are paying attention to current reality. The fix is mechanical, not aspirational: read current external state BEFORE composing a response that depends on it.

The `hook-state-verify` UserPromptSubmit hook injects a system-reminder when David's prompt contains state-relevant keywords. That reminder is your cue to run this skill. You can also invoke it on your own initiative anytime you are about to recommend an action where the action may already be done.

## When to invoke

ALWAYS invoke before responding when ANY of these are true:
- The hook injected the `[state-verification]` system-reminder for this turn
- You are about to ask "did you do X" where X is verifiable via Gmail / Drive / Calendar
- You are about to recommend sending an email, drafting a reply, or following up with someone
- David's prompt references a thread, draft, sheet, or event by name and you have not read it this session

SKIP when:
- The prompt is pure chitchat with no external-state implication ("hi", "thanks", "how are you")
- You already invoked the skill THIS TURN (don't double-fire — the prefetch is fresh)
- You are mid-tool-loop on a single coherent operation and already have current state in context

## How to invoke (fire in parallel)

Fire all four MCP queries IN A SINGLE TOOL-USE BATCH so they run concurrently. Sequential calls add 5–10 s of latency; parallel runs cap at ~2 s. The four queries:

1. **Gmail — recent sends past 24h**
   ```
   mcp__claude_ai_Gmail__search_threads with q: "in:sent newer_than:1d"
   ```

2. **Gmail — current drafts**
   ```
   mcp__claude_ai_Gmail__list_drafts
   ```

3. **Drive — tracker / sheet IDs in recent context**
   For each Google Sheets file ID David has referenced in the last few turns (tracker spreadsheets, application docs, etc.):
   ```
   mcp__claude_ai_Google_Drive__read_file_content with file_id: "<id>"
   ```
   If no sheet IDs are in context, skip this query — do not invent IDs.

4. **Calendar — next 7 days**
   ```
   mcp__claude_ai_Google_Calendar__list_events with time_min: now, time_max: now + 7 days
   ```

## What to emit

After the four queries return, write a STATE PREFETCH block at the start of your response (before any reasoning or recommendations). Format:

```
STATE PREFETCH HH:MM UTC
- Recent sends (past 24h): <list of subjects + recipients, or "none">
- Current drafts: <list of subjects + recipients, or "none">
- Sheets in context: <list of sheet names + row counts + last-modified timestamps, or "none referenced">
- Calendar next 7 days: <list of event titles + start times in David's timezone, or "none">
```

Then continue with your response, REFERENCING the prefetch results explicitly when relevant: "I see you already sent the Walsh follow-up at 09:14 — skipping that recommendation. The Mingolelli draft is still in Drafts; ready to send when you give the word."

## Hard rules

- **Do not ask "did you do X" when X is verifiable in the prefetch.** If the prefetch shows you sent it, say so. If the prefetch shows you didn't, recommend the action — don't ask.
- **Do not skip the prefetch because "I think I already know."** Memory drifts; prefetch is cheap.
- **Do not silently invoke without emitting the STATE PREFETCH block.** David needs to see what you saw — the visible block IS the value, not just the internal state.
- **Do not invent sheet IDs.** Only query Drive for sheet IDs David has explicitly referenced in recent context.
- **One snapshot per turn.** If you already prefetched this turn, reuse — don't re-query.

## Optional: audit log

After emitting the prefetch block, append a one-line entry to the local audit log so we can inspect what was visible to you on any given turn:

```bash
PREFETCH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "${CTX_ROOT}/state/${CTX_AGENT_NAME}"
echo "{\"ts\":\"$PREFETCH_TS\",\"sends_count\":<n>,\"drafts_count\":<n>,\"events_count\":<n>}" \
  >> "${CTX_ROOT}/state/${CTX_AGENT_NAME}/state-snapshot.jsonl"
```

This is cheap, fail-open (if the write fails the response still goes out), and lets a human or sentinel audit "what state did boss see when she answered the 14:30 ET question about my drafts?" Skip if writing to state-snapshot.jsonl errors — never let audit logging block the response.
