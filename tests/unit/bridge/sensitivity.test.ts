import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  V1_DEFAULT_SENSITIVE_DOMAINS,
  loadSensitiveDomains,
  sensitiveDomainsFilePath,
  isSensitiveResponse,
  pendingApprovalSidecarPath,
  approvalTokenPath,
  rejectMarkerPath,
  checkApprovalDecision,
} from '../../../src/bridge/sensitivity.js';
import { relayTick } from '../../../src/bridge/relay.js';
import { resolveBridgePaths } from '../../../src/bridge/index.js';
import type { BridgeRequest, BridgeResponseMetadata } from '../../../src/bridge/types.js';

const sampleReq = (overrides: Partial<BridgeRequest> = {}): BridgeRequest => ({
  id: 'bridge-abc',
  from_agent: 'forge',
  created_at: '2026-06-29T10:00:00.000Z',
  request_type: 'settings_audit',
  description: 'd',
  context: { url: 'https://notion.so/settings' },
  result_destination: { type: 'agent_inbox', agent: 'boss-personal' },
  ...overrides,
});

const sampleResp = (overrides: Partial<BridgeResponseMetadata> = {}): BridgeResponseMetadata => ({
  request_id: 'bridge-abc',
  cowork_session_id: 'cw-1',
  status: 'success',
  completed_at: '2026-06-29T11:00:00.000Z',
  ...overrides,
});

describe('sensitivity — V1 defaults + override loading', () => {
  it('V1 default list contains 2 domains (mail+calendar)', () => {
    expect(V1_DEFAULT_SENSITIVE_DOMAINS).toEqual(['mail.google.com', 'calendar.google.com']);
  });

  it('loadSensitiveDomains returns defaults when no override file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sens-'));
    try {
      expect(loadSensitiveDomains(tmp)).toEqual(V1_DEFAULT_SENSITIVE_DOMAINS);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('loadSensitiveDomains returns override when present', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sens-'));
    try {
      mkdirSync(join(tmp, 'config'));
      writeFileSync(sensitiveDomainsFilePath(tmp), JSON.stringify(['mail.google.com', 'banking.example.com']));
      expect(loadSensitiveDomains(tmp)).toEqual(['mail.google.com', 'banking.example.com']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to defaults on malformed override JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sens-'));
    try {
      mkdirSync(join(tmp, 'config'));
      writeFileSync(sensitiveDomainsFilePath(tmp), '{not valid');
      expect(loadSensitiveDomains(tmp)).toEqual(V1_DEFAULT_SENSITIVE_DOMAINS);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('sensitivity — isSensitiveResponse classifier', () => {
  const list = ['mail.google.com', 'calendar.google.com'];

  it('flags failed-status responses regardless of domain', () => {
    const r = isSensitiveResponse(sampleReq(), sampleResp({ status: 'failed', error: 'page 403' }), list);
    expect(r.sensitive).toBe(true);
    expect(r.reason).toContain("status='failed'");
  });

  it('flags responses from sensitive-domain URLs (exact match)', () => {
    const r = isSensitiveResponse(
      sampleReq({ context: { url: 'https://mail.google.com/inbox' } }),
      sampleResp(),
      list,
    );
    expect(r.sensitive).toBe(true);
    expect(r.reason).toContain('mail.google.com');
  });

  it('flags responses from sensitive-domain URLs (subdomain match)', () => {
    const r = isSensitiveResponse(
      sampleReq({ context: { url: 'https://api.mail.google.com/v1/messages' } }),
      sampleResp(),
      list,
    );
    expect(r.sensitive).toBe(true);
  });

  it('does NOT flag success responses from non-sensitive domains', () => {
    const r = isSensitiveResponse(
      sampleReq({ context: { url: 'https://notion.so/settings' } }),
      sampleResp({ status: 'success' }),
      list,
    );
    expect(r.sensitive).toBe(false);
  });

  it('does NOT flag partial responses from non-sensitive domains', () => {
    const r = isSensitiveResponse(
      sampleReq({ context: { url: 'https://calendly.com/me' } }),
      sampleResp({ status: 'partial' }),
      list,
    );
    expect(r.sensitive).toBe(false);
  });

  it('defensively flags responses with unparseable context.url (suspicious post-M1)', () => {
    const r = isSensitiveResponse(
      sampleReq({ context: { url: 'not a url' } }),
      sampleResp(),
      list,
    );
    expect(r.sensitive).toBe(true);
    expect(r.reason).toContain('unparseable');
  });

  it('does NOT flag when context has NO url (no URL to classify against)', () => {
    const r = isSensitiveResponse(
      sampleReq({ context: { other: 'thing' } }),
      sampleResp(),
      list,
    );
    expect(r.sensitive).toBe(false);
  });
});

describe('sensitivity — approval-decision state machine', () => {
  it('returns pending when no token + no reject marker', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sens-'));
    try {
      expect(checkApprovalDecision(tmp, 'bridge-abc').status).toBe('pending');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns approved when token file exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sens-'));
    try {
      const p = approvalTokenPath(tmp, 'bridge-abc');
      mkdirSync(require('path').dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ reason: 'David said go' }));
      const d = checkApprovalDecision(tmp, 'bridge-abc');
      expect(d.status).toBe('approved');
      expect(d.reason).toBe('David said go');
      expect(d.tokenPath).toBe(p);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns rejected when reject marker file exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sens-'));
    try {
      const p = rejectMarkerPath(tmp, 'bridge-abc');
      mkdirSync(require('path').dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ reason: 'not now' }));
      const d = checkApprovalDecision(tmp, 'bridge-abc');
      expect(d.status).toBe('rejected');
      expect(d.reason).toBe('not now');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('relay — M3 integration', () => {
  const mkBusPaths = (ctxRoot: string, agent: string) => ({
    ctxRoot,
    inbox: join(ctxRoot, 'inbox', agent),
    inflight: join(ctxRoot, 'inflight', agent),
    outboxDir: join(ctxRoot, 'outbox'),
    taskDir: join(ctxRoot, 'tasks'),
    analyticsDir: join(ctxRoot, 'analytics'),
    stateDir: join(ctxRoot, 'state'),
  } as any);

  const writeCompleted = (processedDir: string, id: string, url: string, status: 'success' | 'partial' | 'failed') => {
    mkdirSync(processedDir, { recursive: true });
    writeFileSync(join(processedDir, `${id}.json`), JSON.stringify({
      request: {
        id, from_agent: 'forge', created_at: '2026-06-29T10:00:00.000Z',
        request_type: 'settings_audit', description: 'test',
        context: { url },
        result_destination: { type: 'agent_inbox', agent: 'forge' },
      },
      response: {
        request_id: id, cowork_session_id: 'cw-1', status,
        completed_at: '2026-06-29T11:00:00.000Z',
        ...(status === 'failed' ? { error: 'test failure' } : {}),
      },
    }));
  };

  it('auto-relays a non-sensitive success response (no gate)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'm3-int-'));
    try {
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = mkBusPaths(join(tmp, 'ctx'), 'forge');
      writeCompleted(bridgePaths.processed, 'bridge-1', 'https://notion.so/x', 'success');
      const r = relayTick(bridgePaths, busPaths, join(tmp, 'ctx', 'state', 'atlas'));
      expect(r.relayed).toBe(1);
      expect(r.newly_pending_approval).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('gates a sensitive-domain response (writes sidecar + skips relay)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'm3-int-'));
    try {
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = mkBusPaths(join(tmp, 'ctx'), 'forge');
      writeCompleted(bridgePaths.processed, 'bridge-2', 'https://mail.google.com/inbox', 'success');
      const r = relayTick(bridgePaths, busPaths, join(tmp, 'ctx', 'state', 'atlas'));
      expect(r.relayed).toBe(0);
      expect(r.newly_pending_approval).toBe(1);
      expect(existsSync(pendingApprovalSidecarPath(bridgePaths.processed, 'bridge-2'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('relays after operator grants approval token', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'm3-int-'));
    try {
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const ctxRoot = join(tmp, 'ctx');
      const busPaths = mkBusPaths(ctxRoot, 'forge');
      writeCompleted(bridgePaths.processed, 'bridge-3', 'https://mail.google.com/x', 'success');
      // Tick 1: gates
      let r = relayTick(bridgePaths, busPaths, join(ctxRoot, 'state', 'atlas'));
      expect(r.newly_pending_approval).toBe(1);
      expect(r.relayed).toBe(0);
      // Operator grants approval
      const tokenP = approvalTokenPath(ctxRoot, 'bridge-3');
      mkdirSync(require('path').dirname(tokenP), { recursive: true });
      writeFileSync(tokenP, JSON.stringify({ reason: 'David said go' }));
      // Tick 2: relays + consumes token + cleans sidecar
      r = relayTick(bridgePaths, busPaths, join(ctxRoot, 'state', 'atlas'));
      expect(r.relayed).toBe(1);
      expect(existsSync(tokenP)).toBe(false);
      expect(existsSync(pendingApprovalSidecarPath(bridgePaths.processed, 'bridge-3'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('moves response to failed/ when operator sets reject marker', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'm3-int-'));
    try {
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const ctxRoot = join(tmp, 'ctx');
      const busPaths = mkBusPaths(ctxRoot, 'forge');
      writeCompleted(bridgePaths.processed, 'bridge-4', 'https://mail.google.com/x', 'success');
      // Tick 1: gates
      let r = relayTick(bridgePaths, busPaths, join(ctxRoot, 'state', 'atlas'));
      expect(r.newly_pending_approval).toBe(1);
      // Operator rejects
      const rejP = rejectMarkerPath(ctxRoot, 'bridge-4');
      mkdirSync(require('path').dirname(rejP), { recursive: true });
      writeFileSync(rejP, JSON.stringify({ reason: 'not now' }));
      // Tick 2: moves to failed/ + cleans sidecar
      r = relayTick(bridgePaths, busPaths, join(ctxRoot, 'state', 'atlas'));
      expect(r.rejected).toBe(1);
      expect(existsSync(join(bridgePaths.processed, 'bridge-4.json'))).toBe(false);
      expect(existsSync(join(bridgePaths.failed, 'bridge-4.json'))).toBe(true);
      expect(existsSync(pendingApprovalSidecarPath(bridgePaths.processed, 'bridge-4'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still_pending_approval on subsequent ticks while awaiting David', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'm3-int-'));
    try {
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = mkBusPaths(join(tmp, 'ctx'), 'forge');
      writeCompleted(bridgePaths.processed, 'bridge-5', 'https://mail.google.com/x', 'success');
      relayTick(bridgePaths, busPaths, join(tmp, 'ctx', 'state', 'atlas'));
      const r = relayTick(bridgePaths, busPaths, join(tmp, 'ctx', 'state', 'atlas'));
      expect(r.still_pending_approval).toBe(1);
      expect(r.newly_pending_approval).toBe(0);
      expect(r.relayed).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
