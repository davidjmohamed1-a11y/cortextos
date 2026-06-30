/**
 * Advisory file lock — single-writer enforcement for cross-process state.
 *
 * Used by the bridge relays (outbound + inbound) to ensure only one tick
 * mutates state at a time. Operator-initiated `cortextos bus bridge-*-tick`
 * runs and the daemon-scheduled tick cannot collide.
 *
 * Mechanism: `O_CREAT | O_EXCL` open on `<path>.lock` — atomic on POSIX
 * filesystems. The lock file records the owning PID + start time so a
 * crashed/orphaned lock can be detected + force-released after a staleness
 * threshold (default 10 min).
 *
 * Advisory: lock file presence is a CONVENTION. Code that doesn't call
 * `acquireFileLock` won't be blocked. Both bridge tick paths (CLI + daemon)
 * call it; that's the contract.
 */

import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'fs';

export interface FileLockHandle {
  /** Path to the lock file (parent path + '.lock'). */
  lockPath: string;
  /** PID that holds this handle. */
  pid: number;
  /** ISO timestamp when the lock was acquired. */
  acquired_at: string;
  /** True once releaseFileLock has been called. */
  released: boolean;
}

export interface AcquireFileLockOptions {
  /** How long to wait for the lock before giving up. Default 5_000ms. */
  timeoutMs?: number;
  /** Retry interval. Default 100ms. */
  retryIntervalMs?: number;
  /** Force-release a lock older than this. Default 10 min. */
  staleThresholdMs?: number;
  /** Override Date.now / process.pid (testing). */
  now?: () => Date;
  pid?: number;
}

/**
 * Lock file payload — written immediately after the exclusive open.
 */
interface LockFileContents {
  pid: number;
  acquired_at: string;
}

/**
 * Attempt to acquire an advisory lock on `<targetPath>.lock`. Returns the
 * handle on success, throws on timeout. Stale-lock detection: if the
 * existing lock's PID is no longer alive, OR its `acquired_at` is older than
 * `staleThresholdMs`, the lock is force-removed and re-acquired.
 */
export function acquireFileLock(
  targetPath: string,
  opts: AcquireFileLockOptions = {},
): FileLockHandle {
  const lockPath = `${targetPath}.lock`;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 100;
  const staleThresholdMs = opts.staleThresholdMs ?? 10 * 60 * 1000;
  const nowFn = opts.now ?? (() => new Date());
  const ownPid = opts.pid ?? process.pid;
  const deadline = nowFn().getTime() + timeoutMs;

  // Block-wait loop, polling. Tight but tests can pass a very small retry
  // interval to keep test wall-clock low.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Try to create the lock file exclusively.
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      const acquiredAt = nowFn().toISOString();
      const payload: LockFileContents = { pid: ownPid, acquired_at: acquiredAt };
      writeSync(fd, JSON.stringify(payload));
      closeSync(fd);
      return { lockPath, pid: ownPid, acquired_at: acquiredAt, released: false };
    } catch (err: any) {
      if (err.code !== 'EEXIST') {
        throw new Error(`acquireFileLock: unexpected error creating ${lockPath}: ${err.message}`);
      }
    }

    // Lock exists — check if it's stale.
    if (isStaleLock(lockPath, staleThresholdMs, nowFn)) {
      // Force-remove stale lock + retry immediately.
      try { unlinkSync(lockPath); } catch { /* race: someone else freed it */ }
      continue;
    }

    // Live lock held by another process — wait + retry.
    if (nowFn().getTime() >= deadline) {
      const owner = readLockOwnerSafe(lockPath);
      throw new Error(
        `acquireFileLock: timeout waiting for ${lockPath}` +
        (owner ? ` (held by pid=${owner.pid}, acquired_at=${owner.acquired_at})` : ''),
      );
    }
    // Sleep retryIntervalMs without async (this is sync-only by design).
    sleepSyncMs(retryIntervalMs);
  }
}

/**
 * Release a previously-acquired lock. Idempotent: calling twice is safe.
 * Best-effort: if the lock file was already removed (e.g. by stale cleanup
 * after this process crashed mid-tick), no error.
 */
export function releaseFileLock(handle: FileLockHandle): void {
  if (handle.released) return;
  handle.released = true;
  try {
    // Defensive: only unlink if the lock still belongs to us.
    if (existsSync(handle.lockPath)) {
      const owner = readLockOwnerSafe(handle.lockPath);
      if (!owner || owner.pid === handle.pid) {
        unlinkSync(handle.lockPath);
      }
      // If the lock is held by someone else (we got stale-released), do not
      // disturb their lock.
    }
  } catch {
    // Ignore; best-effort.
  }
}

/**
 * Returns true if a lock file at `lockPath` is older than `staleThresholdMs`
 * OR is owned by a PID that no longer exists. Safe on missing / unreadable
 * lock files (returns false — treat as not stale, caller will retry).
 */
export function isStaleLock(
  lockPath: string,
  staleThresholdMs: number,
  nowFn: () => Date = () => new Date(),
): boolean {
  let stat;
  try {
    stat = statSync(lockPath);
  } catch {
    return false; // file vanished; let caller retry the open.
  }
  const ageMs = nowFn().getTime() - stat.mtimeMs;
  if (ageMs > staleThresholdMs) return true;

  const owner = readLockOwnerSafe(lockPath);
  if (!owner) return false; // unreadable — be conservative, treat as live.
  if (!isPidAlive(owner.pid)) return true;
  return false;
}

function readLockOwnerSafe(lockPath: string): LockFileContents | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as LockFileContents;
    if (typeof parsed.pid !== 'number' || typeof parsed.acquired_at !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0 || !isFinite(pid)) return false;
  try {
    // Sending signal 0 = "is this PID alive?" — throws ESRCH if not.
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM'; // EPERM = exists but not ours — still alive.
  }
}

function sleepSyncMs(ms: number): void {
  // Tight sync sleep — Atomics.wait on a SharedArrayBuffer is the cleanest
  // way, no busy-loop CPU burn.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, Math.max(0, ms));
}
