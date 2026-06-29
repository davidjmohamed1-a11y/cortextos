/**
 * Bridge — Outbound (cortextOS → Cowork)
 *
 * Composes a BridgeRequest, validates against the V1 allowlist, signs it
 * (M2 mitigation: HMAC over canonical payload), atomically writes the JSON
 * to the pending/ dir, returns the request id.
 *
 * The pending/ file is what Cowork's scheduled session reads on its next
 * cycle. Cowork verifies the signature BEFORE executing (per the M2 mitigation
 * pattern documented in the David-install doc); fails-the-verify go to failed/.
 * Cowork moves verified requests through in-progress/ → completed/ or failed/.
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
import { loadBridgeKey, signRequest, bridgeKeyPath } from './signing.js';
import { isUrlAllowed, loadDomainAllowlist } from './security.js';

export interface WriteBridgeRequestArgs {
  fromAgent: string;
  requestType: BridgeRequestType;
  description: string;
  context: Record<string, unknown>;
  resultDestination: BridgeResultDestination;
}

/**
 * Build a BridgeRequest without writing it. Pure function — no fs.
 *
 * `signingKey` is optional: if provided, the returned request includes a
 * `sig` field (HMAC over the canonical payload). If omitted, no sig is set
 * (tests can call compose without a key). PRODUCTION callers (writeBridgeRequest,
 * CLI) load the key and pass it through.
 *
 * Throws on:
 * - invalid fromAgent (must match /^[a-z0-9_-]+$/)
 * - request_type not in V1_ALLOWED_REQUEST_TYPES
 * - missing description / context / resultDestination
 * - resultDestination.type other than 'agent_inbox' (V1 only supports inbox)
 * - resultDestination.agent missing when type='agent_inbox'
 */
export function composeBridgeRequest(args: WriteBridgeRequestArgs, signingKey?: string): BridgeRequest {
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
  const req: BridgeRequest = {
    id,
    from_agent: args.fromAgent,
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    request_type: args.requestType,
    description: args.description,
    context: args.context,
    result_destination: args.resultDestination,
  };

  if (signingKey) {
    req.sig = signRequest(req, signingKey);
  }

  return req;
}

/**
 * Queue a bridge request: load signing key from ctxRoot, compose + sign,
 * atomic write to pending/. Returns the new request id.
 *
 * Throws when the bridge signing key file is missing — M2 hard requirement.
 * Operator runs `cortextos bus generate-bridge-key` once at install time.
 */
export function writeBridgeRequest(paths: BridgePaths, args: WriteBridgeRequestArgs, ctxRoot: string): string {
  // M1: domain allowlist enforcement at queue-time. If context.url is set,
  // it must resolve to an allowlisted hostname before we even sign + queue.
  // The Cowork listener re-checks at execute time as defense-in-depth.
  const ctxUrl = typeof args.context?.url === 'string' ? (args.context.url as string) : undefined;
  if (ctxUrl) {
    if (!isUrlAllowed(ctxUrl, ctxRoot)) {
      const allowlist = loadDomainAllowlist(ctxRoot);
      throw new Error(
        `Bridge URL '${ctxUrl}' not in allowlist (M1 mitigation). ` +
        `Allowed domains: ${allowlist.join(', ')}. ` +
        `Operator can extend the allowlist via cortextos bus bridge-allowlist add <domain>; ` +
        `David-set list at ${ctxRoot}/config/bridge-allowlist.json.`,
      );
    }
  }

  // M2: load signing key + sign. Throws if key missing.
  const key = loadBridgeKey(ctxRoot);
  if (!key) {
    throw new Error(
      `Bridge signing key not provisioned at ${bridgeKeyPath(ctxRoot)}. ` +
      `Run \`cortextos bus generate-bridge-key\` once at install time (the operator runs this on the Mini; David never sees a terminal). ` +
      `Bridge requests cannot be queued without a key — M2 security mitigation.`,
    );
  }
  const request = composeBridgeRequest(args, key);
  ensureDir(paths.outbound);
  const filename = `${request.id}.json`;
  atomicWriteSync(join(paths.outbound, filename), JSON.stringify(request, null, 2));
  return request.id;
}
