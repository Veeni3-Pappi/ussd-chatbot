/**
 * routes/ussd.js
 * Phase 2 stub — USSD menu via Africa's Talking.
 *
 * USSD will be implemented in Phase 2. This stub accepts the callback
 * so AT doesn't error, and returns a placeholder END response.
 *
 * AT USSD callback fields: sessionId, serviceCode, phoneNumber, networkCode, text
 * Response must be Content-Type: text/plain, body starting with CON (continue)
 * or END (close session). Each screen must be under ~160 characters.
 * Sessions time out in tens of seconds — respond fast.
 */

import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.post('/:secret', (req, res) => {
  if (req.params.secret !== config.webhookSecret) {
    logger.warn({ ip: req.ip }, 'USSD webhook: invalid secret');
    return res.status(404).end();
  }

  // Phase 2: implement full USSD menu here
  // For now, direct users to SMS
  res.set('Content-Type', 'text/plain');
  res.status(200).send('END SMS-AI is available via SMS. Text your question to this number.');
});

export default router;
