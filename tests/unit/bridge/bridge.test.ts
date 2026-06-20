import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Read a file from disk bypassing any test-time fs mocks (none here, but consistent
// with the pattern used elsewhere in tests/unit/pty/agent-pty.test.ts).
function readReal(p: string): string {
  const size = statSync(p).size;
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

import {
  resolveBridgePaths,
  composeBridgeRequest,
  writeBridgeRequest,
  getBridgeStatus,
  listBridgeRequests,
  sweepBridge,
  V1_ALLOWED_REQUEST_TYPES,
} from '../../../src/bridge/index.js';

import { relayTick } from '../../../src/bridge/relay.js';

describe('bridge/paths', () => {
  it('defaults root to OneDrive cowork-tasks (atlas-spec channel)', () => {
    const paths = resolveBridgePaths('/tmp/ignored-ctxroot');
    expect(paths.root).toMatch(/CloudStorage\/OneDrive-Personal\/cowork-tasks$/);
  });

  it('respects rootOverride for test isolation', () => {
    const paths = resolveBridgePaths('/tmp/ignored', '/tmp/my-bridge');
    expect(paths.root).toBe('/tmp/my-bridge');
    expect(paths.outbound).toBe('/tmp/my-bridge/pending');
    expect(paths.processing).toBe('/tmp/my-bridge/in-progress');
    expect(paths.processed).toBe('/tmp/my-bridge/completed');
    expect(paths.failed).toBe('/tmp/my-bridge/failed');
  });
});

describe('bridge/outbound — composeBridgeRequest validation', () => {
  const baseArgs = {
    fromAgent: 'boss-personal',
    requestType: 'settings_audit' as const,
    description: 'Check current Notion sharing settings',
    context: { url: 'https://notion.so/settings/sharing' },
    resultDestination: { type: 'agent_inbox' as const, agent: 'boss-personal' },
  };

  it('returns a well-formed request with id starting with bridge-', () => {
    const req = composeBridgeRequest(baseArgs);
    expect(req.id).toMatch(/^bridge-\d+-boss-personal-[a-f0-9]{6}$/);
    expect(req.from_agent).toBe('boss-personal');
    expect(req.request_type).toBe('settings_audit');
    expect(req.description).toBe('Check current Notion sharing settings');
    expect(req.context).toEqual({ url: 'https://notion.so/settings/sharing' });
    expect(req.result_destination.type).toBe('agent_inbox');
    expect(req.result_destination.agent).toBe('boss-personal');
    expect(req.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  });

  it('accepts the other V1 allowlist type screenshot_report', () => {
    const req = composeBridgeRequest({ ...baseArgs, requestType: 'screenshot_report' });
    expect(req.request_type).toBe('screenshot_report');
  });

  it('rejects request types not in the V1 allowlist (e.g. browser_task)', () => {
    expect(() => composeBridgeRequest({ ...baseArgs, requestType: 'browser_task' as any }))
      .toThrow(/not in V1 allowlist/);
  });

  it('rejects invalid fromAgent name', () => {
    expect(() => composeBridgeRequest({ ...baseArgs, fromAgent: 'Bad Agent Name!' }))
      .toThrow(/Invalid agent name/);
  });

  it('rejects empty description', () => {
    expect(() => composeBridgeRequest({ ...baseArgs, description: '   ' }))
      .toThrow(/description is required/);
  });

  it('rejects unsupported result_destination type', () => {
    expect(() => composeBridgeRequest({
      ...baseArgs,
      resultDestination: { type: 'notion_db_row' as any, agent: 'boss-personal' },
    })).toThrow(/not supported in V1/);
  });

  it('rejects result_destination without agent', () => {
    expect(() => composeBridgeRequest({
      ...baseArgs,
      resultDestination: { type: 'agent_inbox' as const },
    })).toThrow(/resultDestination.agent is required/);
  });

  it('lists the V1 allowed types explicitly', () => {
    expect(V1_ALLOWED_REQUEST_TYPES).toEqual(['settings_audit', 'screenshot_report']);
  });
});

describe('bridge/outbound — writeBridgeRequest', () => {
  it('writes the request file atomically to pending/<id>.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-out-'));
    try {
      const paths = resolveBridgePaths('/ignored', tmp);
      const id = writeBridgeRequest(paths, {
        fromAgent: 'forge',
        requestType: 'settings_audit',
        description: 'Smoke test',
        context: {},
        resultDestination: { type: 'agent_inbox', agent: 'forge' },
      });
      const filePath = join(paths.outbound, `${id}.json`);
      expect(existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(readReal(filePath));
      expect(parsed.id).toBe(id);
      expect(parsed.from_agent).toBe('forge');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('bridge/status — state machine', () => {
  it('reports queued when file is in pending/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-status-'));
    try {
      const paths = resolveBridgePaths('/ignored', tmp);
      mkdirSync(paths.outbound, { recursive: true });
      writeFileSync(join(paths.outbound, 'bridge-xyz.json'), '{"id":"bridge-xyz"}');
      expect(getBridgeStatus(paths, 'bridge-xyz')).toBe('queued');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports in_progress when file is in in-progress/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-status-'));
    try {
      const paths = resolveBridgePaths('/ignored', tmp);
      mkdirSync(paths.processing, { recursive: true });
      writeFileSync(join(paths.processing, 'bridge-xyz.json'), '{"id":"bridge-xyz"}');
      expect(getBridgeStatus(paths, 'bridge-xyz')).toBe('in_progress');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports completed when file is in completed/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-status-'));
    try {
      const paths = resolveBridgePaths('/ignored', tmp);
      mkdirSync(paths.processed, { recursive: true });
      writeFileSync(join(paths.processed, 'bridge-xyz.json'), '{"id":"bridge-xyz"}');
      expect(getBridgeStatus(paths, 'bridge-xyz')).toBe('completed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports failed when file is in failed/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-status-'));
    try {
      const paths = resolveBridgePaths('/ignored', tmp);
      mkdirSync(paths.failed, { recursive: true });
      writeFileSync(join(paths.failed, 'bridge-xyz.json'), '{"id":"bridge-xyz"}');
      expect(getBridgeStatus(paths, 'bridge-xyz')).toBe('failed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports unknown when no file exists in any dir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-status-'));
    try {
      const paths = resolveBridgePaths('/ignored', tmp);
      expect(getBridgeStatus(paths, 'bridge-nonexistent')).toBe('unknown');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('bridge/status — listBridgeRequests', () => {
  it('returns all requests across all states, sorted newest-first', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-list-'));
    try {
      const paths = resolveBridgePaths('/ignored', tmp);
      mkdirSync(paths.outbound, { recursive: true });
      mkdirSync(paths.processed, { recursive: true });
      writeFileSync(join(paths.outbound, 'bridge-newer.json'), JSON.stringify({
        id: 'bridge-newer', from_agent: 'forge', created_at: '2026-06-19T12:00:00.000Z',
        request_type: 'settings_audit', description: 'newer request',
        context: {}, result_destination: { type: 'agent_inbox', agent: 'forge' },
      }));
      writeFileSync(join(paths.processed, 'bridge-older.json'), JSON.stringify({
        id: 'bridge-older', from_agent: 'forge', created_at: '2026-06-19T08:00:00.000Z',
        request_type: 'screenshot_report', description: 'older request',
        context: {}, result_destination: { type: 'agent_inbox', agent: 'forge' },
      }));
      const list = listBridgeRequests(paths);
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('bridge-newer');
      expect(list[0].status).toBe('queued');
      expect(list[1].id).toBe('bridge-older');
      expect(list[1].status).toBe('completed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips malformed JSON files silently', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-list-'));
    try {
      const paths = resolveBridgePaths('/ignored', tmp);
      mkdirSync(paths.outbound, { recursive: true });
      writeFileSync(join(paths.outbound, 'bridge-good.json'), JSON.stringify({
        id: 'bridge-good', from_agent: 'forge', created_at: '2026-06-19T12:00:00.000Z',
        request_type: 'settings_audit', description: 'ok',
        context: {}, result_destination: { type: 'agent_inbox', agent: 'forge' },
      }));
      writeFileSync(join(paths.outbound, 'bridge-bad.json'), '{ this is not json');
      const list = listBridgeRequests(paths);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('bridge-good');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('bridge/janitor — sweepBridge', () => {
  it('moves stale pending requests to failed/ based on created_at', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-jan-'));
    try {
      const paths = resolveBridgePaths('/ignored', tmp);
      mkdirSync(paths.outbound, { recursive: true });
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      writeFileSync(join(paths.outbound, 'bridge-stale.json'), JSON.stringify({
        id: 'bridge-stale', from_agent: 'forge', created_at: oldDate,
        request_type: 'settings_audit', description: 'too old',
        context: {}, result_destination: { type: 'agent_inbox', agent: 'forge' },
      }));
      const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      writeFileSync(join(paths.outbound, 'bridge-fresh.json'), JSON.stringify({
        id: 'bridge-fresh', from_agent: 'forge', created_at: recentDate,
        request_type: 'settings_audit', description: 'too new to time out',
        context: {}, result_destination: { type: 'agent_inbox', agent: 'forge' },
      }));
      const r = sweepBridge(paths, { staleAfter: '24h' });
      expect(r.timed_out).toBe(1);
      expect(r.errors).toEqual([]);
      expect(existsSync(join(paths.failed, 'bridge-stale.json'))).toBe(true);
      expect(existsSync(join(paths.outbound, 'bridge-fresh.json'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not crash when bridge dirs do not exist yet', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-jan-empty-'));
    try {
      const paths = resolveBridgePaths('/ignored', tmp);
      const r = sweepBridge(paths, { staleAfter: '24h' });
      expect(r.timed_out).toBe(0);
      expect(r.errors).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('bridge/relay — relayTick', () => {
  it('relays a completed file into the requesting agent inbox + tracks state idempotently', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-relay-'));
    try {
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const ctxRoot = join(tmp, 'ctx');
      const busPaths = {
        ctxRoot,
        inbox: join(ctxRoot, 'inbox', 'boss-personal'),
        inflight: join(ctxRoot, 'inflight', 'boss-personal'),
        outboxDir: join(ctxRoot, 'outbox'),
        taskDir: join(ctxRoot, 'tasks'),
        analyticsDir: join(ctxRoot, 'analytics'),
        stateDir: join(ctxRoot, 'state'),
      } as any;
      mkdirSync(bridgePaths.processed, { recursive: true });
      const requestId = 'bridge-1750000000-boss-personal-abc123';
      writeFileSync(join(bridgePaths.processed, `${requestId}.json`), JSON.stringify({
        request: {
          id: requestId,
          from_agent: 'boss-personal',
          created_at: '2026-06-19T12:00:00.000Z',
          request_type: 'settings_audit',
          description: 'Check Notion settings',
          context: { url: 'https://notion.so/settings' },
          result_destination: { type: 'agent_inbox', agent: 'boss-personal' },
        },
        response: {
          request_id: requestId,
          cowork_session_id: 'cw-session-abc',
          status: 'success',
          completed_at: '2026-06-19T13:00:00.000Z',
          result: { sharing_mode: 'workspace_only' },
        },
      }));

      const stateDir = join(ctxRoot, 'state', 'atlas');
      const first = relayTick(bridgePaths, busPaths, stateDir);
      expect(first.scanned).toBe(1);
      expect(first.relayed).toBe(1);
      expect(first.failures).toEqual([]);

      // Inbox file should now exist
      const inboxFiles = readdirSync(busPaths.inbox);
      expect(inboxFiles.length).toBe(1);
      const inboxFile = inboxFiles[0];
      expect(inboxFile).toMatch(/^2-\d+-from-cowork-bridge-/); // priority 2 = normal
      const msg = JSON.parse(readReal(join(busPaths.inbox, inboxFile)));
      expect(msg.from).toBe('cowork-bridge');
      expect(msg.to).toBe('boss-personal');
      expect(msg.reply_to).toBe(requestId);
      expect(msg.text).toContain('bridge-meta');
      expect(msg.text).toContain(requestId);
      expect(msg.text).toContain('Check Notion settings');

      // Second tick: idempotent, should skip
      const second = relayTick(bridgePaths, busPaths, stateDir);
      expect(second.scanned).toBe(1);
      expect(second.relayed).toBe(0);
      expect(second.skipped_already_relayed).toBe(1);

      // Inbox still only has one file
      expect(readdirSync(busPaths.inbox)).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('routes failed-status responses at high priority', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-relay-fail-'));
    try {
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const ctxRoot = join(tmp, 'ctx');
      const busPaths = {
        ctxRoot, inbox: join(ctxRoot, 'inbox', 'forge'), inflight: join(ctxRoot, 'inflight', 'forge'),
        outboxDir: join(ctxRoot, 'outbox'), taskDir: join(ctxRoot, 'tasks'),
        analyticsDir: join(ctxRoot, 'analytics'), stateDir: join(ctxRoot, 'state'),
      } as any;
      mkdirSync(bridgePaths.processed, { recursive: true });
      const requestId = 'bridge-1750000001-forge-def456';
      writeFileSync(join(bridgePaths.processed, `${requestId}.json`), JSON.stringify({
        request: {
          id: requestId, from_agent: 'forge', created_at: '2026-06-19T12:00:00.000Z',
          request_type: 'screenshot_report', description: 'Snap settings page',
          context: { url: 'https://example.com' },
          result_destination: { type: 'agent_inbox', agent: 'forge' },
        },
        response: {
          request_id: requestId, cowork_session_id: 'cw-1', status: 'failed',
          completed_at: '2026-06-19T13:00:00.000Z',
          error: 'Page returned 403',
          retryable: false,
        },
      }));
      const r = relayTick(bridgePaths, busPaths, join(ctxRoot, 'state', 'atlas'));
      expect(r.relayed).toBe(1);
      const inboxFile = readdirSync(busPaths.inbox)[0];
      expect(inboxFile).toMatch(/^1-/); // priority 1 = high
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not crash when completed/ dir does not exist', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bridge-relay-empty-'));
    try {
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const ctxRoot = join(tmp, 'ctx');
      const busPaths = {
        ctxRoot, inbox: join(ctxRoot, 'inbox', 'forge'), inflight: join(ctxRoot, 'inflight', 'forge'),
        outboxDir: join(ctxRoot, 'outbox'), taskDir: join(ctxRoot, 'tasks'),
        analyticsDir: join(ctxRoot, 'analytics'), stateDir: join(ctxRoot, 'state'),
      } as any;
      const r = relayTick(bridgePaths, busPaths, join(ctxRoot, 'state', 'atlas'));
      expect(r.scanned).toBe(0);
      expect(r.relayed).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
