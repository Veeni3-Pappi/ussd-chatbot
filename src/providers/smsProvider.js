/**
 * providers/smsProvider.js
 *
 * Unified SMS adapter. Two concrete implementations:
 *   - TextBeeProvider  (primary)  — REST API, uses your Android phone's SIM
 *   - ATProvider       (secondary) — Africa's Talking npm package
 *
 * Public interface (both providers implement the same methods):
 *   sendSms(to, text): Promise<{ messageId: string, cost: string|null }>
 *   parseInbound(body): { from: string, text: string, messageId: string }
 *   parseDelivery(body): { messageId: string, status: string, phone: string }
 *   verifySignature(rawBody, sig): boolean
 *
 * Select the active provider with SMS_PROVIDER env var ("textbee" | "africastalking").
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// ─── TextBee provider ─────────────────────────────────────────────────────────

class TextBeeProvider {
  constructor() {
    this.apiKey = config.textbee.apiKey;
    this.deviceId = config.textbee.deviceId;
    this.baseUrl = config.textbee.baseUrl;
  }

  /**
   * Send an SMS via the TextBee REST API.
   * @param {string} to - E.164 phone number
   * @param {string} text
   * @returns {Promise<{ messageId: string, cost: string|null }>}
   */
  async sendSms(to, text) {
    const body = { recipients: [to], message: text };
    if (this.deviceId) body.deviceId = this.deviceId;
    // Use specific SIM on dual-SIM phones. Value comes from TextBee app → Settings → SIM.
    if (config.textbee.simSubscriptionId) {
      body.simSubscriptionId = parseInt(config.textbee.simSubscriptionId, 10);
    }

    const url = this.deviceId
      ? `${this.baseUrl}/gateway/devices/${this.deviceId}/send-sms`
      : `${this.baseUrl}/gateway/send-sms`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    const json = await response.json();

    if (!response.ok) {
      throw new Error(
        `TextBee send failed (${response.status}): ${json.error || json.message || 'Unknown error'}`,
      );
    }

    const messageId = json.data?.smsBatchId ?? json.data?.id ?? json.data?._id ?? json.smsBatchId ?? json.id ?? 'unknown';
    logger.debug({ messageId, to }, 'TextBee SMS queued');
    return { messageId, cost: null };
  }

  /**
   * Parse an inbound MESSAGE_RECEIVED webhook payload from TextBee.
   * Handles both top-level and nested `data` formats.
   * @param {object} body - parsed JSON body
   * @returns {{ from: string, text: string, messageId: string }}
   */
  parseInbound(body) {
    const data = body?.data ?? body ?? {};
    return {
      from: data.sender ?? data.from ?? body?.sender ?? body?.from ?? '',
      text: data.message ?? data.text ?? body?.message ?? body?.text ?? '',
      messageId: data.idempotencyKey ?? data.smsId ?? data.id ?? body?.idempotencyKey ?? body?.smsId ?? body?.id ?? '',
    };
  }

  /**
   * Parse a delivery status webhook from TextBee.
   * Handles both top-level and nested `data` formats.
   * @param {object} body
   * @returns {{ messageId: string, status: string, phone: string }}
   */
  parseDelivery(body) {
    const data = body?.data ?? body ?? {};
    const event = body?.webhookEvent ?? data?.webhookEvent;
    const eventToStatus = {
      MESSAGE_SENT: 'sent',
      MESSAGE_DELIVERED: 'delivered',
      MESSAGE_FAILED: 'failed',
    };
    return {
      messageId: data.smsBatchId ?? data.smsId ?? data.id ?? body?.smsBatchId ?? body?.smsId ?? body?.id ?? '',
      status: eventToStatus[event] ?? event?.toLowerCase() ?? 'unknown',
      phone: data.recipient ?? data.sender ?? data.phone ?? body?.recipient ?? body?.sender ?? body?.phone ?? '',
    };
  }

  /**
   * Verify the HMAC-SHA256 X-Signature header from TextBee.
   * @param {Buffer} rawBody
   * @param {string} signature
   * @returns {boolean}
   */
  verifySignature(rawBody, signature) {
    const secret = config.textbee.webhookSecret;
    if (!secret) {
      logger.warn('TEXTBEE_WEBHOOK_SECRET not set — skipping signature check');
      return true;
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
    } catch {
      return false;
    }
  }
}

// ─── Africa's Talking provider ────────────────────────────────────────────────

class ATProvider {
  constructor() {
    this._smsClient = null;
  }

  /**
   * Lazily initialize the AT SMS client using dynamic import.
   * @returns {Promise<object>}
   */
  async _getSmsDynamic() {
    if (this._smsClient) return this._smsClient;
    const { default: AfricasTalking } = await import('africastalking');
    const at = AfricasTalking({
      apiKey: config.at.apiKey,
      username: config.at.username,
    });
    this._smsClient = at.SMS;
    return this._smsClient;
  }

  /**
   * Send an SMS via Africa's Talking.
   * @param {string} to
   * @param {string} text
   * @returns {Promise<{ messageId: string, cost: string|null }>}
   */
  async sendSms(to, text) {
    const sms = await this._getSmsDynamic();
    const opts = { to: [to], message: text };
    if (config.at.senderId) opts.from = config.at.senderId;

    const result = await sms.send(opts);
    const recipient = result?.SMSMessageData?.Recipients?.[0];
    if (!recipient) throw new Error("Africa's Talking returned no recipients");
    if (recipient.status !== 'Success' && recipient.statusCode !== 101) {
      throw new Error(`Africa's Talking send failed: ${recipient.status}`);
    }
    return { messageId: recipient.messageId ?? '', cost: recipient.cost ?? null };
  }

  /**
   * Parse an inbound SMS from Africa's Talking (form-encoded).
   * @param {object} body - req.body parsed by express.urlencoded
   * @returns {{ from: string, text: string, messageId: string }}
   */
  parseInbound(body) {
    return {
      from: body.from ?? '',
      text: body.text ?? '',
      messageId: body.id ?? '',
    };
  }

  /**
   * Parse a delivery report from Africa's Talking.
   * @param {object} body
   * @returns {{ messageId: string, status: string, phone: string }}
   */
  parseDelivery(body) {
    const statusMap = {
      Success: 'delivered',
      Sent: 'sent',
      Failed: 'failed',
      Buffered: 'queued',
      Rejected: 'failed',
    };
    return {
      messageId: body.id ?? '',
      status: statusMap[body.status] ?? body.status?.toLowerCase() ?? 'unknown',
      phone: body.phoneNumber ?? '',
    };
  }

  /** AT doesn't sign callbacks — secret is in the URL path. */
  verifySignature(_rawBody, _signature) {
    return true;
  }
}

// ─── Export the active provider ───────────────────────────────────────────────

let _provider;

export function getSmsProvider() {
  if (_provider) return _provider;
  if (config.smsProvider === 'africastalking') {
    logger.info("SMS provider: Africa's Talking");
    _provider = new ATProvider();
  } else {
    logger.info('SMS provider: TextBee');
    _provider = new TextBeeProvider();
  }
  return _provider;
}

export const sendSms = (to, text) => getSmsProvider().sendSms(to, text);
export const parseInbound = (body) => getSmsProvider().parseInbound(body);
export const parseDelivery = (body) => getSmsProvider().parseDelivery(body);
export const verifySignature = (rawBody, sig) => getSmsProvider().verifySignature(rawBody, sig);

export { TextBeeProvider, ATProvider };
