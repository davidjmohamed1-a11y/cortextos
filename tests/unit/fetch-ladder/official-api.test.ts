import { describe, it, expect } from 'vitest';

import {
  OFFICIAL_API_REGISTRY,
  lookupOfficialApi,
  hasCredentialsFor,
} from '../../../src/fetch-ladder/official-api.js';

describe('OFFICIAL_API_REGISTRY', () => {
  it('contains at least the V1 anchor entries', () => {
    const domains = OFFICIAL_API_REGISTRY.map((e) => e.domain);
    expect(domains).toContain('notion.so');
    expect(domains).toContain('github.com');
    expect(domains).toContain('wikipedia.org');
  });

  it('every entry has domain + name + api_base', () => {
    for (const e of OFFICIAL_API_REGISTRY) {
      expect(e.domain).toBeTruthy();
      expect(e.name).toBeTruthy();
      expect(e.api_base).toMatch(/^https?:\/\//);
    }
  });

  it('never stores an actual API key value (auth_env only)', () => {
    for (const e of OFFICIAL_API_REGISTRY) {
      // Spot-check: no field contains a long-looking secret token.
      // (16+ alphanumeric chars in a row is a reasonable secret-shape sniff.)
      const serialized = JSON.stringify(e);
      expect(serialized).not.toMatch(/sk_[A-Za-z0-9]{16,}/);
      expect(serialized).not.toMatch(/ntn_[A-Za-z0-9]{16,}/);
      expect(serialized).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    }
  });
});

describe('lookupOfficialApi', () => {
  it('returns the entry for a known domain', () => {
    const e = lookupOfficialApi('notion.so');
    expect(e?.name).toBe('Notion');
    expect(e?.auth_env).toBe('NOTION_API_KEY');
  });

  it('returns undefined for an unknown domain', () => {
    expect(lookupOfficialApi('never-seen-this.example')).toBeUndefined();
  });
});

describe('hasCredentialsFor', () => {
  it('returns true for keyless APIs', () => {
    const e = lookupOfficialApi('wikipedia.org')!;
    expect(hasCredentialsFor(e)).toBe(true);
  });

  it('returns true for auth-required APIs when env var is set', () => {
    const e = lookupOfficialApi('notion.so')!;
    const orig = process.env[e.auth_env!];
    process.env[e.auth_env!] = 'fake-token';
    try {
      expect(hasCredentialsFor(e)).toBe(true);
    } finally {
      if (orig === undefined) delete process.env[e.auth_env!];
      else process.env[e.auth_env!] = orig;
    }
  });

  it('returns false for auth-required APIs when env var is missing', () => {
    const e = lookupOfficialApi('notion.so')!;
    const orig = process.env[e.auth_env!];
    delete process.env[e.auth_env!];
    try {
      expect(hasCredentialsFor(e)).toBe(false);
    } finally {
      if (orig !== undefined) process.env[e.auth_env!] = orig;
    }
  });
});
