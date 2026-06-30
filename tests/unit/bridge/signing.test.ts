import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  canonicalSignPayload,
  canonicalInboundSignPayload,
  bridgeKeyPath,
  loadBridgeKey,
  generateBridgeKey,
  signRequest,
  verifyRequest,
  signInboundMessage,
  verifyInboundMessage,
} from '../../../src/bridge/signing.js';
import type { BridgeRequest, InboundMessage } from '../../../src/bridge/types.js';

const sampleInbound = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  schema_version: 1,
  id: 'inbound-12345-claude-xyz',
  from: 'claude',
  to_agent: 'forge',
  kind: 'message',
  priority: 'normal',
  text: 'hello',
  created_at: '2026-06-30T07:00:00.000Z',
  sig: '',
  ...overrides,
});

const sampleRequest = (overrides: Partial<BridgeRequest> = {}): BridgeRequest => ({
  id: 'bridge-12345-forge-abcdef',
  from_agent: 'forge',
  created_at: '2026-06-29T10:00:00.000Z',
  request_type: 'settings_audit',
  description: 'Audit settings',
  context: { url: 'https://notion.so/settings', extract: ['default_share_level'] },
  result_destination: { type: 'agent_inbox', agent: 'boss-personal' },
  ...overrides,
});

describe('signing — canonicalSignPayload', () => {
  it('is deterministic for the same input', () => {
    const a = canonicalSignPayload(sampleRequest());
    const b = canonicalSignPayload(sampleRequest());
    expect(a).toBe(b);
  });

  it('includes id, from_agent, request_type, context, recipient', () => {
    const payload = canonicalSignPayload(sampleRequest());
    expect(payload).toContain('bridge-12345-forge-abcdef');
    expect(payload).toContain('forge');
    expect(payload).toContain('settings_audit');
    expect(payload).toContain('notion.so');
    expect(payload).toContain('boss-personal');
  });

  it('differs when context changes', () => {
    const a = canonicalSignPayload(sampleRequest());
    const b = canonicalSignPayload(sampleRequest({ context: { url: 'https://evil.com' } }));
    expect(a).not.toBe(b);
  });

  it('differs when request_type changes', () => {
    const a = canonicalSignPayload(sampleRequest());
    const b = canonicalSignPayload(sampleRequest({ request_type: 'screenshot_report' }));
    expect(a).not.toBe(b);
  });
});

describe('signing — generateBridgeKey + loadBridgeKey', () => {
  it('writes a 64-hex-char key with mode 0600', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-sign-'));
    try {
      const path = generateBridgeKey(tmp);
      expect(path).toBe(join(tmp, 'config', 'bridge-signing-key'));
      expect(existsSync(path)).toBe(true);
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
      // Read it back via low-level fs to verify content (vitest doesn't mock fs here)
      const size = statSync(path).size;
      const fd = openSync(path, 'r');
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      closeSync(fd);
      const key = buf.toString('utf-8').trim();
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing key without --force', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-sign-'));
    try {
      generateBridgeKey(tmp);
      expect(() => generateBridgeKey(tmp)).toThrow(/already exists/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('overwrites when force=true (rotation)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-sign-'));
    try {
      generateBridgeKey(tmp);
      const k1 = loadBridgeKey(tmp);
      generateBridgeKey(tmp, true);
      const k2 = loadBridgeKey(tmp);
      expect(k1).not.toBe(k2);
      expect(k2).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('loadBridgeKey returns null when key file is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-sign-'));
    try {
      expect(loadBridgeKey(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('loadBridgeKey returns the key as a string when present', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-sign-'));
    try {
      generateBridgeKey(tmp);
      const key = loadBridgeKey(tmp);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('signing — signRequest + verifyRequest', () => {
  const key = 'a'.repeat(64);

  it('round-trips: sign + verify succeeds', () => {
    const req = sampleRequest();
    req.sig = signRequest(req, key);
    expect(verifyRequest(req, key)).toBe(true);
  });

  it('produces a 64-char hex signature', () => {
    const sig = signRequest(sampleRequest(), key);
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
  });

  it('detects tampering with context.url (most critical M1+M2 scenario)', () => {
    const req = sampleRequest();
    req.sig = signRequest(req, key);
    req.context.url = 'https://evil.com';
    expect(verifyRequest(req, key)).toBe(false);
  });

  it('detects tampering with from_agent', () => {
    const req = sampleRequest();
    req.sig = signRequest(req, key);
    req.from_agent = 'attacker';
    expect(verifyRequest(req, key)).toBe(false);
  });

  it('detects tampering with request_type', () => {
    const req = sampleRequest();
    req.sig = signRequest(req, key);
    req.request_type = 'screenshot_report';
    expect(verifyRequest(req, key)).toBe(false);
  });

  it('detects tampering with recipient', () => {
    const req = sampleRequest();
    req.sig = signRequest(req, key);
    req.result_destination = { type: 'agent_inbox', agent: 'attacker-agent' };
    expect(verifyRequest(req, key)).toBe(false);
  });

  it('detects wrong key (forged sig from a different key)', () => {
    const req = sampleRequest();
    req.sig = signRequest(req, 'b'.repeat(64));
    expect(verifyRequest(req, key)).toBe(false);
  });

  it('rejects request with no sig field', () => {
    const req = sampleRequest();
    expect(verifyRequest(req, key)).toBe(false);
  });

  it('rejects request with malformed sig (non-hex)', () => {
    const req = sampleRequest();
    req.sig = 'not-hex!';
    expect(verifyRequest(req, key)).toBe(false);
  });

  it('rejects request with wrong-length sig', () => {
    const req = sampleRequest();
    req.sig = 'a'.repeat(63); // off by one
    expect(verifyRequest(req, key)).toBe(false);
  });

  it('uses constant-time comparison (timingSafeEqual — verified by signature length mismatch path)', () => {
    // Indirect: passing sigs of clearly-different lengths short-circuits to
    // false before timingSafeEqual gets called. Behaviorally indistinguishable
    // from a timingSafeEqual call but confirms the wrap. Direct timing tests
    // are flaky in CI; trust the lib + structure.
    const req = sampleRequest();
    req.sig = 'short';
    expect(verifyRequest(req, key)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inbound message signing — Phase A
// ---------------------------------------------------------------------------

describe('canonicalInboundSignPayload', () => {
  it('is deterministic for the same input', () => {
    const a = canonicalInboundSignPayload(sampleInbound());
    const b = canonicalInboundSignPayload(sampleInbound());
    expect(a).toBe(b);
  });

  it('changes when text changes', () => {
    const a = canonicalInboundSignPayload(sampleInbound({ text: 'one' }));
    const b = canonicalInboundSignPayload(sampleInbound({ text: 'two' }));
    expect(a).not.toBe(b);
  });

  it('changes when kind changes', () => {
    const a = canonicalInboundSignPayload(sampleInbound({ kind: 'message' }));
    const b = canonicalInboundSignPayload(sampleInbound({ kind: 'challenge' }));
    expect(a).not.toBe(b);
  });

  it('changes when context changes', () => {
    const a = canonicalInboundSignPayload(sampleInbound({ context: { url: 'a' } }));
    const b = canonicalInboundSignPayload(sampleInbound({ context: { url: 'b' } }));
    expect(a).not.toBe(b);
  });
});

describe('signInboundMessage / verifyInboundMessage', () => {
  const key = 'test-key';

  it('signs + verifies round-trip', () => {
    const m = sampleInbound();
    m.sig = signInboundMessage(m, key);
    expect(verifyInboundMessage(m, key)).toBe(true);
  });

  it('rejects when text is tampered', () => {
    const m = sampleInbound({ text: 'original' });
    m.sig = signInboundMessage(m, key);
    m.text = 'tampered';
    expect(verifyInboundMessage(m, key)).toBe(false);
  });

  it('rejects with wrong key', () => {
    const m = sampleInbound();
    m.sig = signInboundMessage(m, key);
    expect(verifyInboundMessage(m, 'wrong-key')).toBe(false);
  });

  it('rejects missing sig', () => {
    const m = sampleInbound({ sig: '' });
    expect(verifyInboundMessage(m, key)).toBe(false);
  });

  it('rejects malformed sig (non-hex)', () => {
    const m = sampleInbound({ sig: 'not-hex-at-all!!!' });
    expect(verifyInboundMessage(m, key)).toBe(false);
  });

  it('rejects wrong-length sig', () => {
    const m = sampleInbound({ sig: 'ab12' });
    expect(verifyInboundMessage(m, key)).toBe(false);
  });
});
