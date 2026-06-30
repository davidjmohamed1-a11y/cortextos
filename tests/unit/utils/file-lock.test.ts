import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { acquireFileLock, releaseFileLock, isStaleLock } from '../../../src/utils/file-lock.js';

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), 'file-lock-'));
}

describe('acquireFileLock / releaseFileLock — basics', () => {
  it('acquires + releases successfully when no lock exists', () => {
    const tmp = freshTmp();
    try {
      const target = join(tmp, 'state.json');
      const handle = acquireFileLock(target);
      expect(handle.released).toBe(false);
      expect(existsSync(`${target}.lock`)).toBe(true);
      const payload = JSON.parse(readFileSync(`${target}.lock`, 'utf-8'));
      expect(payload.pid).toBe(process.pid);
      releaseFileLock(handle);
      expect(handle.released).toBe(true);
      expect(existsSync(`${target}.lock`)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('release is idempotent — calling twice is safe', () => {
    const tmp = freshTmp();
    try {
      const handle = acquireFileLock(join(tmp, 's.json'));
      releaseFileLock(handle);
      expect(() => releaseFileLock(handle)).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to delete a lock now held by another PID', () => {
    const tmp = freshTmp();
    try {
      const target = join(tmp, 's.json');
      const handle = acquireFileLock(target);
      // Simulate another process taking over: overwrite the lock file payload
      writeFileSync(`${target}.lock`, JSON.stringify({ pid: 99999, acquired_at: new Date().toISOString() }));
      releaseFileLock(handle);
      // Other-PID lock should still be there
      expect(existsSync(`${target}.lock`)).toBe(true);
      // Cleanup
      rmSync(`${target}.lock`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('acquireFileLock — contention', () => {
  it('times out when another live lock exists', () => {
    const tmp = freshTmp();
    try {
      const target = join(tmp, 's.json');
      // Write a "live" lock owned by THIS process (so isPidAlive = true)
      writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      const start = Date.now();
      expect(() => acquireFileLock(target, { timeoutMs: 200, retryIntervalMs: 50 }))
        .toThrow(/timeout/);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(190);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('force-releases a stale lock (PID dead) and re-acquires', () => {
    const tmp = freshTmp();
    try {
      const target = join(tmp, 's.json');
      // Write a lock owned by a definitely-dead PID (1 = init; we cannot kill 1 anyway, but pid 99999 below)
      writeFileSync(`${target}.lock`, JSON.stringify({ pid: 99999, acquired_at: new Date().toISOString() }));
      const handle = acquireFileLock(target, { timeoutMs: 500, retryIntervalMs: 50 });
      expect(handle.pid).toBe(process.pid);
      releaseFileLock(handle);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('force-releases a lock older than staleThresholdMs', () => {
    const tmp = freshTmp();
    try {
      const target = join(tmp, 's.json');
      // Live PID (own) + old mtime via direct write
      writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, acquired_at: '2020-01-01T00:00:00.000Z' }));
      // Backdate mtime to 1 hour ago
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      require('fs').utimesSync(`${target}.lock`, new Date(oneHourAgo), new Date(oneHourAgo));
      const handle = acquireFileLock(target, { timeoutMs: 500, retryIntervalMs: 50, staleThresholdMs: 30 * 60 * 1000 });
      expect(handle.pid).toBe(process.pid);
      releaseFileLock(handle);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('isStaleLock', () => {
  it('returns false on missing lock file', () => {
    expect(isStaleLock('/tmp/never-existed.lock', 1000)).toBe(false);
  });

  it('returns true when PID is dead', () => {
    const tmp = freshTmp();
    try {
      const lockPath = join(tmp, 's.json.lock');
      writeFileSync(lockPath, JSON.stringify({ pid: 99999, acquired_at: new Date().toISOString() }));
      expect(isStaleLock(lockPath, 10 * 60 * 1000)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns false when PID is alive + recent', () => {
    const tmp = freshTmp();
    try {
      const lockPath = join(tmp, 's.json.lock');
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      expect(isStaleLock(lockPath, 10 * 60 * 1000)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns true when older than staleThresholdMs even with live PID', () => {
    const tmp = freshTmp();
    try {
      const lockPath = join(tmp, 's.json.lock');
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquired_at: new Date(0).toISOString() }));
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      require('fs').utimesSync(lockPath, new Date(oneHourAgo), new Date(oneHourAgo));
      expect(isStaleLock(lockPath, 30 * 60 * 1000)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
