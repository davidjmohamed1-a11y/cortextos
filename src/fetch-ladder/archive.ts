/**
 * Rung 4 — Web archives.
 *
 * Two backends:
 *   1. Wayback Machine (archive.org) — availability + CDX
 *      - GET https://archive.org/wayback/available?url=<URL>[&timestamp=YYYYMMDD]
 *        returns { archived_snapshots: { closest: { url, timestamp, status } } }
 *      - GET https://web.archive.org/cdx/search/cdx?url=<URL>&output=json&limit=N
 *        returns a CSV-like JSON for snapshot history
 *
 *   2. archive.today (archive.ph / archive.is) via Memento Timegate
 *      - GET https://archive.ph/timegate/<URL>  (302 → snapshot URL)
 *      - Best-effort: archive.today has stricter limits + intermittent
 *        availability; treat as the fallback to Wayback.
 *
 * Both are best-effort. Never throws. The orchestrator records the response
 * URL into facts so the caller can re-fetch the archive itself if needed.
 *
 * Daily byte cap: V1 enforces a soft cap on archive.today bandwidth at
 * ARCHIVE_TODAY_DAILY_BYTES_CAP. Once exceeded, archive.today requests are
 * skipped (returns skipped). Reset is wall-clock daily; cap is per-process
 * since we don't have a shared counter (the daemon does — see V1.5).
 */

import type { Rung } from './types.js';
import { FETCH_LADDER_USER_AGENT } from './robots.js';

export const RUNG_ARCHIVE: Rung = 4;

/** Soft daily byte cap for archive.today fetches. Wayback is unlimited (best-effort). */
export const ARCHIVE_TODAY_DAILY_BYTES_CAP = 20 * 1024 * 1024; // 20MB/day

let archiveTodayBytesToday = 0;
let archiveTodayDayKey = currentDayKey();

function currentDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function maybeResetArchiveTodayCounter(): void {
  const today = currentDayKey();
  if (today !== archiveTodayDayKey) {
    archiveTodayDayKey = today;
    archiveTodayBytesToday = 0;
  }
}

/** Test-only helper: reset the daily counter explicitly. */
export function resetArchiveTodayCounter(): void {
  archiveTodayBytesToday = 0;
  archiveTodayDayKey = currentDayKey();
}

export interface ArchiveResult {
  ok: boolean;
  source?: 'wayback' | 'archive.today';
  snapshot_url?: string;
  snapshot_timestamp?: string;
  content?: string;
  content_type?: string;
  status?: number;
  skipped?: string;
  error?: string;
}

export interface ArchiveOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Skip Wayback (testing). */
  skipWayback?: boolean;
  /** Skip archive.today (testing). */
  skipArchiveToday?: boolean;
  /** Override the daily byte counter cap (testing). */
  bytesCapOverride?: number;
}

/**
 * Try Wayback first; fall back to archive.today if Wayback has nothing.
 * Returns the first successful snapshot (or ok=false if both fail).
 */
export async function fetchFromArchive(url: string, opts: ArchiveOptions = {}): Promise<ArchiveResult> {
  if (!opts.skipWayback) {
    const wb = await fetchFromWayback(url, opts);
    if (wb.ok) return wb;
  }
  if (!opts.skipArchiveToday) {
    return fetchFromArchiveToday(url, opts);
  }
  return { ok: false, error: 'all archive backends skipped' };
}

export async function fetchFromWayback(url: string, opts: ArchiveOptions = {}): Promise<ArchiveResult> {
  const fetchFn = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const availUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(availUrl, {
      headers: { 'User-Agent': FETCH_LADDER_USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, source: 'wayback', status: resp.status, error: `Wayback availability HTTP ${resp.status}` };
    }
    const body = await resp.json() as any;
    const closest = body?.archived_snapshots?.closest;
    if (!closest || !closest.url || closest.available !== true) {
      return { ok: false, source: 'wayback', error: 'no Wayback snapshot' };
    }
    return {
      ok: true,
      source: 'wayback',
      snapshot_url: closest.url,
      snapshot_timestamp: closest.timestamp,
      status: 200,
    };
  } catch (err: any) {
    return { ok: false, source: 'wayback', error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFromArchiveToday(url: string, opts: ArchiveOptions = {}): Promise<ArchiveResult> {
  maybeResetArchiveTodayCounter();
  const cap = opts.bytesCapOverride ?? ARCHIVE_TODAY_DAILY_BYTES_CAP;
  if (archiveTodayBytesToday >= cap) {
    return { ok: false, source: 'archive.today', skipped: `daily byte cap exceeded (${cap}B)` };
  }
  const fetchFn = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // Memento timegate: returns 302 to the snapshot URL
  const timegate = `https://archive.ph/timegate/${url}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(timegate, {
      headers: {
        'User-Agent': FETCH_LADDER_USER_AGENT,
        Accept: 'text/html',
      },
      redirect: 'manual', // we want to capture the snapshot URL from Location
      signal: ctrl.signal,
    });
    // The timegate may return 200 (already on snapshot) or 30x with Location.
    const loc = resp.headers.get('location');
    if (loc) {
      return { ok: true, source: 'archive.today', snapshot_url: loc, status: resp.status };
    }
    if (resp.ok) {
      // Direct response: archive.today returned the snapshot inline.
      const body = await resp.text();
      archiveTodayBytesToday += body.length;
      return {
        ok: true,
        source: 'archive.today',
        snapshot_url: timegate,
        content: body,
        status: resp.status,
        content_type: resp.headers.get('content-type') ?? undefined,
      };
    }
    return { ok: false, source: 'archive.today', status: resp.status, error: `archive.today HTTP ${resp.status}` };
  } catch (err: any) {
    return { ok: false, source: 'archive.today', error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query the Wayback CDX API for snapshot history of a URL. Returns up to
 * `limit` entries (newest first). Useful for "what did this page say in 2024?"
 * style queries from the orchestrator.
 */
export interface CdxEntry {
  timestamp: string;
  snapshot_url: string;
  status?: string;
}

export async function fetchWaybackHistory(
  url: string,
  opts: ArchiveOptions & { limit?: number } = {},
): Promise<{ ok: boolean; entries: CdxEntry[]; error?: string }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=-${limit}`;
  const fetchFn = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(cdxUrl, {
      headers: { 'User-Agent': FETCH_LADDER_USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, entries: [], error: `CDX HTTP ${resp.status}` };
    }
    const body = await resp.json() as any[][];
    // CDX returns [[header], [timestamp, original, mimetype, statuscode, digest, length], ...]
    const rows = Array.isArray(body) && body.length > 1 ? body.slice(1) : [];
    const entries: CdxEntry[] = rows
      .filter((r) => Array.isArray(r) && r.length >= 2)
      .map((r) => ({
        timestamp: r[1] as string,
        snapshot_url: `https://web.archive.org/web/${r[1]}/${r[2]}`,
        status: r[4] as string | undefined,
      }))
      .reverse(); // newest first
    return { ok: true, entries };
  } catch (err: any) {
    return { ok: false, entries: [], error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}
