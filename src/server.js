/**
 * server.js
 * Express application entry point.
 */

import './config.js';
import express from 'express';
import helmet from 'helmet';
import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { openDb, getDb, runMaintenance, closeDb } from './db.js';
import { pruneRateEvents } from './services/rateLimit.js';

import smsRoutes from './routes/sms.js';
import deliveryRoutes from './routes/delivery.js';
import ussdRoutes from './routes/ussd.js';
import mpesaRoutes from './routes/mpesa.js';

const app = express();

// ── Security middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.set('trust proxy', 1);

// ── Body parsers & raw body capture for TextBee HMAC verification ─────────────
const BODY_LIMIT = '64kb';
app.use(express.json({
  limit: BODY_LIMIT,
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({
  extended: false,
  limit: BODY_LIMIT,
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

// ── Global IP rate limit ──────────────────────────────────────────────────────
const ipHits = new Map();
const IP_LIMIT = 200;
const IP_WINDOW = 60_000;

app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = ipHits.get(ip) ?? { count: 0, resetAt: now + IP_WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + IP_WINDOW; }
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
    getDb(); // throws if DB not initialized
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

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled Express error');
  res.status(500).json({ error: 'Internal server error' });
});

// ── Cron: daily maintenance at 02:00 ─────────────────────────────────────────
cron.schedule('0 2 * * *', () => {
  logger.info('Running scheduled maintenance');
  try { runMaintenance(); pruneRateEvents(getDb()); }
  catch (err) { logger.error({ err }, 'Maintenance job failed'); }
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let server;

function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');
  server.close(() => {
    logger.info('HTTP server closed');
    closeDb();
    logger.info('Database closed');
    process.exit(0);
  });
  setTimeout(() => { logger.error('Graceful shutdown timed out'); process.exit(1); }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Boot ──────────────────────────────────────────────────────────────────────
async function start() {
  await openDb(); // initialize sql.js WASM + load/create DB file
  server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv, provider: config.smsProvider },
      'SMS-AI server started',
    );
  });
}

if (process.env.NODE_ENV !== 'test') {
  start().catch((err) => {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  });
}

export default app;
