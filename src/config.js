/**
 * config.js
 * Reads and validates all environment variables at startup.
 * Import this module before anything else so bad config fails fast.
 */

import 'dotenv/config';

/**
 * Require a non-empty env var, throw on startup if missing.
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function required(name, fallback) {
  const val = process.env[name] ?? fallback;
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

/**
 * Read an optional env var with a default.
 * @param {string} name
 * @param {string} defaultVal
 * @returns {string}
 */
function optional(name, defaultVal) {
  return process.env[name] || defaultVal;
}

/**
 * Parse a positive integer env var.
 * @param {string} name
 * @param {number} defaultVal
 * @returns {number}
 */
function int(name, defaultVal) {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) throw new Error(`Env var ${name} must be a non-negative integer, got: ${raw}`);
  return n;
}

const provider = optional('SMS_PROVIDER', 'textbee');
if (!['textbee', 'africastalking'].includes(provider)) {
  throw new Error(`SMS_PROVIDER must be "textbee" or "africastalking", got: ${provider}`);
}

export const config = {
  port: int('PORT', 3000),
  nodeEnv: optional('NODE_ENV', 'development'),
  webhookSecret: required('WEBHOOK_SECRET'),
  maintenanceMode: optional('MAINTENANCE_MODE', 'false') === 'true',

  smsProvider: provider,

  // TextBee
  textbee: {
    apiKey: optional('TEXTBEE_API_KEY', ''),
    deviceId: optional('TEXTBEE_DEVICE_ID', ''),
    webhookSecret: optional('TEXTBEE_WEBHOOK_SECRET', ''),
    baseUrl: optional('TEXTBEE_BASE_URL', 'https://api.textbee.dev/api/v1'),
  },

  // Africa's Talking
  at: {
    username: optional('AT_USERNAME', 'sandbox'),
    apiKey: optional('AT_API_KEY', ''),
    senderId: optional('AT_SENDER_ID', ''),
  },

  // Gemini
  gemini: {
    apiKey: required('GEMINI_API_KEY'),
    model: optional('GEMINI_MODEL', 'gemini-2.0-flash-lite'),
    priceInPerM: parseFloat(optional('GEMINI_PRICE_IN_PER_M', '0.075')),
    priceOutPerM: parseFloat(optional('GEMINI_PRICE_OUT_PER_M', '0.30')),
  },

  // Credits & limits
  freeTrialCredits: int('FREE_TRIAL_CREDITS', 3),
  maxSegments: int('MAX_SEGMENTS', 2),
  rateLimitPerMin: int('RATE_LIMIT_PER_MIN', 5),
  rateLimitPerDay: int('RATE_LIMIT_PER_DAY', 30),

  // Credit packs: "20:10,50:30,100:70" → [{ kes: 20, credits: 10 }, ...]
  creditPacks: optional('CREDIT_PACKS', '20:10,50:30,100:70')
    .split(',')
    .map((pair) => {
      const [kes, credits] = pair.split(':').map(Number);
      return { kes, credits };
    }),
};
