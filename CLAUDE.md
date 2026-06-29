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
