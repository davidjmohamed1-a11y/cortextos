import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { executorTick } from '../../../src/bridge/local-executor.js';
import { resolveBridgePaths } from '../../../src/bridge/index.js';
import { generateBridgeKey, signRequest, loadBridgeKey } from '../../../src/bridge/signing.js';

// Mock agent-browser by pointing at a tiny shell stub that echoes a fixed JSON.
// Allows the executor to exercise the dispatch + write path without actually
// launching Chrome.
function makeFakeAgentBrowser(tmp: string): string {
  const stub = join(tmp, 'fake-agent-browser.sh');
  writeFileSync(stub, [
    '#!/usr/bin/env bash',
    '# Minimal agent-browser stub: snapshot returns a fake page; other commands exit 0.',
    'cmd="$1"',
    'if [[ "$cmd" == "snapshot" ]]; then',
    '  echo "title: Example Domain"',
    '  echo "@e1 link \\"More information...\\""',
    'fi',
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  return stub;
}

function writeBridgeRequestFile(bridgePaths: any, ctxRoot: string, partial: any): string {
  const id = `bridge-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  mkdirSync(bridgePaths.outbound, { recursive: true });
  const req: any = {
    id,
    from_agent: 'forge',
    created_at: '2026-06-29T20:00:00.000Z',
    request_type: 'screenshot_report',
    description: 'test',
    context: { url: 'https://notion.so/foo' },
    result_destination: { type: 'agent_inbox', agent: 'forge' },
    ...partial,
  };
  const key = loadBridgeKey(ctxRoot)!;
  req.sig = signRequest(req, key);
  writeFileSync(join(bridgePaths.outbound, `${id}.json`), JSON.stringify(req, null, 2));
  return id;
}

describe('local-executor — executorTick', () => {
  it('no pending requests = no-op', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'executor-'));
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const r = executorTick({ ctxRoot: tmp, bridgePaths, log: () => {}, oneShot: true });
      expect(r.scanned).toBe(0);
      expect(r.executed).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('moves a request with bad signature to failed/ with M2 reason', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'executor-'));
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      mkdirSync(bridgePaths.outbound, { recursive: true });
      // Write a request with NO signature
      const id = 'bridge-unsigned';
      writeFileSync(join(bridgePaths.outbound, `${id}.json`), JSON.stringify({
        id, from_agent: 'forge', created_at: '2026-06-29T20:00:00.000Z',
        request_type: 'screenshot_report', description: 'd',
        context: { url: 'https://notion.so/foo' },
        result_destination: { type: 'agent_inbox', agent: 'forge' },
      }));
      const r = executorTick({ ctxRoot: tmp, bridgePaths, log: () => {}, oneShot: true });
      expect(r.signature_failed).toBe(1);
      expect(existsSync(join(bridgePaths.failed, `${id}.json`))).toBe(true);
      const wrapped = JSON.parse(readFileSync(join(bridgePaths.failed, `${id}.json`), 'utf-8'));
      expect(wrapped.response.status).toBe('failed');
      expect(wrapped.response.error).toMatch(/M2/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('moves a request with disallowed URL to failed/ with M1 reason (defense-in-depth)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'executor-'));
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      // Manually craft a SIGNED request for a disallowed URL (bypassing
      // outbound.ts's queue-time check, to prove the executor re-checks)
      const id = writeBridgeRequestFile(bridgePaths, tmp, {
        context: { url: 'https://evil.com/exfil' },
      });
      const r = executorTick({ ctxRoot: tmp, bridgePaths, log: () => {}, oneShot: true });
      expect(r.allowlist_failed).toBe(1);
      expect(existsSync(join(bridgePaths.failed, `${id}.json`))).toBe(true);
      const wrapped = JSON.parse(readFileSync(join(bridgePaths.failed, `${id}.json`), 'utf-8'));
      expect(wrapped.response.error).toMatch(/M1/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('processes a valid screenshot_report request → completed/ with Cowork-compatible shape', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'executor-'));
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const fakeAB = makeFakeAgentBrowser(tmp);

      const id = writeBridgeRequestFile(bridgePaths, tmp, {
        request_type: 'screenshot_report',
        context: { url: 'https://notion.so/page' },
      });

      const r = executorTick({
        ctxRoot: tmp,
        bridgePaths,
        agentBrowserBin: fakeAB,
        log: () => {},
        oneShot: true,
      });
      expect(r.executed).toBe(1);

      const completedPath = join(bridgePaths.processed, `${id}.json`);
      expect(existsSync(completedPath)).toBe(true);
      const wrapped = JSON.parse(readFileSync(completedPath, 'utf-8'));
      expect(wrapped.request.id).toBe(id);
      expect(wrapped.response.status).toBe('success');
      expect(wrapped.response.request_id).toBe(id);
      expect(wrapped.response.cowork_session_id).toMatch(/^local-executor-/);
      expect(wrapped.response.result.url_visited).toBe('https://notion.so/page');
      expect(wrapped.response.result.screenshot_path).toMatch(/\.png$/);
      // Original pending file removed
      expect(existsSync(join(bridgePaths.outbound, `${id}.json`))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('processes a valid settings_audit request → returns page_snapshot in result', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'executor-'));
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      const fakeAB = makeFakeAgentBrowser(tmp);

      const id = writeBridgeRequestFile(bridgePaths, tmp, {
        request_type: 'settings_audit',
        context: { url: 'https://notion.so/settings' },
      });

      const r = executorTick({
        ctxRoot: tmp,
        bridgePaths,
        agentBrowserBin: fakeAB,
        log: () => {},
        oneShot: true,
      });
      expect(r.executed).toBe(1);

      const wrapped = JSON.parse(readFileSync(join(bridgePaths.processed, `${id}.json`), 'utf-8'));
      expect(wrapped.response.status).toBe('success');
      expect(wrapped.response.result.extracted_fields.page_snapshot).toContain('Example Domain');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles agent-browser failure gracefully → request goes to failed/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'executor-'));
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      // Fake agent-browser that always exits 1
      const failingAB = join(tmp, 'failing-ab.sh');
      writeFileSync(failingAB, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

      const id = writeBridgeRequestFile(bridgePaths, tmp, {
        request_type: 'screenshot_report',
        context: { url: 'https://notion.so/x' },
      });

      const r = executorTick({
        ctxRoot: tmp,
        bridgePaths,
        agentBrowserBin: failingAB,
        log: () => {},
        oneShot: true,
      });
      expect(r.execution_errors).toBe(1);
      expect(existsSync(join(bridgePaths.failed, `${id}.json`))).toBe(true);
      const wrapped = JSON.parse(readFileSync(join(bridgePaths.failed, `${id}.json`), 'utf-8'));
      expect(wrapped.response.status).toBe('failed');
      expect(wrapped.response.error).toMatch(/agent-browser/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips malformed JSON files (parse_failed counter, file left for janitor)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'executor-'));
    try {
      generateBridgeKey(tmp);
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      mkdirSync(bridgePaths.outbound, { recursive: true });
      writeFileSync(join(bridgePaths.outbound, 'malformed.json'), '{not json');
      const r = executorTick({ ctxRoot: tmp, bridgePaths, log: () => {}, oneShot: true });
      expect(r.parse_failed).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects when bridge signing key absent (no key = no verification possible)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'executor-'));
    try {
      // Do NOT generateBridgeKey — simulate missing key
      const bridgePaths = resolveBridgePaths('/ignored', join(tmp, 'cowork-tasks'));
      mkdirSync(bridgePaths.outbound, { recursive: true });
      writeFileSync(join(bridgePaths.outbound, 'bridge-x.json'), JSON.stringify({
        id: 'bridge-x', from_agent: 'forge', created_at: '2026-06-29T20:00:00.000Z',
        request_type: 'screenshot_report', description: 'd',
        context: { url: 'https://notion.so/x' },
        result_destination: { type: 'agent_inbox', agent: 'forge' },
        sig: 'a'.repeat(64),
      }));
      const r = executorTick({ ctxRoot: tmp, bridgePaths, log: () => {}, oneShot: true });
      expect(r.signature_failed).toBe(1);
      const wrapped = JSON.parse(readFileSync(join(bridgePaths.failed, 'bridge-x.json'), 'utf-8'));
      expect(wrapped.response.error).toMatch(/M2.*key not present/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
