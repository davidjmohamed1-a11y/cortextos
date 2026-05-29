import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { refreshHeartbeatTimestamp } from '../../../src/bus/heartbeat';
import type { Heartbeat } from '../../../src/types';

describe('refreshHeartbeatTimestamp', () => {
  let testDir: string;
  let stateDir: string;
  let hbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-hb-test-'));
    stateDir = join(testDir, 'state', 'forge');
    mkdirSync(stateDir, { recursive: true });
    hbPath = join(stateDir, 'heartbeat.json');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('bumps last_heartbeat and preserves every other field', () => {
    const original: Heartbeat = {
      agent: 'forge',
      org: 'personal',
      display_name: 'Forge',
      status: 'working on task_abc',
      current_task: 'task_abc',
      mode: 'day',
      last_heartbeat: '2026-05-29T10:00:00Z',
      loop_interval: '4h',
    };
    writeFileSync(hbPath, JSON.stringify(original));

    const newer = '2026-05-29T16:35:00Z';
    refreshHeartbeatTimestamp(stateDir, newer);

    const after = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    expect(after.last_heartbeat).toBe(newer);
    expect(after.agent).toBe('forge');
    expect(after.org).toBe('personal');
    expect(after.display_name).toBe('Forge');
    expect(after.status).toBe('working on task_abc');
    expect(after.current_task).toBe('task_abc');
    expect(after.mode).toBe('day');
    expect(after.loop_interval).toBe('4h');
  });

  it('strips millisecond precision when an ISO string with ms is supplied', () => {
    const original: Heartbeat = {
      agent: 'forge', org: 'personal', status: 's', current_task: '',
      mode: 'day', last_heartbeat: '2026-05-29T10:00:00Z', loop_interval: '',
    };
    writeFileSync(hbPath, JSON.stringify(original));

    refreshHeartbeatTimestamp(stateDir, '2026-05-29T16:35:42.123Z');

    const after = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    expect(after.last_heartbeat).toBe('2026-05-29T16:35:42Z');
  });

  it('defaults to current time when no timestamp is supplied', () => {
    const original: Heartbeat = {
      agent: 'forge', org: 'personal', status: 's', current_task: '',
      mode: 'day', last_heartbeat: '2026-05-29T10:00:00Z', loop_interval: '',
    };
    writeFileSync(hbPath, JSON.stringify(original));

    const before = Date.now();
    refreshHeartbeatTimestamp(stateDir);
    const after = Date.now();

    const result = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    const writtenMs = new Date(result.last_heartbeat).getTime();
    expect(writtenMs).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(writtenMs).toBeLessThanOrEqual(after + 1000);
  });

  it('is a no-op when the heartbeat file does not exist', () => {
    expect(existsSync(hbPath)).toBe(false);
    expect(() => refreshHeartbeatTimestamp(stateDir)).not.toThrow();
    expect(existsSync(hbPath)).toBe(false);
  });

  it('is a no-op when the heartbeat file is malformed JSON', () => {
    writeFileSync(hbPath, 'not json at all');
    expect(() => refreshHeartbeatTimestamp(stateDir, '2026-05-29T16:35:00Z')).not.toThrow();
    // File is left as-is — the bad content is preserved rather than clobbered.
    expect(readFileSync(hbPath, 'utf-8')).toBe('not json at all');
  });
});
