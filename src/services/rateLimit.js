/**
 * services/rateLimit.js
 *
 * In-memory rate limiter per phone number.
 * Two windows: per-minute and per-day.
 *
 * Design: simple sliding window using arrays of timestamps.
 * Suitable for a single-process deployment (see README for note on scaling).
 *
 * We also store rate_events in SQLite for observability, but the in-memory
 * map is the authoritative gate for latency.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { maskPhone } from '../utils/logger.js';
import { getDb } from '../db.js';

/** @type {Map<string, number[]>} phone → sorted array of unix ms timestamps */
const windowMap = new Map();

/**
 * Check whether a phone number is within rate limits, and record the event if so.
 *
 * @param {string} phone - normalized E.164 number
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkRateLimit(phone) {
  const now = Date.now();
  const oneMinAgo = now - 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  // Retrieve or create the events array for this phone
  let events = windowMap.get(phone) ?? [];

  // Prune events outside the day window
  events = events.filter((t) => t > oneDayAgo);

  const perMin = events.filter((t) => t > oneMinAgo).length;
  const perDay = events.length;

  if (perMin >= config.rateLimitPerMin) {
    logger.debug({ phone: maskPhone(phone), perMin }, 'Rate limit: per-minute exceeded');
    windowMap.set(phone, events);
    return { allowed: false, reason: 'minute' };
  }

  if (perDay >= config.rateLimitPerDay) {
    logger.debug({ phone: maskPhone(phone), perDay }, 'Rate limit: per-day exceeded');
    windowMap.set(phone, events);
    return { allowed: false, reason: 'day' };
  }

  // Record this event
  events.push(now);
  windowMap.set(phone, events);

  // Persist for observability (fire and forget — don't block on this)
  try {
    getDb().prepare('INSERT INTO rate_events (phone, at) VALUES (?, ?)').run(phone, now);
  } catch (err) {
    logger.warn({ err }, 'Failed to persist rate_event to DB');
  }

  return { allowed: true };
}

/**
 * Build the rate-limit reply for when a number is throttled.
 * @param {'minute'|'day'} reason
 * @returns {string}
 */
export function rateLimitReply(reason) {
  if (reason === 'minute') {
    return 'Please slow down. Wait a minute before sending another question.';
  }
  return 'Daily limit reached. Try again tomorrow.';
}

/**
 * Clear the in-memory store for a phone (useful in tests).
 * @param {string} phone
 */
export function clearRateLimit(phone) {
  windowMap.delete(phone);
}

/**
 * Prune old rate_events from the DB (called by the cron job).
 */
export function pruneRateEvents() {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const result = getDb()
    .prepare('DELETE FROM rate_events WHERE at < ?')
    .run(oneDayAgo);
  logger.debug({ deleted: result.changes }, 'Pruned old rate_events');
}
