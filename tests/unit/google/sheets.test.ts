import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateKeyPairSync, createVerify } from 'crypto';
import { GoogleSheetsAPI, loadSheetsClientFromKeyPath, type ServiceAccountKey } from '../../../src/google/sheets';

// A throwaway RSA key generated per-test-file so the JWT signs without
// pulling a real Google key into the repo. Generation is ~100ms which is
// fine for a single file's worth of tests.
const { privateKey: TEST_PRIVATE_PEM, publicKey: TEST_PUBLIC_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function makeKey(overrides: Partial<ServiceAccountKey> = {}): ServiceAccountKey {
  return {
    client_email: 'forge-sa@test-project.iam.gserviceaccount.com',
    private_key: TEST_PRIVATE_PEM,
    private_key_id: 'test-kid-001',
    project_id: 'test-project',
    ...overrides,
  };
}

// Decode a base64url-encoded string (JWT segments) back to UTF-8 / Buffer.
function b64urlDecode(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

describe('GoogleSheetsAPI', () => {
  describe('constructor validation', () => {
    it('throws when client_email is missing', () => {
      expect(() => new GoogleSheetsAPI({ client_email: '', private_key: TEST_PRIVATE_PEM }))
        .toThrow(/client_email/);
    });
    it('throws when private_key is missing', () => {
      expect(() => new GoogleSheetsAPI({ client_email: 'x@y.iam.gserviceaccount.com', private_key: '' }))
        .toThrow(/private_key/);
    });
  });

  describe('JWT building', () => {
    it('produces three base64url segments separated by dots', () => {
      const api = new GoogleSheetsAPI(makeKey());
      const jwt = api.buildJwtForTest();
      const segments = jwt.split('.');
      expect(segments).toHaveLength(3);
      // No '+' or '/' or '=' — pure base64url
      for (const seg of segments) {
        expect(seg).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });

    it('header carries alg=RS256, typ=JWT, and kid when private_key_id is set', () => {
      const api = new GoogleSheetsAPI(makeKey());
      const [headerB64] = api.buildJwtForTest().split('.');
      const header = JSON.parse(b64urlDecode(headerB64).toString('utf-8'));
      expect(header.alg).toBe('RS256');
      expect(header.typ).toBe('JWT');
      expect(header.kid).toBe('test-kid-001');
    });

    it('omits kid when private_key_id is not set', () => {
      const api = new GoogleSheetsAPI(makeKey({ private_key_id: undefined }));
      const [headerB64] = api.buildJwtForTest().split('.');
      const header = JSON.parse(b64urlDecode(headerB64).toString('utf-8'));
      expect(header.kid).toBeUndefined();
    });

    it('claims carry iss=client_email, default scope, default aud, iat, exp=iat+3600', () => {
      const api = new GoogleSheetsAPI(makeKey());
      const [, claimsB64] = api.buildJwtForTest().split('.');
      const claims = JSON.parse(b64urlDecode(claimsB64).toString('utf-8'));
      expect(claims.iss).toBe('forge-sa@test-project.iam.gserviceaccount.com');
      expect(claims.scope).toBe('https://www.googleapis.com/auth/spreadsheets');
      expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
      expect(typeof claims.iat).toBe('number');
      expect(claims.exp).toBe(claims.iat + 3600);
    });

    it('signature verifies against the public key', () => {
      const api = new GoogleSheetsAPI(makeKey());
      const jwt = api.buildJwtForTest();
      const [header, claims, sig] = jwt.split('.');
      const verify = createVerify('RSA-SHA256');
      verify.update(`${header}.${claims}`);
      verify.end();
      expect(verify.verify(TEST_PUBLIC_KEY, b64urlDecode(sig))).toBe(true);
    });

    it('honors a custom scope override', () => {
      const api = new GoogleSheetsAPI(makeKey(), { scope: 'https://www.googleapis.com/auth/spreadsheets.readonly' });
      const [, claimsB64] = api.buildJwtForTest().split('.');
      const claims = JSON.parse(b64urlDecode(claimsB64).toString('utf-8'));
      expect(claims.scope).toBe('https://www.googleapis.com/auth/spreadsheets.readonly');
    });
  });

  // -------------------------------------------------------------------------
  // Operation tests with mocked fetch — verify the URL, method, body shape,
  // and that the access token is exchanged on the first call then cached.
  // -------------------------------------------------------------------------
  describe('operations with mocked fetch', () => {
    let calls: Array<{ url: string; init: RequestInit; body: unknown }>;

    function setupFetchMock(responses: Array<{ status: number; body: unknown }>): void {
      calls = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        let bodyParsed: unknown = init?.body ?? null;
        if (typeof init?.body === 'string') {
          try { bodyParsed = JSON.parse(init.body as string); } catch { /* form-encoded — leave as string */ }
        }
        calls.push({ url, init, body: bodyParsed });
        const next = responses.shift();
        if (!next) throw new Error('fetch called with no queued response');
        return {
          ok: next.status >= 200 && next.status < 300,
          status: next.status,
          text: async () => JSON.stringify(next.body),
        } as any;
      }));
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('appendRows exchanges token first, then posts a values:append with USER_ENTERED', async () => {
      setupFetchMock([
        { status: 200, body: { access_token: 'tok-1', expires_in: 3600 } },
        { status: 200, body: { spreadsheetId: 'sheet-x', updates: { updatedRange: 'Sheet1!A2:B2', updatedCells: 2 } } },
      ]);
      const api = new GoogleSheetsAPI(makeKey());
      const r = await api.appendRows('sheet-x', 'Sheet1!A:B', [['a', 'b']]);
      expect(r.updates?.updatedCells).toBe(2);

      // Call 1 — token endpoint
      expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
      expect((calls[0].init.headers as Record<string, string>)['Content-Type'])
        .toBe('application/x-www-form-urlencoded');

      // Call 2 — Sheets API
      expect(calls[1].url).toContain('https://sheets.googleapis.com/v4/spreadsheets/sheet-x/values/');
      expect(calls[1].url).toContain('append');
      expect(calls[1].url).toContain('valueInputOption=USER_ENTERED');
      expect(calls[1].url).toContain('insertDataOption=INSERT_ROWS');
      expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
      expect(calls[1].body).toEqual({ values: [['a', 'b']] });
    });

    it('caches the access token across calls within the lifetime', async () => {
      setupFetchMock([
        { status: 200, body: { access_token: 'tok-cache', expires_in: 3600 } },
        { status: 200, body: { spreadsheetId: 's', updatedCells: 1 } },
        { status: 200, body: { spreadsheetId: 's', updatedCells: 1 } },
      ]);
      const api = new GoogleSheetsAPI(makeKey());
      await api.setCell('s', 'Sheet1!A1', 'one');
      await api.setCell('s', 'Sheet1!A2', 'two');
      // 3 fetch calls: 1 token + 2 sheet writes. Token endpoint hit only once.
      expect(calls.filter(c => c.url.startsWith('https://oauth2.googleapis.com'))).toHaveLength(1);
    });

    it('setCell PUTs to values/<a1> with USER_ENTERED and wraps the value in [[v]]', async () => {
      setupFetchMock([
        { status: 200, body: { access_token: 'tok-2', expires_in: 3600 } },
        { status: 200, body: { spreadsheetId: 'sx', updatedCells: 1, updatedRange: 'Sheet1!B7' } },
      ]);
      const api = new GoogleSheetsAPI(makeKey());
      const r = await api.setCell('sx', 'Sheet1!B7', 'hello');
      expect(r.updatedCells).toBe(1);
      expect(calls[1].init.method).toBe('PUT');
      expect(calls[1].url).toContain('valueInputOption=USER_ENTERED');
      expect(calls[1].body).toEqual({ range: 'Sheet1!B7', majorDimension: 'ROWS', values: [['hello']] });
    });

    it('batchUpdate POSTs to :batchUpdate with the wrapped { requests } envelope', async () => {
      setupFetchMock([
        { status: 200, body: { access_token: 'tok-3', expires_in: 3600 } },
        { status: 200, body: { spreadsheetId: 'sb', replies: [{}, {}] } },
      ]);
      const api = new GoogleSheetsAPI(makeKey());
      const requests = [{ addSheet: { properties: { title: 'New' } } }, { updateSheetProperties: {} }];
      const r = await api.batchUpdate('sb', requests);
      expect(r.replies).toHaveLength(2);
      expect(calls[1].url).toContain('/v4/spreadsheets/sb/:batchUpdate');
      expect(calls[1].init.method).toBe('POST');
      expect(calls[1].body).toEqual({ requests });
    });

    it('appendRows rejects non-2D values', async () => {
      setupFetchMock([{ status: 200, body: { access_token: 't', expires_in: 3600 } }]);
      const api = new GoogleSheetsAPI(makeKey());
      await expect(api.appendRows('s', 'A1', ['flat' as unknown as unknown[]])).rejects.toThrow(/2D array/);
    });

    it('surfaces a structured error on a 4xx Sheets API response', async () => {
      setupFetchMock([
        { status: 200, body: { access_token: 'tok', expires_in: 3600 } },
        { status: 403, body: { error: { message: 'Caller does not have permission', status: 'PERMISSION_DENIED', code: 403 } } },
      ]);
      const api = new GoogleSheetsAPI(makeKey());
      await expect(api.setCell('locked-sheet', 'A1', 'x')).rejects.toThrow(
        /Caller does not have permission.*PERMISSION_DENIED.*code 403/,
      );
    });

    it('surfaces a clear error when the token exchange itself fails', async () => {
      setupFetchMock([
        { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } },
      ]);
      const api = new GoogleSheetsAPI(makeKey());
      await expect(api.setCell('s', 'A1', 'x')).rejects.toThrow(/Invalid JWT Signature/);
    });
  });
});

describe('loadSheetsClientFromKeyPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sheets-key-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid SA key file into a working client', () => {
    const path = join(tmpDir, 'sa.json');
    writeFileSync(path, JSON.stringify(makeKey()), 'utf-8');
    const client = loadSheetsClientFromKeyPath(path);
    expect(client).toBeInstanceOf(GoogleSheetsAPI);
    // JWT should sign without error, proving the loaded private key is usable
    expect(() => client.buildJwtForTest()).not.toThrow();
  });

  it('throws actionable error when the file is missing', () => {
    expect(() => loadSheetsClientFromKeyPath(join(tmpDir, 'does-not-exist.json')))
      .toThrow(/Cannot read service account key.*SHEETS_SETUP\.md/);
  });

  it('throws actionable error when the file is not JSON', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, 'not json', 'utf-8');
    expect(() => loadSheetsClientFromKeyPath(path)).toThrow(/not valid JSON/);
  });
});
