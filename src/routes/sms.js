/**
 * routes/sms.js
 *
 * Handles inbound SMS webhooks from both TextBee and Africa's Talking.
 *
 * TextBee:
 *   POST /webhooks/sms/textbee/:secret
 *   Content-Type: application/json
 *   Verified via X-Signature HMAC-SHA256 header
 *
 * Africa's Talking:
 *   POST /webhooks/sms/at/:secret
 *   Content-Type: application/x-www-form-urlencoded
 *   Verified via secret path segment only (AT does not sign callbacks)
 *
 * Both routes respond 200 immediately, then process asynchronously.
 */

import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { verifySignature, parseInbound } from '../providers/smsProvider.js';
import { TextBeeProvider, ATProvider } from '../providers/smsProvider.js';
import { handleInboundSms } from '../services/messageHandler.js';

const router = Router();

// ── TextBee inbound ───────────────────────────────────────────────────────────

router.post('/textbee/:secret', (req, res) => {
  // 1. Verify secret path segment
  if (req.params.secret !== config.webhookSecret) {
    logger.warn({ ip: req.ip }, 'TextBee SMS webhook: invalid secret');
    return res.status(404).end();
  }

  // 2. Verify HMAC-SHA256 signature
  const sig = req.headers['x-signature'] ?? '';
  const rawBody = req.rawBody; // set by express.raw() middleware in server.js

  const tb = new TextBeeProvider();
  if (!tb.verifySignature(rawBody, sig)) {
    logger.warn({ ip: req.ip }, 'TextBee SMS webhook: invalid signature');
    return res.status(401).end();
  }

  // 3. Only handle MESSAGE_RECEIVED events
  const body = req.body;
  if (body.webhookEvent && body.webhookEvent !== 'MESSAGE_RECEIVED') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  // 4. Respond 200 immediately
  res.status(200).json({ ok: true });

  // 5. Process asynchronously
  const parsed = new TextBeeProvider().parseInbound(body);
  if (parsed.from && parsed.text) {
    handleInboundSms(parsed).catch((err) =>
      logger.error({ err }, 'Unhandled error in TextBee handleInboundSms'),
    );
  }
});

// ── Africa's Talking inbound ──────────────────────────────────────────────────

router.post('/at/:secret', express_urlencoded_passthrough, (req, res) => {
  // 1. Verify secret path segment (AT doesn't sign callbacks)
  if (req.params.secret !== config.webhookSecret) {
    logger.warn({ ip: req.ip }, 'AT SMS webhook: invalid secret');
    return res.status(404).end();
  }

  // 2. Respond 200 immediately
  res.status(200).end();

  // 3. Process asynchronously
  const at = new ATProvider();
  const parsed = at.parseInbound(req.body);
  if (parsed.from && parsed.text) {
    handleInboundSms(parsed).catch((err) =>
      logger.error({ err }, 'Unhandled error in AT handleInboundSms'),
    );
  }
});

// Middleware stub — urlencoded parsing is applied globally in server.js
// This is here as documentation; nothing extra needed.
function express_urlencoded_passthrough(req, _res, next) {
  next();
}

export default router;
