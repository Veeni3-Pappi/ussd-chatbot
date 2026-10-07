/**
 * services/messageHandler.js
 * The core inbound SMS processing pipeline.
 *
 * Pipeline (per the spec):
 *  1.  Deduplicate by message ID
 *  2.  Normalize sender phone
 *  3.  Handle MAINTENANCE_MODE
 *  4.  Check opted-out status (STOP/START keywords)
 *  5.  Handle keywords: BAL, HELP, STOP, START
 *  6.  Validate & truncate question text
 *  7.  Rate limit
 *  8.  Credit check (new users get free trial credits)
 *  9.  Load recent history
 * 10.  Call Gemini
 * 11.  Format reply
 * 12.  Send reply via SMS provider
 * 13.  Deduct credit only after successful send
 * 14.  Log everything in DB
 */

import { checkAndMarkProcessed, logMessage, updateMessage, getRecentHistory, getUser, setOptedOut, markFirstReplySent } from '../db.js';
import { normalizePhone } from './phone.js';
import { checkCredits, chargeCredit, balanceReply, noCreditsReply } from './credits.js';
import { checkRateLimit, rateLimitReply } from './rateLimit.js';
import { generateReply } from '../llm/llm.js';
import { formatReply, countSegments } from './replyFormatter.js';
import { sendSms } from '../providers/smsProvider.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { maskPhone } from '../utils/logger.js';

// ─── Keyword definitions ──────────────────────────────────────────────────────

const KEYWORD_BAL   = /^bal$/i;
const KEYWORD_HELP  = /^help$/i;
const KEYWORD_STOP  = /^stop$/i;
const KEYWORD_START = /^start$/i;

const HELP_TEXT = 'SMS-AI: Text any question to get a quick answer. Reply BAL for credits, STOP to unsubscribe, START to resubscribe.';
const MAINTENANCE_TEXT = 'Service is paused for maintenance. Please try again later.';
const APOLOGY_TEXT = 'Sorry, could not get an answer right now. Please try again shortly.';

// ─── One-per-window rate limit notification tracker ───────────────────────────
// We send at most one "slow down" message per window breach, then stay silent.
/** @type {Map<string, number>} phone → timestamp of last rate-limit notification */
const rateLimitNotified = new Map();

function shouldNotifyRateLimit(phone) {
  const last = rateLimitNotified.get(phone) ?? 0;
  const now = Date.now();
  if (now - last > 60 * 1000) { // only once per minute
    rateLimitNotified.set(phone, now);
    return true;
  }
  return false;
}

// ─── Send helper (with one retry, no double-charge) ──────────────────────────

/**
 * Send an SMS with one retry. Returns send result or throws.
 * @param {string} to
 * @param {string} text
 * @returns {Promise<{ messageId: string, cost: string|null }>}
 */
async function sendWithRetry(to, text) {
  try {
    return await sendSms(to, text);
  } catch (firstErr) {
    logger.warn({ err: firstErr, phone: maskPhone(to) }, 'SMS send failed, retrying once');
    return await sendSms(to, text); // let this throw on second failure
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Process one inbound SMS message end-to-end.
 * Called asynchronously after the webhook route responds 200.
 *
 * @param {{ from: string, text: string, messageId: string }} inbound
 */
export async function handleInboundSms({ from, text, messageId }) {
  // ── 1. Deduplicate ──────────────────────────────────────────────────────────
  const isDuplicate = checkAndMarkProcessed(messageId);
  if (isDuplicate) {
    logger.info({ messageId }, 'Duplicate message ignored');
    return;
  }

  // ── 2. Normalize phone ──────────────────────────────────────────────────────
  let phone;
  try {
    phone = normalizePhone(from);
  } catch (err) {
    logger.warn({ from, err: err.message }, 'Could not normalize phone, ignoring message');
    return;
  }

  const masked = maskPhone(phone);
  logger.info({ phone: masked, messageId, chars: text?.length }, 'Processing inbound SMS');

  // Log inbound message (body stored; will be purged after 24h by cron)
  const inRowId = logMessage({
    phone,
    direction: 'in',
    body: text,
    status: 'received',
  });

  // ── 3. Maintenance mode ─────────────────────────────────────────────────────
  if (config.maintenanceMode) {
    await sendOneOff(phone, MAINTENANCE_TEXT, 'maintenance');
    return;
  }

  // ── 4. Opt-out check ────────────────────────────────────────────────────────
  const trimmed = (text ?? '').trim();

  // Handle START before the opt-out gate so they can re-subscribe
  if (KEYWORD_START.test(trimmed)) {
    const user = getUser(phone);
    if (user?.opted_out) {
      setOptedOut(phone, false);
      await sendOneOff(phone, 'Welcome back! You are resubscribed to SMS-AI. Text any question to start.', 'start');
    } else {
      await sendOneOff(phone, 'You are already subscribed to SMS-AI. Text any question to get an answer.', 'start-already');
    }
    return;
  }

  const user = getUser(phone);
  if (user?.opted_out) {
    logger.debug({ phone: masked }, 'Message from opted-out number, ignoring');
    return; // stay silent — no reply to opted-out users
  }

  // ── 5. Keywords ─────────────────────────────────────────────────────────────
  if (KEYWORD_STOP.test(trimmed)) {
    // Ensure user exists before opting out
    checkCredits(phone); // creates user if new
    setOptedOut(phone, true);
    await sendOneOff(phone, 'You have been unsubscribed from SMS-AI. Text START to resubscribe.', 'stop');
    return;
  }

  if (KEYWORD_BAL.test(trimmed)) {
    const { credits } = checkCredits(phone);
    await sendOneOff(phone, balanceReply(credits), 'bal');
    return;
  }

  if (KEYWORD_HELP.test(trimmed)) {
    await sendOneOff(phone, HELP_TEXT, 'help');
    return;
  }

  // ── 6. Validate question ────────────────────────────────────────────────────
  let question = trimmed.slice(0, 500); // cap at 500 chars (no reject, just truncate)
  if (!question) {
    await sendOneOff(phone, 'Please send a question. Example: What causes malaria?', 'empty');
    return;
  }

  // ── 7. Rate limit ───────────────────────────────────────────────────────────
  const rate = checkRateLimit(phone);
  if (!rate.allowed) {
    if (shouldNotifyRateLimit(phone)) {
      await sendOneOff(phone, rateLimitReply(rate.reason), 'rate-limit');
    }
    logger.debug({ phone: masked, reason: rate.reason }, 'Rate limited, message ignored');
    return;
  }

  // ── 8. Credit check ─────────────────────────────────────────────────────────
  const { ok: hasCredits, credits, isNew } = checkCredits(phone);

  if (!hasCredits) {
    logger.info({ phone: masked }, 'No credits, sending top-up message');
    await sendOneOff(phone, noCreditsReply(), 'no-credits');
    return;
  }

  // ── 9. Load history ─────────────────────────────────────────────────────────
  const history = getRecentHistory(phone, 3);

  // ── 10. Call Gemini ─────────────────────────────────────────────────────────
  let geminiText;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const result = await generateReply({ phone, question, history });
    geminiText = result.text;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
  } catch (err) {
    logger.error({ err, phone: masked }, 'Gemini failed, sending apology');
    await sendOneOff(phone, APOLOGY_TEXT, 'llm-error');
    // Do NOT charge credits on LLM failure
    return;
  }

  // ── 11. Format reply ────────────────────────────────────────────────────────
  // isFirstReply: user is new OR this is their first outbound message
  const currentUser = getUser(phone);
  const isFirstReply = isNew || !currentUser?.first_reply_sent;

  const replyText = formatReply(geminiText, { isFirstReply });
  const { segments } = countSegments(replyText);

  // ── 12. Send reply ──────────────────────────────────────────────────────────
  const outRowId = logMessage({
    phone,
    direction: 'out',
    body: replyText,
    segments,
    status: 'queued',
  });

  let sendResult;
  try {
    sendResult = await sendWithRetry(phone, replyText);
    logger.info(
      { phone: masked, messageId: sendResult.messageId, segments, inputTokens, outputTokens },
      'Reply sent',
    );
  } catch (err) {
    logger.error({ err, phone: masked }, 'SMS send failed after retry, not charging credit');
    updateMessage(outRowId, { status: 'failed' });
    return;
  }

  // ── 13. Update outbound log & charge credit ─────────────────────────────────
  updateMessage(outRowId, {
    status: 'sent',
    atMessageId: sendResult.messageId,
    cost: sendResult.cost,
  });

  // Charge credit ONLY after successful send
  chargeCredit(phone, sendResult.messageId);

  // Mark first reply sent so we don't append the hint again
  if (isFirstReply) {
    markFirstReplySent(phone);
  }

  logger.debug({ phone: masked, credits: credits - 1 }, 'Credit charged, pipeline complete');
}

// ─── Helper for one-off system replies ───────────────────────────────────────

/**
 * Send a short system message (keyword reply, error, etc.) and log it.
 * Does not charge credits.
 * @param {string} phone
 * @param {string} text
 * @param {string} reason - label for logging
 */
async function sendOneOff(phone, text, reason) {
  const formatted = formatReply(text);
  const { segments } = countSegments(formatted);
  const outRowId = logMessage({ phone, direction: 'out', body: formatted, segments, status: 'queued' });

  try {
    const result = await sendSms(phone, formatted);
    updateMessage(outRowId, { status: 'sent', atMessageId: result.messageId, cost: result.cost });
    logger.debug({ phone: maskPhone(phone), reason }, 'One-off reply sent');
  } catch (err) {
    updateMessage(outRowId, { status: 'failed' });
    logger.error({ err, phone: maskPhone(phone), reason }, 'One-off reply failed to send');
  }
}
