/**
 * test/setup.js
 * Global test setup — runs before any test file is loaded.
 * Sets all required environment variables so config.js doesn't throw.
 */

// Must be set before any module that imports config.js is loaded
process.env.DB_PATH            = ':memory:';
process.env.GEMINI_API_KEY     = 'test-gemini-key';
process.env.WEBHOOK_SECRET     = 'test-secret-that-is-long-enough-32ch';
process.env.TEXTBEE_API_KEY    = 'test-tb-key';
process.env.SMS_PROVIDER       = 'textbee';
process.env.FREE_TRIAL_CREDITS = '3';
process.env.RATE_LIMIT_PER_MIN = '3';
process.env.RATE_LIMIT_PER_DAY = '5';
process.env.MAINTENANCE_MODE   = 'false';
process.env.NODE_ENV           = 'test';
