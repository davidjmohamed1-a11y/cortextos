import { describe, it, expect, beforeEach } from 'vitest';

import {
  fetchFromWayback,
  fetchFromArchiveToday,
  fetchFromArchive,
  fetchWaybackHistory,
  resetArchiveTodayCounter,
  ARCHIVE_TODAY_DAILY_BYTES_CAP,
} from '../../../src/fetch-ladder/archive.js';

beforeEach(() => {
  resetArchiveTodayCounter();
});

describe('fetchFromWayback', () => {
  it('returns snapshot URL when Wayback has a snapshot', async () => {
    const mockFetch = async () => new Response(JSON.stringify({
      archived_snapshots: {
        closest: {
          available: true,
          url: 'https://web.archive.org/web/20260101/https://example.com/',
          timestamp: '20260101',
        },
      },
    }), { status: 200 });
    const r = await fetchFromWayback('https://example.com/', { fetcher: mockFetch as any });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('wayback');
    expect(r.snapshot_url).toContain('web.archive.org');
    expect(r.snapshot_timestamp).toBe('20260101');
  });

  it('returns ok=false when no snapshot exists', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ archived_snapshots: {} }), { status: 200 });
    const r = await fetchFromWayback('https://example.com/', { fetcher: mockFetch as any });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no Wayback snapshot/);
  });

  it('returns ok=false on availability API HTTP error', async () => {
    const mockFetch = async () => new Response('', { status: 500 });
    const r = await fetchFromWayback('https://example.com/', { fetcher: mockFetch as any });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });

  it('returns ok=false on network error', async () => {
    const mockFetch = async () => { throw new Error('econnreset'); };
    const r = await fetchFromWayback('https://example.com/', { fetcher: mockFetch as any });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/econnreset/);
  });
});

describe('fetchFromArchiveToday', () => {
  it('returns snapshot URL from Location header on 302', async () => {
    const mockFetch = async () => new Response('', {
      status: 302,
      headers: { location: 'https://archive.ph/abc123' },
    });
    const r = await fetchFromArchiveToday('https://example.com/', { fetcher: mockFetch as any });
    expect(r.ok).toBe(true);
    expect(r.snapshot_url).toBe('https://archive.ph/abc123');
  });

  it('returns inline body on 200', async () => {
    const mockFetch = async () => new Response('snapshot content', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const r = await fetchFromArchiveToday('https://example.com/', { fetcher: mockFetch as any });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('snapshot content');
  });

  it('skips when daily byte cap is already exceeded', async () => {
    const mockFetch = async () => new Response('x'.repeat(100), { status: 200 });
    // Force the counter past the cap by setting a tiny override
    const r1 = await fetchFromArchiveToday('https://a.com/', { fetcher: mockFetch as any, bytesCapOverride: 1 });
    expect(r1.ok).toBe(true); // first call succeeds + bumps counter past override-1
    const r2 = await fetchFromArchiveToday('https://b.com/', { fetcher: mockFetch as any, bytesCapOverride: 1 });
    expect(r2.ok).toBe(false);
    expect(r2.skipped).toMatch(/cap exceeded/);
  });

  it('returns ok=false on transport error', async () => {
    const mockFetch = async () => { throw new Error('timeout'); };
    const r = await fetchFromArchiveToday('https://example.com/', { fetcher: mockFetch as any });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/);
  });
});

describe('fetchFromArchive (Wayback first, archive.today fallback)', () => {
  it('returns Wayback snapshot when available', async () => {
    const mockFetch = async () => new Response(JSON.stringify({
      archived_snapshots: {
        closest: { available: true, url: 'https://web.archive.org/x', timestamp: '20260101' },
      },
    }), { status: 200 });
    const r = await fetchFromArchive('https://example.com/', { fetcher: mockFetch as any });
    expect(r.source).toBe('wayback');
    expect(r.ok).toBe(true);
  });

  it('falls back to archive.today when Wayback misses', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        // Wayback availability: no snapshot
        return new Response(JSON.stringify({ archived_snapshots: {} }), { status: 200 });
      }
      // archive.today timegate: 302 with Location
      return new Response('', { status: 302, headers: { location: 'https://archive.ph/xyz' } });
    };
    const r = await fetchFromArchive('https://example.com/', { fetcher: mockFetch as any });
    expect(r.source).toBe('archive.today');
    expect(r.snapshot_url).toBe('https://archive.ph/xyz');
  });

  it('returns ok=false when both backends fail', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ archived_snapshots: {} }), { status: 200 });
    // First call = Wayback (returns no snapshot), second call = archive.today (also fails)
    let callCount = 0;
    const mock = async () => {
      callCount += 1;
      if (callCount === 1) return new Response(JSON.stringify({ archived_snapshots: {} }), { status: 200 });
      return new Response('', { status: 500 });
    };
    const r = await fetchFromArchive('https://example.com/', { fetcher: mock as any });
    expect(r.ok).toBe(false);
  });
});

describe('fetchWaybackHistory', () => {
  it('parses CDX rows into newest-first entries', async () => {
    const mockFetch = async () => new Response(JSON.stringify([
      ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
      ['com,example)/', '20250101', 'https://example.com/', 'text/html', '200', 'abc', '1234'],
      ['com,example)/', '20260101', 'https://example.com/', 'text/html', '200', 'def', '1235'],
    ]), { status: 200 });
    const r = await fetchWaybackHistory('https://example.com/', { fetcher: mockFetch as any });
    expect(r.ok).toBe(true);
    expect(r.entries.length).toBe(2);
    expect(r.entries[0].timestamp).toBe('20260101'); // newest first
    expect(r.entries[0].snapshot_url).toContain('web.archive.org/web/20260101');
  });

  it('returns ok=false on HTTP error', async () => {
    const mockFetch = async () => new Response('', { status: 503 });
    const r = await fetchWaybackHistory('https://example.com/', { fetcher: mockFetch as any });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP 503/);
  });
});
