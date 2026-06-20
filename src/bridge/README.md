# Bridge — Agent ↔ Cowork

**Status:** SCAFFOLD (2026-06-19). Types + skeleton landed. Live behavior gated on:

1. **David's empirical sandbox test** — does Cowork allow writes to `~/.cortextos/` paths?
2. **Atlas's protocol spec** — request-type taxonomy + Cowork-side handler prompt

Until both gates clear, every function in `outbound.ts`, `status.ts`, and `janitor.ts` throws or returns no-op default. Types in `types.ts` and path helpers in `paths.ts` are stable and safe to import.

## Why this module exists

Headless cortextOS agents (boss-personal, atlas, kai, etc.) cannot perform browser-based actions, GUI work, or MCP flows that require browser-based OAuth consent. Today those become `[HUMAN]` tasks for David. The bridge hands them off to Cowork sessions instead — Cowork has the GUI, the OAuth, and the browser. cortextOS queues the work; Cowork picks it up on its next scheduled run and writes the result back into the requesting agent's inbox.

Full design rationale + the 4 boss questions answered: see `orgs/personal/agents/forge/specs/cowork-bridge-feasibility-2026-06-19.md`.

## Dir layout (created on first use post-build)

```
<ctxRoot>/bridge/
├── outbound/    cortextOS writes BridgeRequest JSON here
├── processing/  Cowork moves claimed requests here mid-execution
├── processed/   Cowork moves completed requests here
├── failed/      Janitor or Cowork moves errored/stale requests here
└── test/        David's one-time sandbox-write probe
```

## Public API (post-build)

```typescript
import { writeBridgeRequest, getBridgeStatus, resolveBridgePaths } from './bridge';

const paths = resolveBridgePaths(ctxRoot);
const id = writeBridgeRequest(paths, {
  fromAgent: 'boss-personal',
  requestType: 'browser_task',
  description: 'Browse to LinkedIn URL X, extract page title',
  context: { url: 'https://linkedin.com/in/...', action: 'extract_title' },
  resultDestination: { type: 'agent_inbox', agent: 'boss-personal' },
});

// Later — usually via the dashboard or a cron poll:
const status = getBridgeStatus(paths, id);  // 'queued' | 'in_progress' | 'completed' | ...
```

## Why bridge messages are kept SEPARATE from the agent inbox

Bridge requests cross a trust boundary (cortextOS → external Cowork session). Agent-inbox messages do not. Mixing them would:
- Confuse the HMAC signing model (Cowork-originated messages need a different signing path than agent-originated)
- Make security audits harder (bridge messages have a different threat model)
- Break the separation of concerns (bridge has its own state machine, its own janitor, its own dir lifecycle)

Bridge RESPONSES, however, are written by Cowork directly into the requesting agent's standard inbox dir as a normal-looking `InboxMessage` with bridge metadata in the text body. This means cortextOS-side consumption needs no new code beyond standard inbox handling — atlas's protocol spec defines the exact wire format for the metadata block inside the message text.

## What's NOT in this module (intentionally)

- CLI commands (`cortextos bus bridge-request`, `bridge-status`) — added in `src/cli/bridge.ts` post-build
- Notion DB fallback channel — added in `src/bridge/notion-channel.ts` IF David's sandbox test fails and we need the slower Notion path
- HMAC signing — added in `src/bridge/signing.ts` when Option B (shared key) or Option C (bridge-specific key) is decided

## Build phase plan (when gates clear)

1. Implement `composeBridgeRequest` + `writeBridgeRequest` with atomic write + signing (option B by default)
2. Implement `getBridgeStatus` + `listBridgeRequests`
3. Implement `sweepBridge` janitor + a cron entry on atlas (`bridge-janitor` every 4h)
4. Add CLI commands `bridge-request` + `bridge-status` + `bridge-list`
5. Unit tests for: schema validation, status state machine, janitor sweep
6. Integration test: write a request, simulate Cowork response (drop file in agent inbox), verify end-to-end delivery <5s
7. Smoke test with real Cowork session (David's bridge-listener Cowork)

Estimated 2-4h after greenlight.
