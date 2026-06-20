/**
 * Bridge module — public surface
 *
 * Status: V1 LIVE (built 2026-06-19 after David greenlight). Channel:
 * OneDrive cowork-tasks/. Task-type allowlist: settings_audit + screenshot_report.
 * Cowork-side handler install: David runs once via Anthropic web UI per the
 * David-install doc.
 *
 * Spec source of truth:
 *   - orgs/personal/agents/forge/specs/cowork-bridge-feasibility-2026-06-19.md
 *   - orgs/personal/agents/atlas/memory/research-2026-06-19-agent-cowork-bridge.md
 */

export type {
  BridgeRequest,
  BridgeRequestType,
  BridgeResponseMetadata,
  BridgeResultDestination,
  BridgeStatus,
  BridgePaths,
  BridgeConfig,
} from './types.js';

export { V1_ALLOWED_REQUEST_TYPES } from './types.js';

export { DEFAULT_BRIDGE_ROOT, resolveBridgePaths } from './paths.js';

export {
  writeBridgeRequest,
  composeBridgeRequest,
  type WriteBridgeRequestArgs,
} from './outbound.js';

export {
  getBridgeStatus,
  listBridgeRequests,
  type BridgeRequestSummary,
} from './status.js';

export { sweepBridge, type JanitorSweepResult } from './janitor.js';

export { relayTick, type RelayTickResult } from './relay.js';
