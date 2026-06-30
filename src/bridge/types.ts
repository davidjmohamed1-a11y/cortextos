/**
 * Agent ↔ Cowork Bridge — Type Contracts
 *
 * Status: SCAFFOLD ONLY (drafted 2026-06-19 per boss-personal dispatch). No
 * runtime behavior wired yet — types + signatures only. Live behavior gated
 * on David's go-ahead after he reviews this scaffold + atlas's protocol spec
 * + answers her 3 open Qs (poll interval, task scope, failure routing).
 *
 * Bridge channel: OneDrive at ~/Library/CloudStorage/OneDrive-Personal/
 * cowork-tasks/. Chosen by atlas's protocol spec because David's existing
 * finance-sync-mid-month Cowork session already writes to OneDrive daily —
 * empirical proof of sandbox-write permission, eliminating forge's earlier
 * 10-min sandbox-test gate (the test was about ~/.cortextos/ writes; we never
 * actually need that path).
 *
 * Spec sources of truth:
 *   - orgs/personal/agents/forge/specs/cowork-bridge-feasibility-2026-06-19.md
 *   - orgs/personal/agents/atlas/memory/research-2026-06-19-agent-cowork-bridge.md
 *
 * Design contract — what these types lock in for the eventual build:
 * - Bridge REQUESTS live in OneDrive cowork-tasks/pending/ → in-progress/.
 *   Cross a trust boundary (cortextOS ↔ external Cowork session) and are
 *   therefore KEPT SEPARATE from the agent inbox schema.
 * - Bridge RESPONSES are written by Cowork to OneDrive cowork-tasks/completed/
 *   (authoritative store, audit trail). A cortextOS-side RELAY WATCHER (atlas's
 *   responsibility per forge's reconciliation surface) tails completed/ and
 *   fans out a lightweight notification to the requesting agent's standard
 *   inbox dir — so the agent receives a normal InboxMessage with
 *   BridgeResponseMetadata in its text body. The full result body stays in
 *   OneDrive; the inbox notification carries enough to act on (request_id,
 *   status, path to result file).
 * - Why this reconciliation: keeps Cowork's mental model simple (only knows
 *   OneDrive), keeps cortextOS in charge of agent-routing (where it should be),
 *   and makes HMAC signing happen at the relay point (atlas signs the inbox
 *   notification, never has to ask Cowork to sign).
 */

/**
 * Categories of work an agent can hand off to a Cowork session.
 *
 * V1 ALLOWLIST (David-approved 2026-06-19 via boss-personal): only
 * `settings_audit` and `screenshot_report` are permitted. Both are READ-ONLY
 * browser tasks — zero auth-mutation risk — which is the safe starting set
 * for proving end-to-end bridge mechanics before widening scope.
 *
 * Future types deferred (NOT in V1):
 *   - browser_task (broader navigation/interaction)
 *   - gui_action (desktop app driving)
 *   - cowork_research (multi-MCP synthesis)
 *   - file_download / file_upload
 *   - mcp_oauth_browser_action (OAuth-gated connector flows)
 *
 * Widen the allowlist by (a) adding the type here AND (b) updating
 * V1_ALLOWED_REQUEST_TYPES below AND (c) atlas's protocol spec adding the
 * Cowork-side handler.
 */
export type BridgeRequestType =
  /**
   * Browse to a service's settings page (or admin panel) and extract the
   * current configuration values. Read-only.
   * context: { url: string, fields_to_extract?: string[] }
   */
  | 'settings_audit'
  /**
   * Browse to a URL and capture a screenshot, optionally with annotation.
   * Read-only.
   * context: { url: string, viewport?: {width,height}, wait_for_selector?: string }
   */
  | 'screenshot_report';

/**
 * V1 allowlist enforcement. `writeBridgeRequest` rejects requests whose type
 * is not in this set with a clear error.
 */
export const V1_ALLOWED_REQUEST_TYPES: ReadonlyArray<BridgeRequestType> = [
  'settings_audit',
  'screenshot_report',
];

/**
 * Where Cowork should deliver the response when work is done.
 *
 * V1 supports only `agent_inbox` (write a normal-looking message into
 * ~/.cortextos/default/inbox/<agent>/). Future destinations could include
 * `notion_db_row` (fallback for sandbox-blocked file writes) or `webhook_url`.
 */
export interface BridgeResultDestination {
  type: 'agent_inbox' | 'notion_db_row';
  /** For type='agent_inbox': the agent whose inbox receives the response. */
  agent?: string;
  /** Optional ISO-8601 deadline. Janitor uses this for stale-request detection. */
  expected_by?: string;
}

/**
 * A bridge REQUEST — written by cortextOS into bridge/outbound/<id>.json.
 * Cowork's scheduled session reads outbound/, processes, writes a response,
 * and moves the request to bridge/processed/.
 */
export interface BridgeRequest {
  /** Unique id. Convention: `bridge-<unix-ms>-<requesting-agent>-<rand5>`. */
  id: string;

  /** The cortextOS agent that originated the request. */
  from_agent: string;

  /** ISO-8601 timestamp when cortextOS wrote the request. */
  created_at: string;

  /** Categorical type — used by Cowork to dispatch to the right handler. */
  request_type: BridgeRequestType;

  /**
   * Plain-English description of the work. Cowork's LLM reads this to
   * understand intent; the structured `context` payload provides parameters.
   */
  description: string;

  /**
   * Free-form structured payload Cowork needs to execute the work.
   * Schema is request_type-specific — atlas's protocol spec defines per-type
   * shapes. Examples (per type):
   *   - browser_task: { url, action: 'navigate' | 'extract_text' | 'screenshot', selector? }
   *   - file_download: { url, destination_path, auth_required? }
   *   - mcp_oauth_browser_action: { connector_name, oauth_flow_id, params }
   */
  context: Record<string, unknown>;

  /** Where Cowork should deliver the response when done. */
  result_destination: BridgeResultDestination;

  /**
   * Optional HMAC signature over the rest of the payload. V1 design supports
   * three modes (see feasibility spec section Q2):
   *   A. Skip signature (unsigned)
   *   B. Cowork shares the bridge HMAC key (preferred for V1)
   *   C. Bridge-specific separate key (V2 hardening path)
   */
  sig?: string;
}

/**
 * Status of a bridge request as cortextOS sees it. Computed by inspecting
 * which dir the request file currently lives in:
 *   bridge/outbound/<id>.json  → queued
 *   bridge/processing/<id>.json → in_progress (Cowork has claimed it)
 *   bridge/processed/<id>.json → completed (Cowork moved here after response)
 *   bridge/failed/<id>.json    → failed (Cowork moved here after error)
 *   (not found in any dir + janitor's stale-log entry) → timeout
 */
export type BridgeStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'unknown';

/**
 * Metadata Cowork SHOULD embed in the response message text (as a parseable
 * block) so the requesting agent can correlate response → original request
 * and check execution outcome before acting on the body.
 *
 * Suggested wire format inside the InboxMessage.text body:
 *   ```bridge-meta
 *   {"request_id": "...", "status": "success", ...}
 *   ```
 * followed by the human-readable response payload. Agents parse the block
 * if present; absent block = treat as a normal inbox message.
 */
export interface BridgeResponseMetadata {
  request_id: string;
  cowork_session_id: string;
  status: 'success' | 'partial' | 'failed';
  /** Required when status != 'success'. Human-readable failure reason. */
  error?: string;
  /** If status='failed', whether retrying makes sense (transient vs. permanent). */
  retryable?: boolean;
  /** ISO-8601 timestamp when Cowork finished the work. */
  completed_at: string;
}

/**
 * Resolved paths for the bridge module. Computed at runtime — default points
 * to OneDrive cowork-tasks/ per atlas's spec; rootOverride supported for tests.
 *
 * V2 (Phase A two-way build, 2026-06-30): added `relayed/` (post-delivery
 * archive, FS-authoritative dedup) + `from_claude_*` (inbound channel:
 * Claude initiates messages to the fleet).
 */
export interface BridgePaths {
  /** Root for all bridge state. Default: ~/Library/CloudStorage/OneDrive-Personal/cowork-tasks/ */
  root: string;
  /** Requests cortextOS has queued, not yet picked up by Cowork. (cowork-tasks/pending/) */
  outbound: string;
  /** Requests Cowork has claimed and is currently processing. (cowork-tasks/in-progress/) */
  processing: string;
  /** Requests Cowork has finished successfully. (cowork-tasks/completed/) */
  processed: string;
  /** Requests Cowork attempted but failed. (cowork-tasks/failed/) */
  failed: string;
  /**
   * Archive for outbound responses that have been successfully delivered to
   * the requesting agent's inbox. Move-on-relay: relay atomically renames
   * completed/<id>.json → relayed/<id>.json after sendMessage succeeds. The
   * FS layout IS the dedup primitive (state file is a cache). Sole writer:
   * the outbound relay. (cowork-tasks/relayed/)
   */
  relayed: string;
  /**
   * Inbound channel root — Claude writes initiation messages here. Sole
   * writer: Claude (via OneDrive sync from the desktop side). Sole reader:
   * the inbound-relay. (cowork-tasks/from-claude/)
   */
  from_claude_root: string;
  /** Inbound messages awaiting tier-classification. (from-claude/pending/) */
  from_claude_pending: string;
  /** Sensitive inbound messages held for David approval. Sole writer: inbound-relay. (from-claude/pending-approval/) */
  from_claude_pending_approval: string;
  /** Inbound messages successfully delivered to the target agent's inbox. Sole writer: inbound-relay. (from-claude/processed/) */
  from_claude_processed: string;
  /** Inbound messages rejected by hard-rules or David. Sole writer: inbound-relay. (from-claude/blocked/) */
  from_claude_blocked: string;
}

// ---------------------------------------------------------------------------
// Inbound channel — Phase A (2026-06-30)
// ---------------------------------------------------------------------------

/**
 * Categorical kinds of inbound message Claude can send to the fleet.
 *
 * Hard-rule matching ONLY runs on `kind === 'request'` (action-shaped
 * messages). The other kinds (message / challenge / fact) are content;
 * gating them defeats the purpose of having an independent red-team partner.
 * M3 sensitivity classification runs on ALL kinds.
 */
export type InboundMessageKind =
  /** Free-form text the target agent should read + respond to. */
  | 'message'
  /** Claude dissents from a fleet conclusion. Routes to target with high priority. */
  | 'challenge'
  /** A fact / observation Claude is contributing to fleet memory. */
  | 'fact'
  /** An action request (DO something). Routed through hard-rules + tier gate. */
  | 'request';

/**
 * A single InboundMessage — what Claude writes into from-claude/pending/.
 * Schema versioned via `schema_version` so future additive changes don't
 * break the inbound-relay parser.
 */
export interface InboundMessage {
  /** Schema version. Current = 1. */
  schema_version: 1;
  /** Unique id. Convention: `inbound-<unix-ms>-claude-<rand5>`. */
  id: string;
  /** Always 'claude' for Phase A. (Future: other external partners.) */
  from: 'claude';
  /** Target fleet agent (boss-personal, atlas, donna, kai, forge, etc.). */
  to_agent: string;
  /** Categorical kind — see InboundMessageKind. */
  kind: InboundMessageKind;
  /** Message priority. Maps directly to the bus Priority type. */
  priority: 'urgent' | 'high' | 'normal' | 'low';
  /** Human-readable body. The target agent sees this in their inbox. */
  text: string;
  /**
   * Optional structured context (when kind === 'request' or 'challenge').
   * Schema is kind-specific. For request: { url?, action?, params? }.
   * For challenge: { fleet_conclusion?, evidence_url?, counter_argument? }.
   */
  context?: Record<string, unknown>;
  /**
   * Claude's self-declared sensitivity hint. Conservative default in the
   * classifier: if absent OR true → treat as sensitive (better one extra
   * David-approval prompt than one missed escalation).
   */
  sensitive_hint?: boolean;
  /** ISO-8601 timestamp when Claude wrote the message. */
  created_at: string;
  /**
   * HMAC signature over the canonical payload. Verified by the inbound-relay
   * using the shared bridge key (loaded via loadBridgeKey). Verification
   * failure → moved to from-claude/blocked/ with reason. NO retry.
   */
  sig: string;
}

/**
 * V1 allowlist of inbound message kinds. All four are V1-supported. (The
 * narrower control surface is hard-rules + tier-gating, not kind allowlist.)
 */
export const V1_INBOUND_KINDS: ReadonlyArray<InboundMessageKind> = [
  'message',
  'challenge',
  'fact',
  'request',
];

/**
 * Optional config for the bridge module. Read from agent config or env.
 * V1 keeps this minimal; expand as needed.
 */
export interface BridgeConfig {
  /** Defaults to <ctxRoot>/bridge */
  rootPath?: string;
  /** ISO-8601 duration string for stale-request timeout. Default: 24h. */
  staleAfter?: string;
  /** Defaults to file at ~/.cortextos/default/.bridge-signing-key */
  signingKeyPath?: string;
  /** If true, sign outbound requests; false skips (Option A in feasibility spec). */
  signOutbound?: boolean;
}
