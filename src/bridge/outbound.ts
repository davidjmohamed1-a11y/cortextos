/**
 * Bridge — Outbound (cortextOS → Cowork)
 *
 * Composes a BridgeRequest, validates against the V1 allowlist, atomically
 * writes the JSON to the pending/ dir, returns the request id.
 *
 * The pending/ file is what Cowork's scheduled session reads on its next
 * cycle. Cowork moves the file through in-progress/ → completed/ or failed/
 * depending on outcome.
 */

import { join } from 'path';
import { randomBytes } from 'crypto';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { validateAgentName } from '../utils/validate.js';
import {
  V1_ALLOWED_REQUEST_TYPES,
  type BridgePaths,
  type BridgeRequest,
  type BridgeRequestType,
  type BridgeResultDestination,
} from './types.js';

export interface WriteBridgeRequestArgs {
  fromAgent: string;
  requestType: BridgeRequestType;
  description: string;
  context: Record<string, unknown>;
  resultDestination: BridgeResultDestination;
}

/**
 * Build a BridgeRequest without writing it. Pure function — useful for tests
 * and the upcoming `bridge-request --dry-run` CLI mode.
 *
 * Throws on:
 * - invalid fromAgent (must match /^[a-z0-9_-]+$/)
 * - request_type not in V1_ALLOWED_REQUEST_TYPES
 * - missing description / context / resultDestination
 * - resultDestination.type other than 'agent_inbox' (V1 only supports inbox)
 * - resultDestination.agent missing when type='agent_inbox'
 */
export function composeBridgeRequest(args: WriteBridgeRequestArgs): BridgeRequest {
  validateAgentName(args.fromAgent);

  if (!V1_ALLOWED_REQUEST_TYPES.includes(args.requestType)) {
    throw new Error(
      `Bridge request_type '${args.requestType}' not in V1 allowlist. ` +
      `Allowed types: ${V1_ALLOWED_REQUEST_TYPES.join(', ')}. ` +
      `Widen the allowlist in src/bridge/types.ts AND update atlas's protocol spec to add a Cowork-side handler.`,
    );
  }

  if (!args.description || args.description.trim().length === 0) {
    throw new Error('Bridge request description is required (1+ chars, non-whitespace).');
  }
  if (!args.context || typeof args.context !== 'object') {
    throw new Error('Bridge request context is required (object, may be empty {}).');
  }
  if (!args.resultDestination) {
    throw new Error('Bridge request resultDestination is required.');
  }
  if (args.resultDestination.type !== 'agent_inbox') {
    throw new Error(
      `Bridge resultDestination.type '${args.resultDestination.type}' not supported in V1. ` +
      `Only 'agent_inbox' is supported; Notion-DB fallback deferred to V2.`,
    );
  }
  if (!args.resultDestination.agent) {
    throw new Error('Bridge resultDestination.agent is required when type=agent_inbox.');
  }
  validateAgentName(args.resultDestination.agent);

  const id = `bridge-${Date.now()}-${args.fromAgent}-${randomBytes(3).toString('hex')}`;
  return {
    id,
    from_agent: args.fromAgent,
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    request_type: args.requestType,
    description: args.description,
    context: args.context,
    result_destination: args.resultDestination,
    // sig field reserved — V1 ships unsigned (Cowork has no signing key);
    // the cortextOS-side relay watcher signs the inbox notification it
    // constructs from the response, so the trust boundary is at the relay
    // point not at the OneDrive payload.
  };
}

/**
 * Queue a bridge request: compose + atomic write to pending/.
 * Returns the new request id; caller uses it with getBridgeStatus to poll.
 */
export function writeBridgeRequest(paths: BridgePaths, args: WriteBridgeRequestArgs): string {
  const request = composeBridgeRequest(args);
  ensureDir(paths.outbound);
  const filename = `${request.id}.json`;
  atomicWriteSync(join(paths.outbound, filename), JSON.stringify(request, null, 2));
  return request.id;
}
