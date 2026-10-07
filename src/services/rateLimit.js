/**
 * services/rateLimit.js
 * In-memory rate limiter per phone number.
 * Two windows: per-minute and per-day.
 * The in-memory Map is authoritative. No DB dependency in this module.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { maskPhone } from '../utils/logger.js';

/** @type {Map<string, number[]>} phone → sorted array of unix ms timestamps */
const windowMap = new Map();

/**
 * Check whether a phone number is within rate limits.
 * @param {string} phone
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkRateLimit(phone) {
  const now = Date.now();
  const oneMinAgo = now - 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  let events = windowMap.get(phone) ?? [];
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

  events.push(now);
  windowMap.set(phone, events);
  return { allowed: true };
}

/**
 * @param {'minute'|'day'} reason
 * @returns {string}
 */
export function rateLimitReply(reason) {
  if (reason === 'minute') return 'Please slow down. Wait a minute before sending another question.';
  return 'Daily limit reached. Try again tomorrow.';
}

/**
 * Clear the in-memory store for a phone (used in tests).
 * @param {string} phone
 */
export function clearRateLimit(phone) {
  windowMap.delete(phone);
}

/**
 * Prune old rate_events from the DB (called by cron job in server.js).
 * Takes the db instance as a parameter to avoid circular imports.
 * @param {object} db - sql.js database instance
 */
export function pruneRateEvents(db) {
  if (!db) return;
  try {
    db.run('DELETE FROM rate_events WHERE at < ?', [Date.now() - 24 * 60 * 60 * 1000]);
    logger.debug('Pruned old rate_events');
  } catch (err) {
    logger.warn({ err }, 'Failed to prune rate_events');
  }
}
