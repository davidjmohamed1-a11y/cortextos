/**
 * Bridge security — domain allowlist enforcement (M1 mitigation).
 *
 * Status: V1 build per Group C M1 (David-approved 2026-06-29 via boss-personal).
 * Spec source:
 *   orgs/personal/agents/forge/specs/cowork-bridge-security-mitigations-2026-06-29.md
 *
 * Threat model: bridge requests can specify any URL in context.url; without
 * a check, Cowork executes against arbitrary domains using David's logged-in
 * browser. The allowlist gates which domains are permitted, enforced at
 * queue-time (cortextOS rejects unauthorized) AND at Cowork-execute time
 * (Cowork's prompt re-checks). Defense in depth.
 *
 * Allowlist is the V1 David-approved set:
 *   notion.so, calendly.com, mail.google.com, calendar.google.com,
 *   drive.google.com, claude.ai
 *
 * Operators can extend via a JSON file at <ctxRoot>/config/bridge-allowlist.json:
 *   ["notion.so", "calendly.com", ..., "myextra.example.com"]
 * When the file exists, it REPLACES the V1 defaults (operator owns the full
 * list). When absent, the V1 defaults apply.
 *
 * Hostname matching: exact match OR subdomain match. notion.so matches both
 * `notion.so` itself AND `<workspace>.notion.so` (and any deeper subdomain).
 * Adversary that registers `evil-notion.so` does NOT match (different domain).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * V1 default allowlist — David-approved 2026-06-29.
 * Extend via <ctxRoot>/config/bridge-allowlist.json.
 */
export const V1_DEFAULT_DOMAIN_ALLOWLIST: ReadonlyArray<string> = [
  'notion.so',
  'calendly.com',
  'mail.google.com',
  'calendar.google.com',
  'drive.google.com',
  'claude.ai',
];

export function allowlistFilePath(ctxRoot: string): string {
  return join(ctxRoot, 'config', 'bridge-allowlist.json');
}

/**
 * Load the effective allowlist. Returns the file contents if
 * <ctxRoot>/config/bridge-allowlist.json exists + parses; otherwise returns
 * the V1 defaults. Never throws — falls back to defaults on any error.
 */
export function loadDomainAllowlist(ctxRoot: string): ReadonlyArray<string> {
  const path = allowlistFilePath(ctxRoot);
  if (!existsSync(path)) return V1_DEFAULT_DOMAIN_ALLOWLIST;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (Array.isArray(parsed) && parsed.every(d => typeof d === 'string')) {
      return parsed;
    }
    return V1_DEFAULT_DOMAIN_ALLOWLIST;
  } catch {
    return V1_DEFAULT_DOMAIN_ALLOWLIST;
  }
}

/**
 * Check if a URL's hostname is in the allowlist.
 *
 * Matching rules:
 * - Scheme MUST be http or https. Any other scheme (javascript:, data:, file:,
 *   etc.) → returns false. Closes a class of injection attacks.
 * - Userinfo in the URL (`https://attacker@notion.so/...`) is IGNORED for
 *   matching — the hostname after the @ is what counts. Prevents user-info
 *   spoofing.
 * - Hostname is matched against the allowlist with subdomain support:
 *   `notion.so` in allowlist matches `notion.so`, `www.notion.so`, `*.notion.so`.
 *   `notion.so` in allowlist does NOT match `evil-notion.so` (different domain).
 *
 * Returns false on any parse failure — fail closed.
 */
export function isAllowedDomain(url: string, allowlist: ReadonlyArray<string>): boolean {
  if (!url || typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return false;
  for (const allowed of allowlist) {
    const a = allowed.toLowerCase();
    if (hostname === a) return true;
    // Subdomain match: hostname ends with `.<allowed>`
    if (hostname.endsWith('.' + a)) return true;
  }
  return false;
}

/**
 * Convenience wrapper: load the allowlist + check the URL in one call.
 * Used at queue-time inside composeBridgeRequest.
 */
export function isUrlAllowed(url: string, ctxRoot: string): boolean {
  return isAllowedDomain(url, loadDomainAllowlist(ctxRoot));
}
