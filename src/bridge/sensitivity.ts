/**
 * Bridge sensitivity classifier — M3 mitigation.
 *
 * Status: V1 build per Group C M3 (David-approved 2026-06-29 via boss-personal).
 * Spec source:
 *   orgs/personal/agents/forge/specs/cowork-bridge-security-mitigations-2026-06-29.md
 *
 * Threat model: even after M1+M2 (URL allowlisted + request signed), the
 * RESPONSE from Cowork could carry sensitive data (Gmail content, calendar
 * details, anything from sensitive domains). M3 gates the cortextOS-side
 * relay: sensitive responses don't auto-flow to the requesting agent; they
 * pause for David's explicit approval first.
 *
 * Tiering (V1 default):
 *   - Tier B (gate-required): response status='failed' OR original request's
 *     context.url hostname is in the sensitive-domain list.
 *   - Tier A (auto-relay): everything else (status='success' OR 'partial' from
 *     non-sensitive domains).
 *
 * V1 sensitive domains (David-approved):
 *   - mail.google.com
 *   - calendar.google.com
 *
 * Operator override file at <ctxRoot>/config/bridge-sensitive-domains.json
 * (one-line array of additional hostname strings); when present, REPLACES the
 * V1 defaults (operator owns the full list).
 *
 * Always-gate-on-failure: even if a response is from a non-sensitive domain,
 * any status != 'success' or 'partial' (i.e. 'failed') pauses for approval.
 * Rationale: failures need a David eyeball before agents react.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BridgeRequest, BridgeResponseMetadata } from './types.js';

export const V1_DEFAULT_SENSITIVE_DOMAINS: ReadonlyArray<string> = [
  'mail.google.com',
  'calendar.google.com',
];

export function sensitiveDomainsFilePath(ctxRoot: string): string {
  return join(ctxRoot, 'config', 'bridge-sensitive-domains.json');
}

export function loadSensitiveDomains(ctxRoot: string): ReadonlyArray<string> {
  const path = sensitiveDomainsFilePath(ctxRoot);
  if (!existsSync(path)) return V1_DEFAULT_SENSITIVE_DOMAINS;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (Array.isArray(parsed) && parsed.every(d => typeof d === 'string')) {
      return parsed;
    }
    return V1_DEFAULT_SENSITIVE_DOMAINS;
  } catch {
    return V1_DEFAULT_SENSITIVE_DOMAINS;
  }
}

/**
 * Pure predicate over the parsed completed-file content. Returns
 * {sensitive: true, reason: '...'} when the relay should gate;
 * {sensitive: false, reason: '...'} when it can auto-relay.
 *
 * The `reason` is human-readable + intended for the Telegram alert text +
 * for the pending-approval sidecar file's audit record.
 */
export function isSensitiveResponse(
  request: BridgeRequest,
  response: BridgeResponseMetadata,
  sensitiveDomains: ReadonlyArray<string>,
): { sensitive: boolean; reason: string } {
  // Always-gate-on-failure (any non-success/non-partial)
  if (response.status === 'failed') {
    return {
      sensitive: true,
      reason: `response status='failed' (David should see failures before agents react${response.error ? ': ' + response.error : ''})`,
    };
  }

  // Domain-based sensitivity (only when context has a URL)
  const ctxUrl = typeof request.context?.url === 'string' ? (request.context.url as string) : undefined;
  if (ctxUrl) {
    let host = '';
    try {
      host = new URL(ctxUrl).hostname.toLowerCase();
    } catch {
      // Unparseable URL — already would have been blocked by M1 at queue-time;
      // if we see it here, something's odd, treat as sensitive for safety
      return {
        sensitive: true,
        reason: `context.url unparseable (suspicious post-M1) — gating defensively`,
      };
    }
    for (const sensitive of sensitiveDomains) {
      const s = sensitive.toLowerCase();
      if (host === s || host.endsWith('.' + s)) {
        return {
          sensitive: true,
          reason: `response from sensitive domain '${host}' (matches '${sensitive}' in V1 sensitive list)`,
        };
      }
    }
  }

  return {
    sensitive: false,
    reason: 'success/partial response from non-sensitive domain — auto-relay',
  };
}

/**
 * Pending-approval sidecar file path. Sidecar lives in the same completed/
 * dir as the response file so the relay sees it on its next scan + skips
 * the request until approval lands.
 */
export function pendingApprovalSidecarPath(completedDir: string, requestId: string): string {
  return join(completedDir, `${requestId}.pending-approval.json`);
}

/**
 * Approval-token path. Operator runs `cortextos bus bridge-approve-relay <id>`
 * to write this file; relay's next tick consumes + proceeds.
 */
export function approvalTokenPath(ctxRoot: string, requestId: string): string {
  return join(ctxRoot, 'approvals', 'bridge-relay', `${requestId}.json`);
}

/**
 * Reject marker — operator runs `cortextos bus bridge-reject-relay <id>`.
 * Relay sees it + moves the response to rejected/.
 */
export function rejectMarkerPath(ctxRoot: string, requestId: string): string {
  return join(ctxRoot, 'approvals', 'bridge-relay-rejected', `${requestId}.json`);
}

export interface ApprovalDecision {
  status: 'approved' | 'rejected' | 'pending';
  /** Present when status='rejected' or 'approved'. */
  reason?: string;
  /** Present when status='approved' — token file path for consumption. */
  tokenPath?: string;
}

export function checkApprovalDecision(ctxRoot: string, requestId: string): ApprovalDecision {
  const approvedPath = approvalTokenPath(ctxRoot, requestId);
  if (existsSync(approvedPath)) {
    let reason = 'approved';
    try {
      const data = JSON.parse(readFileSync(approvedPath, 'utf-8'));
      reason = data.reason || 'approved';
    } catch { /* ignore */ }
    return { status: 'approved', reason, tokenPath: approvedPath };
  }
  const rejectedPath = rejectMarkerPath(ctxRoot, requestId);
  if (existsSync(rejectedPath)) {
    let reason = 'rejected';
    try {
      const data = JSON.parse(readFileSync(rejectedPath, 'utf-8'));
      reason = data.reason || 'rejected';
    } catch { /* ignore */ }
    return { status: 'rejected', reason };
  }
  return { status: 'pending' };
}
