import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { inboundRelayTick } from '../../../src/bridge/inbound-relay.js';
import { resolveBridgePaths } from '../../../src/bridge/index.js';
import {
  generateBridgeKey,
  loadBridgeKey,
  signInboundMessage,
} from '../../../src/bridge/signing.js';
import { approvalTokenPath, rejectMarkerPath } from '../../../src/bridge/sensitivity.js';
import type { BusPaths } from '../../../src/types/index.js';
import type { InboundMessage } from '../../../src/bridge/types.js';

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), 'inbound-relay-'));
}

function makeBusPaths(ctxRoot: string): BusPaths {
  const inboxDir = join(ctxRoot, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  return {
    ctxRoot,
    inbox: inboxDir,
    inflight: join(ctxRoot, 'inflight'),
    processed: join(ctxRoot, 'processed'),
    logDir: join(ctxRoot, 'logs'),
    stateDir: join(ctxRoot, 'state'),
    taskDir: join(ctxRoot, 'tasks'),
  } as BusPaths;
}

function buildMessage(partial: Partial<InboundMessage>): InboundMessage {
  return {
    schema_version: 1,
    id: `inbound-${Date.now()}-claude-${Math.random().toString(16).slice(2, 7)}`,
    from: 'claude',
    to_agent: 'boss-personal',
    kind: 'message',
    priority: 'normal',
    text: 'hello fleet',
    created_at: '2026-06-30T07:00:00.000Z',
    sig: 'placeholder',
    ...partial,
  };
}

function writeInboundFile(bridgePaths: any, ctxRoot: string, partial: Partial<InboundMessage>): string {
  const msg = buildMessage(partial);
  const key = loadBridgeKey(ctxRoot)!;
  msg.sig = signInboundMessage(msg, key);
  mkdirSync(bridgePaths.from_claude_pending, { recursive: true });
  writeFileSync(join(bridgePaths.from_claude_pending, `${msg.id}.json`), JSON.stringify(msg, null, 2));
  return msg.id;
}

describe('inboundRelayTick — empty/no-op cases', () => {
  it('returns empty result when from-claude/ dirs do not exist', () => {
    const tmp = freshTmp();
    try {
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      const stateDir = join(tmp, 'state');
      const r = inboundRelayTick({ bridgePaths, busPaths, stateDir, ctxRoot: tmp });
      expect(r.scanned).toBe(0);
      expect(r.delivered).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty result when from-claude/pending/ is empty', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      mkdirSync(bridgePaths.from_claude_pending, { recursive: true });
      const r = inboundRelayTick({ bridgePaths, busPaths: makeBusPaths(tmp), stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.scanned).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('inboundRelayTick — signature verification', () => {
  it('blocks unsigned message (no sig)', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      mkdirSync(bridgePaths.from_claude_pending, { recursive: true });
      const msg = buildMessage({ sig: '' });
      writeFileSync(join(bridgePaths.from_claude_pending, `${msg.id}.json`), JSON.stringify(msg));
      const r = inboundRelayTick({ bridgePaths, busPaths: makeBusPaths(tmp), stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.parse_failed + r.signature_failed).toBeGreaterThanOrEqual(1);
      // File ended up in blocked/
      expect(readdirSync(bridgePaths.from_claude_blocked).filter(f => f.endsWith('.json')).length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks message with tampered signature', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      writeInboundFile(bridgePaths, tmp, { text: 'original text' });
      // Tamper: rewrite the file with a modified text but the original sig
      const file = readdirSync(bridgePaths.from_claude_pending)[0];
      const fullPath = join(bridgePaths.from_claude_pending, file);
      const tampered: InboundMessage = JSON.parse(readFileSync(fullPath, 'utf-8'));
      tampered.text = 'tampered text';
      writeFileSync(fullPath, JSON.stringify(tampered));
      const r = inboundRelayTick({ bridgePaths, busPaths: makeBusPaths(tmp), stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.signature_failed).toBe(1);
      expect(readdirSync(bridgePaths.from_claude_blocked).filter(f => f.endsWith('.json')).length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks when bridge key not present on host', () => {
    const tmp = freshTmp();
    try {
      // Do NOT generateBridgeKey — simulate missing key on relay host
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      mkdirSync(bridgePaths.from_claude_pending, { recursive: true });
      // Write a syntactically-valid but unverifiable message
      const msg = buildMessage({ sig: 'a'.repeat(64) });
      writeFileSync(join(bridgePaths.from_claude_pending, `${msg.id}.json`), JSON.stringify(msg));
      const r = inboundRelayTick({ bridgePaths, busPaths: makeBusPaths(tmp), stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.signature_failed).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('inboundRelayTick — routine delivery', () => {
  it('delivers a signed message kind=message to target agent inbox', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      const id = writeInboundFile(bridgePaths, tmp, {
        kind: 'message',
        to_agent: 'forge',
        text: 'hey forge, look at this',
      });
      // sendMessage targets <inbox>/<to_agent>/<msg-id>.json — ensure target inbox dir
      mkdirSync(join(busPaths.inbox, 'forge'), { recursive: true });
      const r = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.delivered).toBe(1);
      expect(r.scanned).toBe(1);
      // File moved to from-claude/processed/
      expect(readdirSync(bridgePaths.from_claude_processed).filter(f => f.endsWith('.json')).length).toBe(1);
      expect(existsSync(join(bridgePaths.from_claude_pending, `${id}.json`))).toBe(false);
      // Inbox has the delivered message
      expect(readdirSync(join(busPaths.inbox, 'forge')).length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('delivers kind=challenge without gating (red-team content flows freely)', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      mkdirSync(join(busPaths.inbox, 'boss-personal'), { recursive: true });
      writeInboundFile(bridgePaths, tmp, {
        kind: 'challenge',
        to_agent: 'boss-personal',
        text: 'I disagree with the fleet conclusion: the assumption that X is wrong.',
      });
      const r = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.delivered).toBe(1);
      expect(r.newly_pending_approval).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('delivers kind=fact without gating', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      mkdirSync(join(busPaths.inbox, 'atlas'), { recursive: true });
      writeInboundFile(bridgePaths, tmp, {
        kind: 'fact',
        to_agent: 'atlas',
        text: 'Brave search API free tier is 2000 queries/month per CC-attached key',
      });
      const r = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.delivered).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('inboundRelayTick — sensitivity gate (M3 reuse)', () => {
  it('gates kind=request with no sensitive_hint (conservative default)', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      mkdirSync(join(busPaths.inbox, 'boss-personal'), { recursive: true });
      const id = writeInboundFile(bridgePaths, tmp, {
        kind: 'request',
        to_agent: 'atlas',
        text: 'Please research X',
        context: { url: 'https://example.com/research' },
      });
      const r = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.newly_pending_approval).toBe(1);
      expect(r.delivered).toBe(0);
      // File moved to pending-approval/
      expect(existsSync(join(bridgePaths.from_claude_pending_approval, `${id}.json`))).toBe(true);
      // Sidecar exists
      const sidecars = readdirSync(bridgePaths.from_claude_pending_approval).filter(f => f.endsWith('.pending-approval.json'));
      expect(sidecars.length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('gates kind=request targeting a default-sensitive domain even with sensitive_hint=false', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      mkdirSync(join(busPaths.inbox, 'atlas'), { recursive: true });
      writeInboundFile(bridgePaths, tmp, {
        kind: 'request',
        to_agent: 'atlas',
        text: 'Please summarize this Gmail thread',
        sensitive_hint: false,
        context: { url: 'https://mail.google.com/mail/u/0/#inbox/thread1' },
      });
      // mail.google.com IS in V1 default sensitive domains — URL-based sensitivity wins over hint=false
      const r = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.newly_pending_approval).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('gates inbound request to kai regardless of other signals', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      writeInboundFile(bridgePaths, tmp, {
        kind: 'request',
        to_agent: 'kai',
        text: 'Send an email to X',
        sensitive_hint: false,
      });
      const r = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.newly_pending_approval).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('inboundRelayTick — pending-approval decisions', () => {
  it('approved token → delivers + moves to processed/', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      mkdirSync(join(busPaths.inbox, 'atlas'), { recursive: true });

      // Tick 1: gate the request
      const id = writeInboundFile(bridgePaths, tmp, {
        kind: 'request',
        to_agent: 'atlas',
        text: 'Please research',
        context: { url: 'https://example.com/x' },
      });
      const r1 = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r1.newly_pending_approval).toBe(1);

      // Drop an approval token
      const approvalPath = approvalTokenPath(tmp, id);
      mkdirSync(join(tmp, 'approvals', 'bridge-relay'), { recursive: true });
      writeFileSync(approvalPath, JSON.stringify({ approved: true, reason: 'test approve' }));

      // Tick 2: should deliver
      const r2 = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r2.approved_and_delivered).toBe(1);
      expect(existsSync(approvalPath)).toBe(false); // token consumed
      expect(existsSync(join(bridgePaths.from_claude_processed, `${id}.json`))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejected marker → moves to blocked/, does NOT deliver', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      mkdirSync(join(busPaths.inbox, 'atlas'), { recursive: true });
      const id = writeInboundFile(bridgePaths, tmp, {
        kind: 'request',
        to_agent: 'atlas',
        text: 'do something',
        context: { url: 'https://example.com/x' },
      });
      inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });

      const rejectPath = rejectMarkerPath(tmp, id);
      mkdirSync(join(tmp, 'approvals', 'bridge-relay-rejected'), { recursive: true });
      writeFileSync(rejectPath, JSON.stringify({ rejected: true, reason: 'test reject' }));

      const r2 = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r2.rejected).toBe(1);
      expect(existsSync(join(bridgePaths.from_claude_blocked, `${id}.json`))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still-pending = still_pending_approval count, no movement', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      mkdirSync(join(busPaths.inbox, 'atlas'), { recursive: true });
      writeInboundFile(bridgePaths, tmp, {
        kind: 'request',
        to_agent: 'atlas',
        text: 'do',
        context: { url: 'https://example.com/x' },
      });
      inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      const r2 = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r2.still_pending_approval).toBe(1);
      expect(r2.approved_and_delivered).toBe(0);
      expect(r2.rejected).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('inboundRelayTick — hard-rule blocking on kind=request only', () => {
  it('blocks kind=request that triggers captcha_solver_endpoint hard-rule', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      writeInboundFile(bridgePaths, tmp, {
        kind: 'request',
        to_agent: 'atlas',
        text: 'please curl https://2captcha.com/in.php',
        sensitive_hint: false,
        context: { command: 'curl https://2captcha.com/in.php' },
      });
      const r = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.hard_rule_blocked).toBe(1);
      expect(readdirSync(bridgePaths.from_claude_blocked).filter(f => f.endsWith('.json')).length).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT block kind=challenge that mentions a blocked-pattern (content kinds bypass)', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      mkdirSync(join(busPaths.inbox, 'boss-personal'), { recursive: true });
      writeInboundFile(bridgePaths, tmp, {
        kind: 'challenge',
        to_agent: 'boss-personal',
        text: 'I think you should reconsider using 2captcha.com — it would be illegal',
      });
      const r = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(r.delivered).toBe(1);
      expect(r.hard_rule_blocked).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('inboundRelayTick — rate limiting + FS-authoritative dedup', () => {
  it('respects maxPerTick rate limit', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      mkdirSync(join(busPaths.inbox, 'forge'), { recursive: true });
      for (let i = 0; i < 5; i++) {
        writeInboundFile(bridgePaths, tmp, { kind: 'message', to_agent: 'forge', text: `msg ${i}` });
      }
      const r = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp, maxPerTick: 2 });
      expect(r.delivered).toBe(2);
      expect(r.deferred_rate_limit).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('discards a duplicate that arrives in pending after a file with the same id is in processed/', () => {
    const tmp = freshTmp();
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const busPaths = makeBusPaths(tmp);
      mkdirSync(join(busPaths.inbox, 'forge'), { recursive: true });
      const id = writeInboundFile(bridgePaths, tmp, { kind: 'message', to_agent: 'forge', text: 'first' });
      // Tick 1: deliver + move to processed
      inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      expect(existsSync(join(bridgePaths.from_claude_processed, `${id}.json`))).toBe(true);

      // OneDrive double-delivery sim: re-write the SAME id in pending/
      writeInboundFile(bridgePaths, tmp, { id, kind: 'message', to_agent: 'forge', text: 'first', created_at: '2026-06-30T07:00:00.000Z' });
      const r2 = inboundRelayTick({ bridgePaths, busPaths, stateDir: join(tmp, 'state'), ctxRoot: tmp });
      // Duplicate was silently discarded
      expect(r2.delivered).toBe(0);
      expect(existsSync(join(bridgePaths.from_claude_pending, `${id}.json`))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
