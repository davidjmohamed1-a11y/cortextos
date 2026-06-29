import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  decideLiveness,
  probeAgentLiveness,
  writeLivenessResult,
  STDOUT_STALE_MS,
  HEARTBEAT_STALE_MS,
} from '../../../src/daemon/liveness-probe.js';

describe('decideLiveness — pure level decision', () => {
  it("returns 'dead' when pid_alive is false (regardless of other signals)", () => {
    const r = decideLiveness({ stdout_age_ms: 1000, heartbeat_age_ms: 1000, pid_alive: false });
    expect(r.level).toBe('dead');
  });

  it("returns 'wedged' when both stdout AND heartbeat are stale + pid alive", () => {
    const r = decideLiveness({
      stdout_age_ms: STDOUT_STALE_MS + 1000,
      heartbeat_age_ms: HEARTBEAT_STALE_MS + 1000,
      pid_alive: true,
    });
    expect(r.level).toBe('wedged');
    expect(r.reason).toContain('classic wedge signal');
  });

  it("returns 'stale_heartbeat' when only heartbeat stale + pid alive", () => {
    const r = decideLiveness({
      stdout_age_ms: 1000,
      heartbeat_age_ms: HEARTBEAT_STALE_MS + 1000,
      pid_alive: true,
    });
    expect(r.level).toBe('stale_heartbeat');
  });

  it("returns 'stale_stdout' when only stdout stale + pid alive + heartbeat fresh", () => {
    const r = decideLiveness({
      stdout_age_ms: STDOUT_STALE_MS + 1000,
      heartbeat_age_ms: 1000,
      pid_alive: true,
    });
    expect(r.level).toBe('stale_stdout');
  });

  it("returns 'healthy' when both stdout and heartbeat are fresh", () => {
    const r = decideLiveness({
      stdout_age_ms: 1000,
      heartbeat_age_ms: 1000,
      pid_alive: true,
    });
    expect(r.level).toBe('healthy');
  });

  it("returns 'healthy' when one signal fresh + the other unknown (null)", () => {
    expect(decideLiveness({ stdout_age_ms: 1000, heartbeat_age_ms: null, pid_alive: true }).level).toBe('healthy');
    expect(decideLiveness({ stdout_age_ms: null, heartbeat_age_ms: 1000, pid_alive: true }).level).toBe('healthy');
  });

  it("returns 'unknown' when no signals available + pid alive (first-boot bootstrap)", () => {
    const r = decideLiveness({ stdout_age_ms: null, heartbeat_age_ms: null, pid_alive: true });
    expect(r.level).toBe('unknown');
    expect(r.reason).toContain('first-boot');
  });

  it("does NOT report 'dead' when pid_alive is null (no probe-eligible pid)", () => {
    const r = decideLiveness({ stdout_age_ms: 1000, heartbeat_age_ms: 1000, pid_alive: null });
    expect(r.level).toBe('healthy');
  });

  it('reports stale_stdout with stdout fresh and heartbeat null', () => {
    const r = decideLiveness({ stdout_age_ms: STDOUT_STALE_MS + 1000, heartbeat_age_ms: null, pid_alive: true });
    expect(r.level).toBe('stale_stdout');
  });
});

describe('probeAgentLiveness — filesystem-driven', () => {
  it('returns unknown when no logs or heartbeat exist (genuine first-boot)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'liveness-'));
    try {
      const r = probeAgentLiveness({ agentName: 'nonexistent', ctxRoot: tmp });
      expect(r.level).toBe('unknown');
      expect(r.stdout_age_ms).toBeNull();
      expect(r.heartbeat_age_ms).toBeNull();
      expect(r.pid_alive).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads stdout.log mtime correctly', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'liveness-'));
    try {
      const logDir = join(tmp, 'logs', 'testagent');
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, 'stdout.log'), 'recent activity');
      const r = probeAgentLiveness({ agentName: 'testagent', ctxRoot: tmp });
      expect(r.stdout_age_ms).not.toBeNull();
      expect(r.stdout_age_ms).toBeLessThan(5000); // just-written file
      expect(r.level).toBe('healthy');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('detects wedged: old stdout + old heartbeat + pid alive', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'liveness-'));
    try {
      const logDir = join(tmp, 'logs', 'wedged');
      const stateDir = join(tmp, 'state', 'wedged');
      mkdirSync(logDir, { recursive: true });
      mkdirSync(stateDir, { recursive: true });

      const stdoutFile = join(logDir, 'stdout.log');
      writeFileSync(stdoutFile, 'old stdout');
      const longAgo = new Date(Date.now() - (8 * 60 * 60 * 1000)); // 8h ago
      utimesSync(stdoutFile, longAgo, longAgo);

      const hb = { agent: 'wedged', last_heartbeat: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString() };
      writeFileSync(join(stateDir, 'heartbeat.json'), JSON.stringify(hb));

      const r = probeAgentLiveness({ agentName: 'wedged', ctxRoot: tmp, ptyPid: process.pid });
      expect(r.level).toBe('wedged');
      expect(r.pid_alive).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('detects dead: pid not alive', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'liveness-'));
    try {
      // Use a likely-dead pid (extremely high, unlikely to be assigned)
      const r = probeAgentLiveness({ agentName: 'dead', ctxRoot: tmp, ptyPid: 999999 });
      expect(r.level).toBe('dead');
      expect(r.pid_alive).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles malformed heartbeat.json gracefully (returns null age, not error)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'liveness-'));
    try {
      const stateDir = join(tmp, 'state', 'broken');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'heartbeat.json'), 'not valid json');
      const r = probeAgentLiveness({ agentName: 'broken', ctxRoot: tmp });
      expect(r.heartbeat_age_ms).toBeNull();
      // No stdout, no heartbeat → unknown
      expect(r.level).toBe('unknown');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles heartbeat with missing last_heartbeat field (returns null age)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'liveness-'));
    try {
      const stateDir = join(tmp, 'state', 'partial');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'heartbeat.json'), JSON.stringify({ agent: 'partial' }));
      const r = probeAgentLiveness({ agentName: 'partial', ctxRoot: tmp });
      expect(r.heartbeat_age_ms).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to timestamp field when last_heartbeat absent (legacy schema)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'liveness-'));
    try {
      const stateDir = join(tmp, 'state', 'legacy');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'heartbeat.json'), JSON.stringify({
        agent: 'legacy',
        timestamp: new Date().toISOString(),
      }));
      const r = probeAgentLiveness({ agentName: 'legacy', ctxRoot: tmp });
      expect(r.heartbeat_age_ms).not.toBeNull();
      expect(r.heartbeat_age_ms).toBeLessThan(5000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('writeLivenessResult', () => {
  it('writes liveness.json atomically to <ctxRoot>/state/<agent>/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'liveness-write-'));
    try {
      const result = probeAgentLiveness({ agentName: 'writer', ctxRoot: tmp });
      writeLivenessResult({ agentName: 'writer', ctxRoot: tmp }, result);
      const path = join(tmp, 'state', 'writer', 'liveness.json');
      const fs = require('fs');
      expect(fs.existsSync(path)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(path, 'utf-8'));
      expect(parsed.level).toBeDefined();
      expect(parsed.probed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
