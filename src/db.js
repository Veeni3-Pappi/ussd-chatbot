/**
 * db.js
 * Single module for all SQLite access. Swap this for Postgres by replacing
 * the driver and translating the SQL — all business logic stays unchanged.
 *
 * Schema versioning: we use a simple user_version PRAGMA.
 * Add a migration block for each new version.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sms-ai.db');

// Ensure the data directory exists
import { mkdirSync } from 'fs';
mkdirSync(path.dirname(DB_PATH), { recursive: true });

/** @type {import('better-sqlite3').Database} */
let _db;

/**
 * Open (or reuse) the database connection.
 * @returns {import('better-sqlite3').Database}
 */
export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  runMigrations(_db);
  logger.info({ path: DB_PATH }, 'Database opened');
  return _db;
}

// ─── Migrations ──────────────────────────────────────────────────────────────

const MIGRATIONS = [
  // Version 1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS users (
    phone           TEXT PRIMARY KEY,
    credits         INTEGER NOT NULL DEFAULT 0,
    opted_out       INTEGER NOT NULL DEFAULT 0,
    first_reply_sent INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phone         TEXT NOT NULL,
    direction     TEXT NOT NULL CHECK(direction IN ('in','out')),
    body          TEXT,
    at_message_id TEXT,
    segments      INTEGER,
    cost          TEXT,
    status        TEXT NOT NULL DEFAULT 'queued',
    created_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

  CREATE TABLE IF NOT EXISTS processed_ids (
    message_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credit_ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT NOT NULL,
    delta      INTEGER NOT NULL,
    reason     TEXT NOT NULL CHECK(reason IN ('trial','question','topup','admin','refund')),
    ref        TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_phone ON credit_ledger(phone);

  CREATE TABLE IF NOT EXISTS rate_events (
    phone TEXT NOT NULL,
    at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rate_phone_at ON rate_events(phone, at);

  CREATE TABLE IF NOT EXISTS payments (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    checkout_request_id  TEXT UNIQUE NOT NULL,
    phone                TEXT NOT NULL,
    amount               INTEGER NOT NULL,
    status               TEXT NOT NULL DEFAULT 'pending',
    receipt              TEXT,
    created_at           TEXT NOT NULL
  );
  `,
];

/**
 * Run any pending migrations.
 * @param {import('better-sqlite3').Database} db
 */
function runMigrations(db) {
  const currentVersion = db.pragma('user_version', { simple: true });
  logger.debug({ currentVersion, target: MIGRATIONS.length }, 'Checking migrations');

  for (let v = currentVersion; v < MIGRATIONS.length; v++) {
    logger.info({ version: v + 1 }, 'Running migration');
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// ─── User helpers ─────────────────────────────────────────────────────────────

/**
 * Get user by phone, or null.
 * @param {string} phone
 */
export function getUser(phone) {
  return getDb().prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

/**
 * Get or create a user. New users receive FREE_TRIAL_CREDITS.
 * Returns { user, isNew }.
 * @param {string} phone
 * @param {number} freeTrialCredits
 * @returns {{ user: object, isNew: boolean }}
 */
export function getOrCreateUser(phone, freeTrialCredits) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (existing) return { user: existing, isNew: false };

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO users (phone, credits, opted_out, first_reply_sent, created_at) VALUES (?, ?, 0, 0, ?)',
    ).run(phone, freeTrialCredits, now);

    db.prepare(
      'INSERT INTO credit_ledger (phone, delta, reason, ref, created_at) VALUES (?, ?, ?, NULL, ?)',
    ).run(phone, freeTrialCredits, 'trial', now);
  })();

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  return { user, isNew: true };
}

/**
 * Deduct 1 credit and record in ledger atomically.
 * @param {string} phone
 * @param {string} [ref] - optional message reference
 */
export function deductCredit(phone, ref = null) {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE users SET credits = credits - 1 WHERE phone = ?').run(phone);
    db.prepare(
      'INSERT INTO credit_ledger (phone, delta, reason, ref, created_at) VALUES (?, -1, ?, ?, ?)',
    ).run(phone, 'question', ref, now);
  })();
}

/**
 * Add credits and record in ledger atomically.
 * @param {string} phone
 * @param {number} amount
 * @param {'topup'|'admin'|'refund'} reason
 * @param {string} [ref]
 */
export function addCredits(phone, amount, reason, ref = null) {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO users (phone, credits, opted_out, first_reply_sent, created_at) VALUES (?, ?, 0, 0, ?) ON CONFLICT(phone) DO UPDATE SET credits = credits + excluded.credits',
    ).run(phone, amount, now);
    db.prepare(
      'INSERT INTO credit_ledger (phone, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(phone, amount, reason, ref, now);
  })();
}

/**
 * Set opted_out status for a phone number.
 * @param {string} phone
 * @param {boolean} optedOut
 */
export function setOptedOut(phone, optedOut) {
  getDb().prepare('UPDATE users SET opted_out = ? WHERE phone = ?').run(optedOut ? 1 : 0, phone);
}

/**
 * Mark first_reply_sent = 1 for a phone.
 * @param {string} phone
 */
export function markFirstReplySent(phone) {
  getDb().prepare('UPDATE users SET first_reply_sent = 1 WHERE phone = ?').run(phone);
}

// ─── Message helpers ──────────────────────────────────────────────────────────

/**
 * Log an inbound or outbound message.
 * @param {{ phone: string, direction: 'in'|'out', body?: string, atMessageId?: string, segments?: number, cost?: string, status?: string }} msg
 * @returns {number} inserted row id
 */
export function logMessage(msg) {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `INSERT INTO messages (phone, direction, body, at_message_id, segments, cost, status, created_at)
       VALUES (@phone, @direction, @body, @atMessageId, @segments, @cost, @status, @createdAt)`,
    )
    .run({
      phone: msg.phone,
      direction: msg.direction,
      body: msg.body ?? null,
      atMessageId: msg.atMessageId ?? null,
      segments: msg.segments ?? null,
      cost: msg.cost ?? null,
      status: msg.status ?? 'queued',
      createdAt: now,
    });
  return result.lastInsertRowid;
}

/**
 * Update message status and/or at_message_id by row id.
 * @param {number} rowId
 * @param {{ status?: string, atMessageId?: string, segments?: number, cost?: string }} updates
 */
export function updateMessage(rowId, updates) {
  const db = getDb();
  if (updates.status !== undefined) {
    db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(updates.status, rowId);
  }
  if (updates.atMessageId !== undefined) {
    db.prepare('UPDATE messages SET at_message_id = ? WHERE id = ?').run(updates.atMessageId, rowId);
  }
  if (updates.segments !== undefined) {
    db.prepare('UPDATE messages SET segments = ? WHERE id = ?').run(updates.segments, rowId);
  }
  if (updates.cost !== undefined) {
    db.prepare('UPDATE messages SET cost = ? WHERE id = ?').run(updates.cost, rowId);
  }
}

/**
 * Update message status by at_message_id (used by delivery webhooks).
 * @param {string} atMessageId
 * @param {string} status
 */
export function updateMessageByAtId(atMessageId, status) {
  getDb()
    .prepare("UPDATE messages SET status = ? WHERE at_message_id = ?")
    .run(status, atMessageId);
}

/**
 * Get the last N exchanges (in+out pairs) for a phone within the last 24 hours.
 * Returns up to 2*limit rows ordered oldest-first.
 * @param {string} phone
 * @param {number} limit - number of exchanges (each = 1 in + 1 out)
 * @returns {Array<{direction: string, body: string}>}
 */
export function getRecentHistory(phone, limit = 3) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return getDb()
    .prepare(
      `SELECT direction, body FROM messages
       WHERE phone = ? AND created_at >= ? AND body IS NOT NULL
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(phone, since, limit * 2)
    .reverse();
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Returns true if message_id was already processed (i.e. is a duplicate).
 * Also inserts the id so future calls return true.
 * @param {string} messageId
 * @returns {boolean}
 */
export function checkAndMarkProcessed(messageId) {
  const db = getDb();
  const existing = db.prepare('SELECT 1 FROM processed_ids WHERE message_id = ?').get(messageId);
  if (existing) return true;
  db.prepare('INSERT OR IGNORE INTO processed_ids (message_id, created_at) VALUES (?, ?)').run(
    messageId,
    new Date().toISOString(),
  );
  return false;
}

// ─── Maintenance (scheduled cleanup) ─────────────────────────────────────────

/**
 * Purge message bodies older than 24h and processed_ids older than 7 days.
 * Call this from a cron job.
 */
export function runMaintenance() {
  const db = getDb();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const purged = db
    .prepare("UPDATE messages SET body = NULL WHERE body IS NOT NULL AND created_at < ?")
    .run(oneDayAgo);

  const deleted = db
    .prepare('DELETE FROM processed_ids WHERE created_at < ?')
    .run(sevenDaysAgo);

  logger.info(
    { purgedBodies: purged.changes, deletedIds: deleted.changes },
    'Maintenance complete',
  );
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

export function getStats() {
  const db = getDb();
  return {
    totalUsers: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    totalMessages: db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'in'").get().c,
    totalOutbound: db.prepare("SELECT COUNT(*) as c FROM messages WHERE direction = 'out'").get().c,
    avgSegments: db.prepare("SELECT AVG(segments) as a FROM messages WHERE direction = 'out' AND segments IS NOT NULL").get().a,
    totalCreditLedgerRows: db.prepare('SELECT COUNT(*) as c FROM credit_ledger').get().c,
    messagesPerDay: db.prepare(`
      SELECT DATE(created_at) as day, COUNT(*) as count
      FROM messages WHERE direction = 'in'
      GROUP BY day ORDER BY day DESC LIMIT 7
    `).all(),
  };
}
