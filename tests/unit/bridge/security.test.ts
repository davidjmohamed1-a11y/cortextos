import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  V1_DEFAULT_DOMAIN_ALLOWLIST,
  allowlistFilePath,
  loadDomainAllowlist,
  isAllowedDomain,
  isUrlAllowed,
} from '../../../src/bridge/security.js';

describe('security — V1 default allowlist', () => {
  it('contains the 6 David-approved domains', () => {
    expect(V1_DEFAULT_DOMAIN_ALLOWLIST).toEqual([
      'notion.so',
      'calendly.com',
      'mail.google.com',
      'calendar.google.com',
      'drive.google.com',
      'claude.ai',
    ]);
  });
});

describe('security — loadDomainAllowlist', () => {
  it('returns V1 defaults when no override file exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'allowlist-'));
    try {
      expect(loadDomainAllowlist(tmp)).toEqual(V1_DEFAULT_DOMAIN_ALLOWLIST);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns override-file contents when file exists + parses', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'allowlist-'));
    try {
      mkdirSync(join(tmp, 'config'));
      writeFileSync(allowlistFilePath(tmp), JSON.stringify(['notion.so', 'extra.example.com']));
      expect(loadDomainAllowlist(tmp)).toEqual(['notion.so', 'extra.example.com']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to defaults on malformed JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'allowlist-'));
    try {
      mkdirSync(join(tmp, 'config'));
      writeFileSync(allowlistFilePath(tmp), '{not valid json');
      expect(loadDomainAllowlist(tmp)).toEqual(V1_DEFAULT_DOMAIN_ALLOWLIST);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to defaults when override is not an array', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'allowlist-'));
    try {
      mkdirSync(join(tmp, 'config'));
      writeFileSync(allowlistFilePath(tmp), JSON.stringify({ not: 'an array' }));
      expect(loadDomainAllowlist(tmp)).toEqual(V1_DEFAULT_DOMAIN_ALLOWLIST);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('security — isAllowedDomain', () => {
  const list = ['notion.so', 'mail.google.com', 'claude.ai'];

  it('matches exact hostname', () => {
    expect(isAllowedDomain('https://notion.so/settings', list)).toBe(true);
    expect(isAllowedDomain('https://mail.google.com/inbox', list)).toBe(true);
  });

  it('matches subdomain (one level)', () => {
    expect(isAllowedDomain('https://www.notion.so/settings', list)).toBe(true);
    expect(isAllowedDomain('https://david-workspace.notion.so/settings', list)).toBe(true);
  });

  it('matches subdomain (multi level)', () => {
    expect(isAllowedDomain('https://a.b.c.notion.so/foo', list)).toBe(true);
  });

  it('rejects hostname not in list (different domain)', () => {
    expect(isAllowedDomain('https://evil.com/exfil', list)).toBe(false);
  });

  it('rejects hostname that just resembles an allowed one (no domain match)', () => {
    // 'evil-notion.so' is NOT a subdomain of 'notion.so' — different registered domain
    expect(isAllowedDomain('https://evil-notion.so/x', list)).toBe(false);
    // 'notion.so.evil.com' is a subdomain of 'evil.com', not 'notion.so'
    expect(isAllowedDomain('https://notion.so.evil.com/x', list)).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isAllowedDomain('javascript:alert(1)', list)).toBe(false);
    expect(isAllowedDomain('data:text/html,<script>', list)).toBe(false);
    expect(isAllowedDomain('file:///etc/passwd', list)).toBe(false);
    expect(isAllowedDomain('ftp://notion.so/foo', list)).toBe(false);
  });

  it('ignores userinfo when matching (hostname is what counts)', () => {
    // 'attacker@notion.so' user-info pattern — the host is still notion.so
    expect(isAllowedDomain('https://attacker@notion.so/x', list)).toBe(true);
    // But 'attacker@evil.com' is NOT allowed despite userinfo trick
    expect(isAllowedDomain('https://notion.so@evil.com/x', list)).toBe(false);
  });

  it('is case-insensitive for hostname', () => {
    expect(isAllowedDomain('https://NOTION.SO/x', list)).toBe(true);
    expect(isAllowedDomain('https://Mail.Google.Com/x', list)).toBe(true);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedDomain('not a url', list)).toBe(false);
    expect(isAllowedDomain('', list)).toBe(false);
    expect(isAllowedDomain('//notion.so', list)).toBe(false); // no scheme
  });

  it('rejects null/undefined input gracefully', () => {
    expect(isAllowedDomain(null as any, list)).toBe(false);
    expect(isAllowedDomain(undefined as any, list)).toBe(false);
  });

  it('rejects when list is empty (no allowlist == nothing allowed)', () => {
    expect(isAllowedDomain('https://notion.so/x', [])).toBe(false);
  });
});

describe('security — isUrlAllowed (convenience wrapper)', () => {
  it('uses defaults when no override file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'urlallow-'));
    try {
      expect(isUrlAllowed('https://notion.so/x', tmp)).toBe(true);
      expect(isUrlAllowed('https://evil.com/x', tmp)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('respects operator override', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'urlallow-'));
    try {
      mkdirSync(join(tmp, 'config'));
      writeFileSync(allowlistFilePath(tmp), JSON.stringify(['extra.example.com']));
      // notion.so is in V1 defaults but the override replaces — so not allowed now
      expect(isUrlAllowed('https://notion.so/x', tmp)).toBe(false);
      expect(isUrlAllowed('https://extra.example.com/x', tmp)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('integration: writeBridgeRequest M1 enforcement', () => {
  it('throws when context.url is NOT in allowlist (queue-time M1 check)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'm1-int-'));
    try {
      const { generateBridgeKey } = await import('../../../src/bridge/signing.js');
      const { writeBridgeRequest, resolveBridgePaths } = await import('../../../src/bridge/index.js');
      generateBridgeKey(tmp); // satisfy M2 so we hit M1 first
      const paths = resolveBridgePaths('/ignored', tmp);
      expect(() => writeBridgeRequest(paths, {
        fromAgent: 'forge',
        requestType: 'settings_audit',
        description: 'Try to exfil',
        context: { url: 'https://evil-attacker.com/steal' },
        resultDestination: { type: 'agent_inbox', agent: 'forge' },
      }, tmp)).toThrow(/not in allowlist/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allows when context.url IS in allowlist', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'm1-int-'));
    try {
      const { generateBridgeKey } = await import('../../../src/bridge/signing.js');
      const { writeBridgeRequest, resolveBridgePaths } = await import('../../../src/bridge/index.js');
      generateBridgeKey(tmp);
      const paths = resolveBridgePaths('/ignored', tmp);
      const id = writeBridgeRequest(paths, {
        fromAgent: 'forge',
        requestType: 'settings_audit',
        description: 'Legit notion check',
        context: { url: 'https://notion.so/settings' },
        resultDestination: { type: 'agent_inbox', agent: 'forge' },
      }, tmp);
      expect(id).toMatch(/^bridge-/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allows when context has NO url (non-URL request types — M1 only gates URL-bearing requests)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'm1-int-'));
    try {
      const { generateBridgeKey } = await import('../../../src/bridge/signing.js');
      const { writeBridgeRequest, resolveBridgePaths } = await import('../../../src/bridge/index.js');
      generateBridgeKey(tmp);
      const paths = resolveBridgePaths('/ignored', tmp);
      // settings_audit + screenshot_report normally have url; but if someone
      // wires a future request type with no url, M1 should not block.
      const id = writeBridgeRequest(paths, {
        fromAgent: 'forge',
        requestType: 'settings_audit',
        description: 'No-url variant',
        context: {},
        resultDestination: { type: 'agent_inbox', agent: 'forge' },
      }, tmp);
      expect(id).toMatch(/^bridge-/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
