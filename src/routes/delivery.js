/**
 * routes/delivery.js
 *
 * Handles SMS delivery report webhooks from TextBee and Africa's Talking.
 * Updates message status in the DB by at_message_id.
 *
 * TextBee:  POST /webhooks/delivery/textbee/:secret  (JSON, X-Signature)
 * AT:       POST /webhooks/delivery/at/:secret       (form-encoded)
 */

import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { TextBeeProvider, ATProvider } from '../providers/smsProvider.js';
import { updateMessageByAtId } from '../db.js';
import { maskPhone } from '../utils/logger.js';

const router = Router();

// ── TextBee delivery ──────────────────────────────────────────────────────────

router.post('/textbee/:secret', (req, res) => {
  if (req.params.secret !== config.webhookSecret) {
    logger.warn({ ip: req.ip }, 'TextBee delivery webhook: invalid secret');
    return res.status(404).end();
  }

  const sig = req.headers['x-signature'] ?? '';
  const rawBody = req.rawBody;

  const tb = new TextBeeProvider();
  if (!tb.verifySignature(rawBody, sig)) {
    logger.warn({ ip: req.ip }, 'TextBee delivery webhook: invalid signature');
    return res.status(401).end();
  }

  res.status(200).json({ ok: true });

  // Only process delivery-related events
  const event = req.body.webhookEvent ?? '';
  const deliveryEvents = ['MESSAGE_SENT', 'MESSAGE_DELIVERED', 'MESSAGE_FAILED'];
  if (!deliveryEvents.includes(event)) return;

  const { messageId, status, phone } = tb.parseDelivery(req.body);

  if (messageId) {
    updateMessageByAtId(messageId, status);
    logger.info({ messageId, status, phone: maskPhone(phone) }, 'TextBee delivery report processed');
  }
});

// ── Africa's Talking delivery ─────────────────────────────────────────────────

router.post('/at/:secret', (req, res) => {
  if (req.params.secret !== config.webhookSecret) {
    logger.warn({ ip: req.ip }, 'AT delivery webhook: invalid secret');
    return res.status(404).end();
  }

  res.status(200).end();

  const at = new ATProvider();
  const { messageId, status, phone } = at.parseDelivery(req.body);

  if (messageId) {
    updateMessageByAtId(messageId, status);
    logger.info({ messageId, status, phone: maskPhone(phone) }, 'AT delivery report processed');
  }
});

export default router;
