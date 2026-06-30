import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  registrableDomain,
  emptyPolicy,
  loadSitePolicy,
  saveSitePolicy,
  isPolicyStale,
  recordSuccess,
  recordFailure,
  listSitePolicies,
  forgetSitePolicy,
  sitePolicyDir,
} from '../../../src/fetch-ladder/site-policy.js';
import { RUNG_BLOCK_THRESHOLD } from '../../../src/fetch-ladder/types.js';

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), 'site-policy-test-'));
}

describe('registrableDomain', () => {
  it('strips leading www.', () => {
    expect(registrableDomain('www.notion.so')).toBe('notion.so');
  });
  it('keeps two-label domains as-is', () => {
    expect(registrableDomain('notion.so')).toBe('notion.so');
  });
  it('trims multi-label subdomains to last 2 labels', () => {
    expect(registrableDomain('docs.api.notion.so')).toBe('notion.so');
  });
  it('handles UK co.uk public suffix → keeps 3 labels', () => {
    expect(registrableDomain('mysite.co.uk')).toBe('mysite.co.uk');
    expect(registrableDomain('blog.mysite.co.uk')).toBe('mysite.co.uk');
  });
  it('handles com.au public suffix → keeps 3 labels', () => {
    expect(registrableDomain('news.example.com.au')).toBe('example.com.au');
  });
  it('lower-cases input', () => {
    expect(registrableDomain('Notion.SO')).toBe('notion.so');
  });
  it('empty string → empty result', () => {
    expect(registrableDomain('')).toBe('');
  });
});

describe('site-policy load / save round-trip', () => {
  it('load on missing entry returns empty policy', () => {
    const tmp = freshTmp();
    try {
      const p = loadSitePolicy(tmp, 'notion.so');
      expect(p.domain).toBe('notion.so');
      expect(p.blocked_rungs).toEqual([]);
      expect(p.best_rung).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('save → load round-trip preserves fields', () => {
    const tmp = freshTmp();
    try {
      const start = emptyPolicy('notion.so');
      start.best_rung = 1;
      start.api = { exists: true, base: 'https://api.notion.com/v1', auth_required: true, auth_env: 'NOTION_API_KEY' };
      saveSitePolicy(tmp, start);
      const loaded = loadSitePolicy(tmp, 'notion.so');
      expect(loaded.best_rung).toBe(1);
      expect(loaded.api?.exists).toBe(true);
      expect(loaded.api?.auth_env).toBe('NOTION_API_KEY');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('load on corrupt JSON returns empty policy (no throw)', () => {
    const tmp = freshTmp();
    try {
      mkdirSync(sitePolicyDir(tmp), { recursive: true });
      writeFileSync(join(sitePolicyDir(tmp), 'broken.com.json'), '{ not json');
      const p = loadSitePolicy(tmp, 'broken.com');
      expect(p.domain).toBe('broken.com');
      expect(p.blocked_rungs).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('save stamps updated_at', () => {
    const tmp = freshTmp();
    try {
      const p = emptyPolicy('notion.so');
      const before = new Date('2026-06-30T10:00:00.000Z');
      saveSitePolicy(tmp, p, before);
      const loaded = loadSitePolicy(tmp, 'notion.so');
      expect(loaded.updated_at).toBe(before.toISOString());
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('isPolicyStale', () => {
  it('returns true for a never-updated policy (epoch updated_at)', () => {
    expect(isPolicyStale(emptyPolicy('notion.so'))).toBe(true);
  });

  it('returns false for a freshly-stamped policy', () => {
    const p = emptyPolicy('notion.so');
    p.updated_at = new Date().toISOString();
    expect(isPolicyStale(p)).toBe(false);
  });

  it('returns true once age exceeds ttl_hours', () => {
    const now = new Date('2026-06-30T00:00:00.000Z');
    const p = emptyPolicy('notion.so');
    p.updated_at = new Date('2026-06-20T00:00:00.000Z').toISOString(); // 10 days ago
    p.ttl_hours = 168; // 1 week
    expect(isPolicyStale(p, now)).toBe(true);
  });

  it('returns false within ttl_hours', () => {
    const now = new Date('2026-06-30T00:00:00.000Z');
    const p = emptyPolicy('notion.so');
    p.updated_at = new Date('2026-06-29T00:00:00.000Z').toISOString(); // 24h ago
    p.ttl_hours = 168;
    expect(isPolicyStale(p, now)).toBe(false);
  });
});

describe('recordSuccess', () => {
  it('sets best_rung on first success', () => {
    const p = recordSuccess(emptyPolicy('notion.so'), 1);
    expect(p.best_rung).toBe(1);
    expect(p.last_success?.rung).toBe(1);
  });

  it('promotes best_rung when a lower rung succeeds', () => {
    let p = recordSuccess(emptyPolicy('notion.so'), 3);
    expect(p.best_rung).toBe(3);
    p = recordSuccess(p, 1);
    expect(p.best_rung).toBe(1);
  });

  it('does NOT promote when a higher rung succeeds', () => {
    let p = recordSuccess(emptyPolicy('notion.so'), 1);
    p = recordSuccess(p, 3);
    expect(p.best_rung).toBe(1);
  });

  it('clears fail streak for the succeeding rung', () => {
    let p = recordFailure(emptyPolicy('notion.so'), 2, 'transient');
    expect(p.fail_streak?.[2]).toBe(1);
    p = recordSuccess(p, 2);
    expect(p.fail_streak?.[2]).toBeUndefined();
  });

  it('un-blocks a rehabilitated rung that was previously blocked', () => {
    let p = emptyPolicy('notion.so');
    p.blocked_rungs = [2];
    p = recordSuccess(p, 2);
    expect(p.blocked_rungs).not.toContain(2);
  });
});

describe('recordFailure', () => {
  it('increments fail_streak for the rung', () => {
    let p = recordFailure(emptyPolicy('notion.so'), 2, 'transport timeout');
    expect(p.fail_streak?.[2]).toBe(1);
    expect(p.last_fail?.reason).toBe('transport timeout');
    p = recordFailure(p, 2, 'transport timeout');
    expect(p.fail_streak?.[2]).toBe(2);
  });

  it(`blocks rung after ${RUNG_BLOCK_THRESHOLD} consecutive failures`, () => {
    let p = emptyPolicy('notion.so');
    for (let i = 0; i < RUNG_BLOCK_THRESHOLD; i++) {
      p = recordFailure(p, 2, 'still broken');
    }
    expect(p.blocked_rungs).toContain(2);
  });

  it('does NOT double-add already-blocked rung', () => {
    let p = emptyPolicy('notion.so');
    for (let i = 0; i < RUNG_BLOCK_THRESHOLD + 5; i++) {
      p = recordFailure(p, 2, 'still broken');
    }
    expect(p.blocked_rungs.filter((r) => r === 2).length).toBe(1);
  });
});

describe('listSitePolicies + forgetSitePolicy', () => {
  it('lists empty when no entries', () => {
    const tmp = freshTmp();
    try {
      expect(listSitePolicies(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('lists saved domains sorted alphabetically', () => {
    const tmp = freshTmp();
    try {
      saveSitePolicy(tmp, emptyPolicy('notion.so'));
      saveSitePolicy(tmp, emptyPolicy('apple.com'));
      saveSitePolicy(tmp, emptyPolicy('google.com'));
      expect(listSitePolicies(tmp)).toEqual(['apple.com', 'google.com', 'notion.so']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('forgetSitePolicy removes an existing entry, returns true', () => {
    const tmp = freshTmp();
    try {
      saveSitePolicy(tmp, emptyPolicy('notion.so'));
      expect(forgetSitePolicy(tmp, 'notion.so')).toBe(true);
      expect(existsSync(join(sitePolicyDir(tmp), 'notion.so.json'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('forgetSitePolicy returns false on a non-existent domain', () => {
    const tmp = freshTmp();
    try {
      expect(forgetSitePolicy(tmp, 'never-saved.com')).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
