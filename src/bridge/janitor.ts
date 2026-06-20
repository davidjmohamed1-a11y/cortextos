/**
 * Bridge — Janitor (stale request sweep + retention housekeeping)
 *
 * Periodic sweep, intended to run on a 4h cron (matches Cowork's expected
 * scheduled cadence):
 *
 * 1. For each file in pending/ older than `staleAfter` (default 24h):
 *    move to failed/, append a stale-log entry. These are requests Cowork
 *    never picked up — likely the listener Cowork session was paused or
 *    crashed. The first stale-sweep that finds any will send boss-personal
 *    a heads-up message (caller's responsibility to wire — janitor just
 *    returns counts).
 *
 * 2. For each file in completed/ older than 30 days: delete (retention).
 *
 * 3. For each file in failed/ older than 90 days: delete (longer retention
 *    for forensic value).
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { ensureDir } from '../utils/atomic.js';
import type { BridgePaths, BridgeConfig, BridgeRequest } from './types.js';

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000; // 24h
const COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const FAILED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90d

export interface JanitorSweepResult {
  timed_out: number;
  retained_completed: number;
  retained_failed: number;
  deleted_completed: number;
  deleted_failed: number;
  errors: Array<{ file: string; reason: string }>;
}

function parseStaleAfter(raw?: string): number {
  if (!raw) return DEFAULT_STALE_MS;
  // Simple parser: "24h", "30m", "2d", "3600s". Falls back to default on parse fail.
  const match = /^(\d+)([smhd])$/.exec(raw.trim());
  if (!match) return DEFAULT_STALE_MS;
  const n = Number(match[1]);
  const unit = match[2];
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * (mult[unit] ?? 3_600_000);
}

export function sweepBridge(paths: BridgePaths, config: BridgeConfig = {}): JanitorSweepResult {
  const result: JanitorSweepResult = {
    timed_out: 0,
    retained_completed: 0,
    retained_failed: 0,
    deleted_completed: 0,
    deleted_failed: 0,
    errors: [],
  };
  const now = Date.now();
  const staleMs = parseStaleAfter(config.staleAfter);

  // 1. Stale pending → failed
  if (existsSync(paths.outbound)) {
    ensureDir(paths.failed);
    let entries: string[] = [];
    try {
      entries = readdirSync(paths.outbound).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    } catch (err) {
      result.errors.push({ file: paths.outbound, reason: (err as Error).message });
    }
    for (const file of entries) {
      const src = join(paths.outbound, file);
      try {
        // Prefer the request's own created_at (resilient to filesystem mtime drift on OneDrive sync)
        let createdAtMs: number;
        try {
          const req: BridgeRequest = JSON.parse(readFileSync(src, 'utf-8'));
          createdAtMs = Date.parse(req.created_at);
          if (Number.isNaN(createdAtMs)) throw new Error('invalid created_at');
        } catch {
          const stat = statSync(src);
          createdAtMs = stat.mtimeMs;
        }
        if (now - createdAtMs >= staleMs) {
          renameSync(src, join(paths.failed, file));
          result.timed_out++;
        }
      } catch (err) {
        result.errors.push({ file: src, reason: (err as Error).message });
      }
    }
  }

  // 2. Completed retention (30d delete)
  if (existsSync(paths.processed)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(paths.processed).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    } catch (err) {
      result.errors.push({ file: paths.processed, reason: (err as Error).message });
    }
    for (const file of entries) {
      const src = join(paths.processed, file);
      try {
        const stat = statSync(src);
        if (now - stat.mtimeMs >= COMPLETED_RETENTION_MS) {
          unlinkSync(src);
          result.deleted_completed++;
        } else {
          result.retained_completed++;
        }
      } catch (err) {
        result.errors.push({ file: src, reason: (err as Error).message });
      }
    }
  }

  // 3. Failed retention (90d delete)
  if (existsSync(paths.failed)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(paths.failed).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    } catch (err) {
      result.errors.push({ file: paths.failed, reason: (err as Error).message });
    }
    for (const file of entries) {
      const src = join(paths.failed, file);
      try {
        const stat = statSync(src);
        if (now - stat.mtimeMs >= FAILED_RETENTION_MS) {
          unlinkSync(src);
          result.deleted_failed++;
        } else {
          result.retained_failed++;
        }
      } catch (err) {
        result.errors.push({ file: src, reason: (err as Error).message });
      }
    }
  }

  return result;
}
