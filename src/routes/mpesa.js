/**
 * routes/mpesa.js
 * Phase 3 stub — Safaricom Daraja M-Pesa STK Push callback.
 *
 * Will be implemented in Phase 3. This stub accepts the callback
 * so Daraja doesn't error out during testing.
 *
 * Daraja callback body (ResultCode 0 = success):
 * {
 *   Body: {
 *     stkCallback: {
 *       MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc,
 *       CallbackMetadata: { Item: [ { Name, Value }, ... ] }
 *     }
 *   }
 * }
 *
 * Phase 3 implementation will:
 *   1. Verify ResultCode === 0
 *   2. Extract Amount and MpesaReceiptNumber from CallbackMetadata
 *   3. Find the pending payment by CheckoutRequestID
 *   4. Add credits per the matching credit pack (idempotent — no double-credit)
 *   5. Write credit_ledger row with ref = receipt
 *   6. Send confirmation SMS to user
 */

import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.post('/:secret', (req, res) => {
  if (req.params.secret !== config.webhookSecret) {
    logger.warn({ ip: req.ip }, 'M-Pesa webhook: invalid secret');
    return res.status(404).end();
  }

  // Phase 3: implement STK push callback processing here
  logger.debug({ body: req.body }, 'M-Pesa callback received (stub)');
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

export default router;
