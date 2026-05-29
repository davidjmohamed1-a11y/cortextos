import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WhatsAppAPI, normalizeRecipientPhone } from '../../../src/whatsapp/api';

// Mock-fetch harness mirroring tests/unit/telegram/api.test.ts.
type MockResponse = { status: number; body: any } | { throws: Error };
let responseQueue: MockResponse[] = [];
let callLog: Array<{ url: string; init: any; body: any }> = [];

function queue(response: MockResponse): void {
  responseQueue.push(response);
}

describe('WhatsAppAPI', () => {
  beforeEach(() => {
    responseQueue = [];
    callLog = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      callLog.push({ url, init, body });
      const next = responseQueue.shift();
      if (!next) throw new Error('fetch called with no queued response');
      if ('throws' in next) throw next.throws;
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        text: async () => JSON.stringify(next.body),
      } as any;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sendTextMessage posts a correctly shaped payload to the Graph API', async () => {
    queue({
      status: 200,
      body: {
        messaging_product: 'whatsapp',
        contacts: [{ input: '15555551234', wa_id: '15555551234' }],
        messages: [{ id: 'wamid.HBgL...' }],
      },
    });

    const api = new WhatsAppAPI('test-token', '987654321');
    const result = await api.sendTextMessage('15555551234', 'hello there');

    expect(result.messages[0].id).toBe('wamid.HBgL...');
    expect(callLog).toHaveLength(1);
    const call = callLog[0];
    expect(call.url).toBe('https://graph.facebook.com/v17.0/987654321/messages');
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(call.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15555551234',
      type: 'text',
      text: { body: 'hello there', preview_url: false },
    });
  });

  it('sendTemplateMessage posts a template payload with language code', async () => {
    queue({
      status: 200,
      body: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.TEMPL' }] },
    });

    const api = new WhatsAppAPI('test-token', '987654321');
    await api.sendTemplateMessage('15555551234', 'hello_world', 'en_US');

    expect(callLog[0].body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15555551234',
      type: 'template',
      template: { name: 'hello_world', language: { code: 'en_US' } },
    });
  });

  it('throws a structured error when the API returns a 400 with an error body', async () => {
    queue({
      status: 400,
      body: {
        error: {
          message: '(#131030) Recipient phone number not in allowed list',
          code: 131030,
          fbtrace_id: 'abc-trace-id',
        },
      },
    });

    const api = new WhatsAppAPI('test-token', '987654321');
    await expect(api.sendTextMessage('15555551234', 'hi')).rejects.toThrow(
      /Recipient phone number not in allowed list.*code 131030.*abc-trace-id/,
    );
  });

  it('throws a timeout error when fetch is aborted', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: any, init?: any) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    ));

    const api = new WhatsAppAPI('test-token', '987654321', { timeoutMs: 50 });
    await expect(api.sendTextMessage('15555551234', 'hi')).rejects.toThrow(/timed out after 50ms/);
  }, 5000);

  it('constructor rejects empty credentials', () => {
    expect(() => new WhatsAppAPI('', 'x')).toThrow(/accessToken is required/);
    expect(() => new WhatsAppAPI('x', '')).toThrow(/phoneNumberId is required/);
  });

  it('honors a custom apiVersion in the request URL', async () => {
    queue({ status: 200, body: { messaging_product: 'whatsapp', messages: [{ id: 'x' }] } });
    const api = new WhatsAppAPI('t', '111', { apiVersion: 'v20.0' });
    await api.sendTextMessage('15555551234', 'hi');
    expect(callLog[0].url).toBe('https://graph.facebook.com/v20.0/111/messages');
  });
});

describe('normalizeRecipientPhone', () => {
  it('strips formatting and a leading + into pure digits', () => {
    expect(normalizeRecipientPhone('+1 (555) 555-1234')).toBe('15555551234');
    expect(normalizeRecipientPhone('+44 7700 900123')).toBe('447700900123');
  });

  it('strips a leading 00 international prefix', () => {
    expect(normalizeRecipientPhone('00447700900123')).toBe('447700900123');
  });

  it('accepts an already-clean digit string', () => {
    expect(normalizeRecipientPhone('15555551234')).toBe('15555551234');
  });

  it('rejects strings that are too short or too long after normalization', () => {
    expect(() => normalizeRecipientPhone('1234567')).toThrow(/not a valid E.164/);
    expect(() => normalizeRecipientPhone('1234567890123456')).toThrow(/not a valid E.164/);
  });

  it('rejects strings containing non-digit, non-formatting characters', () => {
    expect(() => normalizeRecipientPhone('+1 555 abc 1234')).toThrow(/not a valid E.164/);
  });
});
