/**
 * server.js
 * Express application entry point.
 *
 * Responsibilities:
 *  - Boot config validation (fails fast if env vars missing)
 *  - Apply security middleware (helmet, rate limiting, body size limits)
 *  - Capture raw body for TextBee HMAC signature verification
 *  - Mount all routes
 *  - Start the daily maintenance cron job
 *  - /healthz endpoint
 *  - Graceful shutdown on SIGTERM/SIGINT
 */

import './config.js'; // validate env vars before anything else
import express from 'express';
import helmet from 'helmet';
import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { getDb, runMaintenance } from './db.js';
import { pruneRateEvents } from './services/rateLimit.js';

import smsRoutes from './routes/sms.js';
import deliveryRoutes from './routes/delivery.js';
import ussdRoutes from './routes/ussd.js';
import mpesaRoutes from './routes/mpesa.js';

const app = express();

// ── Security middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.set('trust proxy', 1); // needed for correct IP behind Nginx/Render/Railway

// ── Body size limits ──────────────────────────────────────────────────────────
const BODY_LIMIT = '64kb';

// Raw body capture for TextBee HMAC signature verification.
// We attach req.rawBody (Buffer) before parsing so the signature check
// can work on the exact bytes TextBee signed.
app.use((req, res, next) => {
  let chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
  req.on('error', next);
});

// JSON parser (TextBee webhooks)
app.use(express.json({ limit: BODY_LIMIT }));

// URL-encoded parser (Africa's Talking webhooks)
app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

// ── Global IP rate limit (basic DoS protection) ───────────────────────────────
// Simple in-memory counter — good enough for a single-instance deployment.
const ipHits = new Map();
const IP_LIMIT = 200;     // requests per minute per IP
const IP_WINDOW = 60_000; // 1 minute in ms

app.use((req, res, next) => {
  // Skip for health check
  if (req.path === '/healthz') return next();

  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = ipHits.get(ip) ?? { count: 0, resetAt: now + IP_WINDOW };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + IP_WINDOW;
  }

  entry.count++;
  ipHits.set(ip, entry);

  if (entry.count > IP_LIMIT) {
    logger.warn({ ip }, 'Global IP rate limit exceeded');
    return res.status(429).json({ error: 'Too many requests' });
  }

  next();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => {
  try {
    // Simple DB liveness check
    getDb().prepare('SELECT 1').get();
    res.status(200).json({ ok: true, uptime: process.uptime() });
  } catch (err) {
    logger.error({ err }, 'Health check DB failed');
    res.status(500).json({ ok: false, error: 'DB unavailable' });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/webhooks/sms', smsRoutes);
app.use('/webhooks/delivery', deliveryRoutes);
app.use('/webhooks/ussd', ussdRoutes);
app.use('/webhooks/mpesa', mpesaRoutes);

// 404 for anything else
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled Express error');
  res.status(500).json({ error: 'Internal server error' });
});

// ── Cron: daily maintenance at 02:00 ─────────────────────────────────────────
cron.schedule('0 2 * * *', () => {
  logger.info('Running scheduled maintenance');
  try {
    runMaintenance();
    pruneRateEvents();
  } catch (err) {
    logger.error({ err }, 'Maintenance job failed');
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      env: config.nodeEnv,
      provider: config.smsProvider,
      maintenance: config.maintenanceMode,
    },
    'SMS-AI server started',
  );
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received, closing server');
  server.close(() => {
    logger.info('HTTP server closed');
    try {
      getDb().close();
      logger.info('Database closed');
    } catch (err) {
      logger.error({ err }, 'Error closing database');
    }
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export default app;
