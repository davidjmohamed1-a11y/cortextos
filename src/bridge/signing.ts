/**
 * Bridge signing — HMAC-SHA256 over the canonical request payload.
 *
 * Status: V1 build per Group C M2 mitigation (David-approved 2026-06-29 via
 * boss-personal). Spec source:
 *   orgs/personal/agents/forge/specs/cowork-bridge-security-mitigations-2026-06-29.md
 *
 * Threat model: bridge pending/ is OneDrive-backed; anything that can write a
 * file there can in principle queue a bridge request. The HMAC signature
 * verifies the request actually came from cortextOS (which has the key)
 * before Cowork executes it.
 *
 * Key handoff (honest): Cowork runs as David on the same Mac as cortextOS, so
 * symmetric HMAC is appropriate — both sides read the same key file from
 * `<ctxRoot>/config/bridge-signing-key` (mode 0600). Asymmetric crypto would
 * only help if signer + verifier were on different machines.
 *
 * Key is SEPARATE from the agent-bus signing key (`<ctxRoot>/config/bus-signing-key`).
 * Compromise of one doesn't widen to the other.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { BridgeRequest } from './types.js';

/**
 * Canonical serialization for the payload that gets signed. Order MUST be
 * stable across versions or signatures break across deploys; never reorder or
 * remove fields here without a documented migration path.
 *
 * The canonical form joins fields with a single colon. JSON.stringify on the
 * context object gives us a deterministic ordering as long as both sender +
 * verifier use the same Node.js version (V8 sorts numeric keys lexically and
 * preserves insertion order for string keys — stable since Node 12).
 */
export function canonicalSignPayload(req: Pick<BridgeRequest, 'id' | 'from_agent' | 'request_type' | 'context' | 'result_destination'>): string {
  return [
    req.id,
    req.from_agent,
    req.request_type,
    JSON.stringify(req.context),
    req.result_destination.agent ?? '',
  ].join(':');
}

/**
 * Path to the bridge signing key. SEPARATE from the bus signing key so a
 * bridge-key compromise doesn't broaden to the agent bus.
 */
export function bridgeKeyPath(ctxRoot: string): string {
  return join(ctxRoot, 'config', 'bridge-signing-key');
}

/**
 * Load the bridge signing key from disk. Returns null when the key file
 * doesn't exist (caller decides whether to error or fall through).
 *
 * Never logs or echoes the key. Reads atomically (single readFileSync) so
 * we don't observe a half-written key during a rotation.
 */
export function loadBridgeKey(ctxRoot: string): string | null {
  const path = bridgeKeyPath(ctxRoot);
  if (!existsSync(path)) return null;
  try {
    const key = readFileSync(path, 'utf-8').trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Generate a fresh 32-byte (64 hex char) random key and write it atomically to
 * the bridge key path with mode 0600. Refuses to overwrite an existing key
 * unless `force` is true.
 *
 * Returns the key path on success. Throws on overwrite-without-force or fs
 * failure — callers want loud failure here, not silent.
 */
export function generateBridgeKey(ctxRoot: string, force = false): string {
  const path = bridgeKeyPath(ctxRoot);
  if (existsSync(path) && !force) {
    throw new Error(
      `Bridge signing key already exists at ${path}. Re-run with --force ONLY if you intend to rotate (will invalidate all in-flight bridge requests + require Cowork listener restart to pick up the new key).`,
    );
  }
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const key = randomBytes(32).toString('hex');
  writeFileSync(path, key + '\n', { encoding: 'utf-8', mode: 0o600 });
  // chmodSync as well to handle umask cases where writeFileSync mode is ignored
  try { chmodSync(path, 0o600); } catch { /* best-effort; mode arg already applied above */ }
  return path;
}

/**
 * Compute the HMAC-SHA256 signature for a request. Returns hex.
 */
export function signRequest(
  req: Pick<BridgeRequest, 'id' | 'from_agent' | 'request_type' | 'context' | 'result_destination'>,
  key: string,
): string {
  return createHmac('sha256', key).update(canonicalSignPayload(req)).digest('hex');
}

/**
 * Verify that a request's `sig` field matches an HMAC computed from the
 * canonical payload. Constant-time comparison via timingSafeEqual.
 *
 * Returns false when:
 *   - req.sig is missing
 *   - sig is malformed (wrong hex length, not parseable as hex)
 *   - sig doesn't match the recomputed HMAC
 *
 * Never throws — caller branches on the boolean.
 */
export function verifyRequest(req: BridgeRequest, key: string): boolean {
  if (!req.sig || typeof req.sig !== 'string') return false;
  let expected: Buffer;
  let provided: Buffer;
  try {
    expected = Buffer.from(signRequest(req, key), 'hex');
    provided = Buffer.from(req.sig, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}
