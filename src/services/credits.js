/**
 * services/credits.js
 * Business logic for the credit system.
 * All DB writes go through db.js — this module handles the rules.
 */

import { getOrCreateUser, deductCredit, addCredits as dbAddCredits } from '../db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { maskPhone } from '../utils/logger.js';

/**
 * Check credits for an inbound message.
 * Creates the user if new (awards free trial credits).
 * @param {string} phone - normalized E.164 number
 * @returns {{ ok: boolean, credits: number, user: object, isNew: boolean }}
 */
export function checkCredits(phone) {
  const { user, isNew } = getOrCreateUser(phone, config.freeTrialCredits);

  if (isNew) {
    logger.info({ phone: maskPhone(phone), credits: config.freeTrialCredits }, 'New user, trial credits awarded');
  }

  const ok = user.credits > 0;
  return { ok, credits: user.credits, user, isNew };
}

/**
 * Charge 1 credit for a successfully answered question.
 * Must only be called after the SMS is confirmed sent.
 * @param {string} phone
 * @param {string} [messageRef] - outbound message ID for the ledger
 */
export function chargeCredit(phone, messageRef = null) {
  deductCredit(phone, messageRef);
  logger.debug({ phone: maskPhone(phone) }, 'Credit charged');
}

/**
 * Add credits to a user (top-up or admin grant).
 * @param {string} phone
 * @param {number} amount
 * @param {'topup'|'admin'|'refund'} reason
 * @param {string} [ref] - e.g. M-Pesa receipt
 */
export function grantCredits(phone, amount, reason, ref = null) {
  dbAddCredits(phone, amount, reason, ref);
  logger.info({ phone: maskPhone(phone), amount, reason, ref }, 'Credits granted');
}

/**
 * Build the BAL reply text.
 * @param {number} credits
 * @returns {string}
 */
export function balanceReply(credits) {
  if (credits === 0) return 'You have 0 credits. Send TOPUP to add more.';
  if (credits === 1) return 'You have 1 credit remaining.';
  return `You have ${credits} credits remaining.`;
}

/**
 * Build the zero-credits reply (no LLM call should be made after this).
 * @returns {string}
 */
export function noCreditsReply() {
  return 'No credits left. Send TOPUP to purchase more and keep asking questions.';
}
