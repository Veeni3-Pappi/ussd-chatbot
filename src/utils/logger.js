/**
 * utils/logger.js
 * Pino logger. Pretty-prints in development, JSON in production.
 * Never log full message bodies at info level — use debug only.
 */

import pino from 'pino';

const isDev = (process.env.NODE_ENV || 'development') === 'development';

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    redact: {
      // Ensure API keys never appear in logs even if accidentally passed in objects
      paths: [
        'apiKey', 'api_key', 'x-api-key',
        'GEMINI_API_KEY', 'AT_API_KEY', 'TEXTBEE_API_KEY',
        'signingSecret', 'webhookSecret',
      ],
      censor: '[REDACTED]',
    },
  },
  isDev
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
    : undefined,
);

/**
 * Return a masked phone number for safe logging.
 * +254712345678 → +2547****5678
 * @param {string} phone
 * @returns {string}
 */
export function maskPhone(phone) {
  if (!phone || phone.length < 8) return '****';
  return phone.slice(0, 5) + '****' + phone.slice(-4);
}
