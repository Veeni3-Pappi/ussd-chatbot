/**
 * providers/smsProvider.js
 *
 * Unified SMS adapter. Two concrete implementations:
 *   - TextBeeProvider  (primary)  — REST API, uses your Android phone's SIM
 *   - ATProvider       (secondary) — Africa's Talking npm package
 *
 * Public interface (both providers implement the same methods):
 *   sendSms(to: string, text: string): Promise<{ messageId: string, cost: string|null }>
 *   parseInbound(body: object): { from: string, text: string, messageId: string }
 *   parseDelivery(body: object): { messageId: string, status: string, phone: string }
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
   * TextBee doesn't report per-message airtime cost (the SIM carrier charges you).
   * @param {string} to - E.164 phone number
   * @param {string} text
   * @returns {Promise<{ messageId: string, cost: string|null }>}
   */
  async sendSms(to, text) {
    const body = {
      recipients: [to],
      message: text,
    };
    if (this.deviceId) {
      body.deviceId = this.deviceId;
    }

    const response = await fetch(`${this.baseUrl}/gateway/send-sms`, {
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

    // TextBee returns a batch ID; use it as the message ID reference
    const messageId = json.data?.smsBatchId ?? 'unknown';
    logger.debug({ messageId, to }, 'TextBee SMS queued');
    return { messageId, cost: null };
  }

  /**
   * Parse an inbound MESSAGE_RECEIVED webhook payload from TextBee.
   * TextBee sends JSON: { smsId, message, sender, receivedAt, idempotencyKey, ... }
   * @param {object} body - parsed JSON body
   * @returns {{ from: string, text: string, messageId: string }}
   */
  parseInbound(body) {
    return {
      from: body.sender ?? '',
      text: body.message ?? '',
      messageId: body.idempotencyKey ?? body.smsId ?? '',
    };
  }

  /**
   * Parse a delivery status webhook payload from TextBee.
   * Events: MESSAGE_SENT, MESSAGE_DELIVERED, MESSAGE_FAILED
   * @param {object} body
   * @returns {{ messageId: string, status: string, phone: string }}
   */
  parseDelivery(body) {
    const eventToStatus = {
      MESSAGE_SENT: 'sent',
      MESSAGE_DELIVERED: 'delivered',
      MESSAGE_FAILED: 'failed',
    };
    return {
      messageId: body.smsBatchId ?? body.smsId ?? '',
      status: eventToStatus[body.webhookEvent] ?? body.webhookEvent?.toLowerCase() ?? 'unknown',
      phone: body.recipient ?? body.sender ?? '',
    };
  }

  /**
   * Verify the HMAC-SHA256 X-Signature header from TextBee.
   * Must be called with the raw request body (Buffer), before JSON parsing.
   * @param {Buffer} rawBody
   * @param {string} signature - value of X-Signature header
   * @returns {boolean}
   */
  verifySignature(rawBody, signature) {
    const secret = config.textbee.webhookSecret;
    if (!secret) {
      logger.warn('TEXTBEE_WEBHOOK_SECRET not set — skipping signature check');
      return true; // degrade gracefully in dev if not configured
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
    // Lazy-init the AT client to avoid import errors if AT keys are not set
    this._client = null;
  }

  _getSms() {
    if (!this._client) {
      // Dynamic import because africastalking is a CommonJS module
      const AfricasTalking = this._loadAT();
      const at = AfricasTalking({
        apiKey: config.at.apiKey,
        username: config.at.username,
      });
      this._client = at.SMS;
    }
    return this._client;
  }

  _loadAT() {
    // We use a synchronous require-style import for the CJS module
    // This runs once and the result is cached
    const { createRequire } = await import('module'); // won't work synchronously
    // Instead, we import at module load time via a top-level await pattern
    // For now, use dynamic require via module.createRequire
    throw new Error('Use _initAT() first');
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
    if (!recipient) {
      throw new Error('Africa\'s Talking returned no recipients');
    }
    if (recipient.status !== 'Success' && recipient.statusCode !== 101) {
      throw new Error(`Africa's Talking send failed: ${recipient.status}`);
    }
    return {
      messageId: recipient.messageId ?? '',
      cost: recipient.cost ?? null,
    };
  }

  async _getSmsDynamic() {
    if (this._client) return this._client;
    const { default: AfricasTalking } = await import('africastalking');
    const at = AfricasTalking({
      apiKey: config.at.apiKey,
      username: config.at.username,
    });
    this._client = at.SMS;
    return this._client;
  }

  /**
   * Parse an inbound SMS from Africa's Talking.
   * AT sends form-encoded: from, to, text, date, id, linkId, networkCode
   * @param {object} body - req.body (already parsed by express.urlencoded)
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
   * AT sends: id, status, phoneNumber, networkCode, failureReason, retryCount
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

  /**
   * AT delivery webhooks are not signed. The secret is in the URL path.
   * This always returns true — path verification is handled in the route.
   */
  verifySignature(_rawBody, _signature) {
    return true;
  }
}

// ─── Export the active provider ───────────────────────────────────────────────

/**
 * @type {TextBeeProvider | ATProvider}
 */
let _provider;

export function getSmsProvider() {
  if (_provider) return _provider;
  if (config.smsProvider === 'africastalking') {
    logger.info('SMS provider: Africa\'s Talking');
    _provider = new ATProvider();
  } else {
    logger.info('SMS provider: TextBee');
    _provider = new TextBeeProvider();
  }
  return _provider;
}

// Convenience re-exports so callers don't have to call getSmsProvider() every time
export const sendSms = (to, text) => getSmsProvider().sendSms(to, text);
export const parseInbound = (body) => getSmsProvider().parseInbound(body);
export const parseDelivery = (body) => getSmsProvider().parseDelivery(body);
export const verifySignature = (rawBody, sig) => getSmsProvider().verifySignature(rawBody, sig);

// Export classes for testing
export { TextBeeProvider, ATProvider };
