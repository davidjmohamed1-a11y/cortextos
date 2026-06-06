/**
 * Google Sheets API v4 client using a service-account key.
 *
 * Why service account (not user OAuth):
 *  - No browser consent dance — runs unattended from agents
 *  - Scope is per-sheet (David shares each sheet with the SA email he wants
 *    cortextos to touch), so the blast radius is minimum-bounded by what
 *    David explicitly chose to share rather than the OAuth `spreadsheets`
 *    grant covering every sheet in his account
 *  - Refresh logic is simpler — JWT-bearer exchange returns a 1h access token,
 *    no refresh-token-rotation gotchas
 *
 * Auth flow: build a JWT signed with RS256 using the SA private key, POST to
 * Google's token endpoint with grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer,
 * receive an access_token, use that on Sheets API requests.
 *
 * No external runtime deps — built-in `node:crypto` does RS256 signing, built-in
 * `fetch` handles HTTP. Matches the cortextos "no extra deps" rule.
 */

import { readFileSync } from 'fs';
import { createSign } from 'crypto';

export interface ServiceAccountKey {
  /** Service-account email (sub of JWT, what David shares sheets with). */
  client_email: string;
  /** PEM-encoded RSA private key — Google JSON gives this as a multi-line string. */
  private_key: string;
  /** Optional key id, included in JWT header `kid` when present. */
  private_key_id?: string;
  /** Project id — informational; not used in auth. */
  project_id?: string;
  /** Token endpoint — defaults to the standard one. */
  token_uri?: string;
}

export interface SheetsAPIOptions {
  /** OAuth scope; defaults to read+write spreadsheets. */
  scope?: string;
  /** Per-request fetch timeout (ms). */
  timeoutMs?: number;
}

interface CachedToken {
  access_token: string;
  expires_at_ms: number;
}

export interface AppendResult {
  spreadsheetId: string;
  /** Updated range in A1 notation. */
  updates?: { updatedRange?: string; updatedRows?: number; updatedColumns?: number; updatedCells?: number };
}

export interface ValuesUpdateResult {
  spreadsheetId: string;
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}

export interface BatchUpdateResult {
  spreadsheetId: string;
  replies?: unknown[];
}

export class GoogleSheetsAPI {
  private readonly key: ServiceAccountKey;
  private readonly scope: string;
  private readonly timeoutMs: number;
  private cached: CachedToken | null = null;

  constructor(key: ServiceAccountKey, opts: SheetsAPIOptions = {}) {
    if (!key.client_email) throw new Error('GoogleSheetsAPI: service account key missing client_email');
    if (!key.private_key) throw new Error('GoogleSheetsAPI: service account key missing private_key');
    this.key = key;
    this.scope = opts.scope ?? 'https://www.googleapis.com/auth/spreadsheets';
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  /**
   * Append rows to a sheet range. Values is a 2D array — outer = rows, inner = cells.
   * Range is an A1 selector like "Sheet1!A1" or "Sheet1!A:D" (Google appends after
   * the last row in the matching block).
   *
   * Reference: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/append
   */
  async appendRows(spreadsheetId: string, range: string, values: unknown[][]): Promise<AppendResult> {
    if (!Array.isArray(values) || values.some(r => !Array.isArray(r))) {
      throw new Error('appendRows: `values` must be a 2D array (array of row arrays)');
    }
    const url = this.sheetsUrl(spreadsheetId, `values/${encodeURIComponent(range)}:append`) +
      '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
    return this.request<AppendResult>('POST', url, { values });
  }

  /**
   * Set a single cell. `a1` is a fully-qualified A1 reference including the sheet
   * name when needed, e.g. "Sheet1!B7". For a sheet with a space in its name,
   * quote it: "'My Sheet'!B7".
   */
  async setCell(spreadsheetId: string, a1: string, value: unknown): Promise<ValuesUpdateResult> {
    const url = this.sheetsUrl(spreadsheetId, `values/${encodeURIComponent(a1)}`) +
      '?valueInputOption=USER_ENTERED';
    return this.request<ValuesUpdateResult>('PUT', url, {
      range: a1,
      majorDimension: 'ROWS',
      values: [[value]],
    });
  }

  /**
   * Run a raw batchUpdate request. `requests` is the array of Google Sheets
   * batchUpdate request objects (each one a tagged union — addSheet,
   * updateCells, deleteRange, etc.). For complex multi-cell mutations this
   * is the right call; for single cells or simple appends, prefer setCell /
   * appendRows.
   *
   * Reference: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/batchUpdate
   */
  async batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<BatchUpdateResult> {
    if (!Array.isArray(requests)) {
      throw new Error('batchUpdate: `requests` must be an array of Google Sheets request objects');
    }
    const url = this.sheetsUrl(spreadsheetId, ':batchUpdate');
    return this.request<BatchUpdateResult>('POST', url, { requests });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sheetsUrl(spreadsheetId: string, suffix: string): string {
    return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/${suffix}`;
  }

  /**
   * Make an authenticated request to the Sheets API. Acquires/refreshes the
   * access token transparently. Surfaces structured errors on non-2xx.
   */
  private async request<T>(method: 'GET' | 'POST' | 'PUT', url: string, body: unknown): Promise<T> {
    const token = await this.getAccessToken();
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Sheets API returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
      }
      if (!response.ok) {
        const errBody = parsed as { error?: { message?: string; status?: string; code?: number } };
        const msg = errBody.error?.message ?? `HTTP ${response.status}`;
        const status = errBody.error?.status ? ` [${errBody.error.status}]` : '';
        const code = errBody.error?.code !== undefined ? ` (code ${errBody.error.code})` : '';
        throw new Error(`Sheets API error: ${msg}${status}${code}`);
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Sheets API')) throw err;
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`Sheets API request timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`Sheets API request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Get a current access token. Cached until 60s before expiry so we never
   * hand out a near-dead token to a request that may take a few seconds.
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expires_at_ms > now + 60_000) {
      return this.cached.access_token;
    }
    const jwt = this.buildJwt();
    const tokenUri = this.key.token_uri ?? 'https://oauth2.googleapis.com/token';
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString();

    const response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let parsed: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Google token endpoint returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    if (!response.ok || !parsed.access_token) {
      const detail = parsed.error_description ?? parsed.error ?? `HTTP ${response.status}`;
      throw new Error(`Google token exchange failed: ${detail}`);
    }
    const lifetime = (parsed.expires_in ?? 3600) * 1000;
    this.cached = {
      access_token: parsed.access_token,
      expires_at_ms: Date.now() + lifetime,
    };
    return parsed.access_token;
  }

  /**
   * Build a signed JWT for the service account.
   * Header: { alg: RS256, typ: JWT, kid?: private_key_id }
   * Claims: { iss, scope, aud, iat, exp }  — exp = iat + 1h max per spec.
   * Signed using the service account's PEM private key.
   *
   * Exposed for unit testing via `buildJwtForTest`; the public method stays private.
   */
  private buildJwt(): string {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 3600; // 1 hour — Google's max
    const tokenUri = this.key.token_uri ?? 'https://oauth2.googleapis.com/token';
    const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
    if (this.key.private_key_id) header.kid = this.key.private_key_id;
    const claims = {
      iss: this.key.client_email,
      scope: this.scope,
      aud: tokenUri,
      iat,
      exp,
    };
    const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(this.key.private_key);
    return `${unsigned}.${b64urlBuf(signature)}`;
  }

  /** Test-only: expose the JWT builder without forcing a token exchange. */
  public buildJwtForTest(): string {
    return this.buildJwt();
  }
}

/**
 * Load a service-account JSON key from disk and construct a sheets client.
 * Throws with a clear, operator-actionable message on missing/malformed file.
 */
export function loadSheetsClientFromKeyPath(path: string, opts?: SheetsAPIOptions): GoogleSheetsAPI {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot read service account key at "${path}": ${err instanceof Error ? err.message : String(err)}. ` +
      `Set GOOGLE_SHEETS_SA_KEY_PATH in your .env to point at a valid service-account JSON file. ` +
      `See SHEETS_SETUP.md for the David-side Google Cloud setup.`,
    );
  }
  let parsed: ServiceAccountKey;
  try {
    parsed = JSON.parse(raw) as ServiceAccountKey;
  } catch (err) {
    throw new Error(
      `Service account key at "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return new GoogleSheetsAPI(parsed, opts);
}

// ---------------------------------------------------------------------------
// base64url helpers — JWT signs over base64url-encoded segments, not base64.
// Standard Node Buffer toString('base64') uses + / =; convert to - _ and strip =.
// ---------------------------------------------------------------------------

function b64url(s: string): string {
  return b64urlBuf(Buffer.from(s, 'utf-8'));
}

function b64urlBuf(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
