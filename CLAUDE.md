# Contributing to cortextOS

## Development Setup

```bash
git clone https://github.com/grandamenium/cortextos.git
cd cortextos
npm install
npm run build
npm test
```

## Before Submitting Changes

1. `npm run build` — TypeScript must compile cleanly
2. `npm test` — all tests must pass
3. Match existing patterns in `src/` for new features
4. Add unit tests in `tests/` for any new code

## Project Structure

- `src/` — TypeScript source (bus, cli, daemon, hooks, types, utils)
- `bus/` — Shell wrapper scripts (delegate to `dist/cli.js bus`)
- `dashboard/` — Next.js 14 web dashboard
- `templates/` — Agent templates (agent, orchestrator, analyst)
- `community/` — Community skills and agent catalog
- `tests/` — Unit, integration, and E2E tests

## Code Style

- TypeScript strict mode
- No external runtime dependencies beyond what's in `package.json`
- File operations use atomic writes (see `src/utils/atomic.ts`)
- All bus operations go through `src/bus/` modules

## Hard-rule enforcement hooks

Framework-level denylist that prevents agents from executing destructive or externally-visible actions even if their reasoning slips, hallucinates, or gets prompt-injected. Runs as a PreToolUse hook (`cortextos bus hook-hard-rule-gate`); blocks the action and returns a clear deny message that includes the override path.

**V1 MVP denylist** (`src/hooks/hard-rules.ts`):
- `git_push_main` — any `git push` to main or master (catches bare `git push` too)
- `rm_outside_workspace` — destructive `rm -r[f]` outside `CTX_AGENT_DIR` (conservative: glob/command-substitution that can't be statically resolved = block)
- `gmail_send_without_approval` — any `mcp__*Gmail*__send_*` tool call (kai is draft-only by policy; this is the framework backstop)
- `public_post` — LinkedIn/Twitter/Threads MCP post tools, Notion permissions set to public, bash curl POST to social-platform APIs

**Override flow** — when a rule fires, the operator grants a one-shot approval token:
```bash
cortextos bus approve-hard-rule <rule-name> --reason "explicit out-of-band confirmation from David"
```
Writes a token at `<ctxRoot>/approvals/granted/<rule-name>/<id>.json`. The next gated tool call consumes the token + allows. Tokens expire after 5 minutes if not consumed.

**Hook fails OPEN on internal error** — favors agent-progress over total-halt when the gate itself is broken. Errors logged to stderr + activity events.

**Per-agent registration** — `templates/{agent,analyst,orchestrator}/.claude/settings.json` already include the hook in `PreToolUse` (new agents auto-enrolled). Existing agents need a manual `.claude/settings.json` edit to opt in:
```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "cortextos bus hook-hard-rule-gate", "timeout": 10 }] }
    ]
  }
}
```

Spec source of truth: `orgs/personal/agents/forge/specs/hard-rule-enforcement-hooks-2026-06-29.md`.

## Liveness probe

The existing 50-min watchdog in `src/daemon/fast-checker.ts` writes `[watchdog] <agent> alive` to the heartbeat regardless of whether the PTY is responsive. This was the gap that hid Oracle's 14h OAuth-wall hang on 2026-06-19 — process alive ≠ progress.

The C5 liveness probe (`src/daemon/liveness-probe.ts`) pairs the watchdog's bookkeeping signal with a real progress signal: stdout-log mtime + heartbeat.json freshness + pid liveness check. Result is written to `<ctxRoot>/state/<agent>/liveness.json` (separate from `heartbeat.json` which agents own + rewrite wholesale).

**Levels**: `healthy`, `stale_stdout`, `stale_heartbeat`, `wedged`, `dead`, `unknown`. Thresholds: stdout >30 min stale + heartbeat >6h stale + pid alive = `wedged`.

**Operator CLI**:
```bash
cortextos bus probe-agent <name> [--format json|text]
```
Pure read-only — never writes to PTY, never sends prompts. Falls through gracefully when the daemon is down (pid_alive returns null).

**Probe runs automatically** every 50 min via the watchdog timer. Wedged/dead states are also logged to the daemon's stdout for immediate operator visibility.

Spec: `orgs/personal/agents/forge/specs/watchdog-liveness-probe-2026-06-29.md`.

## Comms archive

Durable structured archive of every agent message. Per-agent JSONL per month at:
```
<ctxRoot>/analytics/comms/<YYYY-MM>/<agent>.jsonl
```

Hot-paths wired in V1 (`src/bus/comms-archive.ts`):
- `src/bus/message.ts sendMessage` → channel='agent_bus', direction='outbound' (sender perspective)
- `src/bus/message.ts checkInbox` → channel='agent_bus', direction='inbound' (recipient perspective)
- `src/cli/bus.ts send-telegram` → channel='telegram', direction='outbound'

V1.5 deferred: inbound-telegram archive wire (formatTelegramTextMessage is a static method without agent context; deferred to a follow-up that threads context into the formatter or wraps it at the caller).

Schema versioned (`COMMS_ARCHIVE_SCHEMA_VERSION = 1`); future non-additive changes bump the version and add a migration. Append is best-effort: archive failure never blocks the send-path; recoverable from downstream sources.

**Operator CLI**:
```bash
cortextos bus comms-search [--agent X] [--channel telegram|agent_bus|bridge|cron|system] \
                            [--direction inbound|outbound] [--query <substring>] \
                            [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit N] \
                            [--format json|text]
```

Unlocks: "what did kai draft for Nick Coffee last week" (--agent kai --query "Nick Coffee"), "all outbound telegram in the past week" (--direction outbound --channel telegram --from <date>), "any conversation about the NOTION_API_KEY" (--query "NOTION_API_KEY"), per-agent activity volume baseline.

Boss's existing `archive-comms-daily` cron is superseded by the framework wire — boss can retire the cron at her convenience.

Spec: `orgs/personal/agents/forge/specs/comms-archive-2026-06-29.md`.

## Fetch ladder (legal, resilient web retrieval)

Five-rung ladder for fetching public web data, conservative-by-design. Stops at the first rung that returns data; stops + flags on a policy/legal failure. Per-domain `SitePolicy` cache means the fleet learns which rung works for which site instead of re-banging Cloudflare.

**Phase 1 rungs** (live; no David setup):
- **0 robots/ToS** — fetch + parse robots.txt; sets `do_not_attempt` if disallowed
- **1 official-api** — registry lookup at `src/fetch-ladder/official-api.ts` (Notion, GitHub, Wikipedia, etc.); surfaces `api_base` + `auth_env` for the caller
- **2 structured-data** — sitemap.xml, RSS/Atom feeds, JSON-LD, OpenGraph, schema.org microdata
- **3 search-api** — Brave (via `BRAVE_SEARCH_KEY`); inside agent contexts the built-in WebSearch is the primary path
- **4 archive** — Wayback Machine first, archive.today fallback (~20MB/day soft cap)

**Phase 2 rungs** (HOLD — gated on David's Chrome profile setup):
- **5 real-browser** — agent-browser headful + real Chrome profile (legitimate because it IS a real browser, not a spoof)
- **6 human-gate** — operator clears the challenge themselves via Telegram handshake

**Legal bright lines** — encoded as hard-rule hooks (`src/hooks/hard-rules.ts`):
- `auto_login_to_target` — overridable; default route to [HUMAN]
- `captcha_solver_endpoint` — **NON-OVERRIDABLE** (2Captcha, CapSolver, etc.)
- `anti_detect_browser_lib` — **NON-OVERRIDABLE** (undetected-chromedriver, playwright-stealth, curl-impersonate, etc.)
- `ip_rotation_to_evade` — **NON-OVERRIDABLE** (Bright Data, Smartproxy, Oxylabs, etc.)

**Operator CLI**:
```bash
cortextos bus fetch-url <url> [--force] [--format json|text]
cortextos bus site-policy list
cortextos bus site-policy show <domain-or-url>
cortextos bus site-policy forget <domain-or-url>
```

**Programmatic** (from any agent or module):
```typescript
import { fetchUrl } from 'cortextos/dist/fetch-ladder/index.js';
const r = await fetchUrl('https://notion.so/page', { ctxRoot });
// r.success, r.rung_succeeded, r.content, r.attempts (full history), r.policy_after
```

Site-policy cache lives fleet-wide at `<ctxRoot>/state/fetch-ladder/site-policy/<domain>.json` (TTL 168h). Promote-on-success / demote-on-fail. Operator `forget` to override after material site changes.

Design source: `orgs/personal/reference/fetch-ladder-design-2026-06-30.md` (legal grounding: Van Buren 2021, hiQ, Meta v Bright Data).
Spec: `orgs/personal/agents/forge/specs/fetch-ladder-2026-06-30.md`.

## Per-agent Claude Code config isolation

Each agent can have its own `CLAUDE_CONFIG_DIR` so its settings, sessions, projects history, and `customApiKeyResponses.approved` list are isolated from other agents on the same host. Controlled by `claude_config_dir` in the agent's `config.json`:

- `"isolated"` — use `<agentDir>/.claude-config/` (created on first spawn). Default for **new** agents created via `cortextos add-agent`.
- `"shared"` or absent — use `~/.claude/` (legacy shared with the user and every other non-isolated agent). Default for **existing** agents until the operator opts in.
- Any other string — literal path (escape hatch for custom layouts).

**What this isolates**: settings.json, projects/, sessions/, history.jsonl, shell-snapshots/, skills/, plugins/, and the `customApiKeyResponses.approved` list that gates the "use this API key?" prompt.

**What this does NOT isolate**: macOS Keychain OAuth credentials — the keychain entry is per-user, not per-config-dir. State isolation only. For true auth/billing isolation an agent also needs its own `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) in `.env`.

**Opt-in migration for existing agents:**
1. Edit `<agentDir>/config.json` → add `"claude_config_dir": "isolated"` near the other top-level fields.
2. Restart the agent: `cortextos restart <name>`.
3. First spawn creates `<agentDir>/.claude-config/` (mode 0700). If `ANTHROPIC_API_KEY` is also set in `.env`, the dir's `settings.json` is pre-populated with the API key's SHA-256 hash in `customApiKeyResponses.approved` so the interactive prompt is skipped. If no API key is in play, the dir stays empty and Claude Code falls back to keychain OAuth.
4. Sessions/history start fresh under the isolated dir. Pre-existing sessions/history under `~/.claude/` are NOT migrated.

The agent `.env` may set `CLAUDE_CONFIG_DIR` directly to override the config field entirely.
