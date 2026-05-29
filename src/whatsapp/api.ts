/**
 * WhatsApp Business Cloud API client (Meta Graph API).
 * Uses built-in Node.js fetch. No external dependencies.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *
 * IMPORTANT — 24-hour customer service window
 * --------------------------------------------
 * Outside a 24-hour window from the recipient's last inbound message, free-form
 * text messages are rejected by the API. Only pre-approved Message Templates
 * can initiate a new conversation. This client supports text + template — see
 * WHATSAPP_SETUP.md for the setup workflow and template approval process.
 */

export interface WhatsAppMessageResult {
  messaging_product: 'whatsapp';
  contacts?: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
}

export interface WhatsAppErrorBody {
  error: {
    message: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    error_data?: { details?: string };
  };
}

export interface WhatsAppAPIOptions {
  /** Graph API version. Pinned to a known-stable version; bump deliberately. */
  apiVersion?: string;
  /** Per-request fetch timeout in milliseconds. */
  timeoutMs?: number;
}

export class WhatsAppAPI {
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;

  constructor(accessToken: string, phoneNumberId: string, opts: WhatsAppAPIOptions = {}) {
    if (!accessToken) throw new Error('WhatsAppAPI: accessToken is required');
    if (!phoneNumberId) throw new Error('WhatsAppAPI: phoneNumberId is required');
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    // v17.0 (Oct 2023) — Meta supports each version for ~2 years. Bump deliberately
    // when the next major surface change ships.
    this.apiVersion = opts.apiVersion ?? 'v17.0';
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  /**
   * Send a free-form text message.
   *
   * Only delivers when the recipient has messaged this business number within
   * the last 24 hours. Outside that window the API returns an error and you
   * must use a pre-approved template instead — see sendTemplateMessage.
   *
   * @param to       Recipient phone in E.164 digits-only form (e.g. "15555551234" — no + prefix).
   * @param body     Message text. UTF-8. WhatsApp caps text bodies at 4096 chars.
   * @param preview  When true, WhatsApp renders link previews for URLs in `body`.
   */
  async sendTextMessage(to: string, body: string, preview = false): Promise<WhatsAppMessageResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: preview },
    });
  }

  /**
   * Send a pre-approved message template. Use this to initiate conversations
   * outside the 24-hour window.
   *
   * @param to             Recipient phone in E.164 digits-only form.
   * @param templateName   Name of the template as approved in Meta Business Manager.
   * @param languageCode   BCP-47 code matching the approved template (e.g. "en_US").
   * @param components     Optional placeholder values for the template body/header/buttons.
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    languageCode: string,
    components?: object[],
  ): Promise<WhatsAppMessageResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {}),
      },
    });
  }

  private async post(payload: object): Promise<WhatsAppMessageResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        throw new Error(`WhatsApp API returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
      }
      if (!response.ok) {
        const errBody = json as Partial<WhatsAppErrorBody>;
        const detail = errBody.error?.message ?? `HTTP ${response.status}`;
        const code = errBody.error?.code !== undefined ? ` (code ${errBody.error.code})` : '';
        const trace = errBody.error?.fbtrace_id ? ` [fbtrace_id ${errBody.error.fbtrace_id}]` : '';
        throw new Error(`WhatsApp API error: ${detail}${code}${trace}`);
      }
      return json as WhatsAppMessageResult;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('WhatsApp API')) {
        throw err;
      }
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`WhatsApp API request timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`WhatsApp API request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Normalize a recipient phone string into the digits-only E.164 form Meta requires.
 * Strips spaces, hyphens, parentheses, dots, and a leading + or 00 international prefix.
 * Returns the normalized string; throws if the result is not a plausible phone (8–15 digits).
 */
export function normalizeRecipientPhone(input: string): string {
  const trimmed = input.trim();
  let digits = trimmed.replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d{8,15}$/.test(digits)) {
    throw new Error(
      `WhatsApp recipient phone "${input}" is not a valid E.164 number. ` +
      'Expected 8–15 digits (with optional + or 00 prefix), e.g. "+15555551234" or "15555551234".',
    );
  }
  return digits;
}
