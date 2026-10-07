/**
 * db.js
 * Single module for all SQLite access using sql.js (pure JavaScript — no native build tools needed).
 * To swap for better-sqlite3 or Postgres later, only this file changes.
 *
 * sql.js keeps the database in memory. We persist it to disk on every write
 * using a debounced flush so the file stays current without thrashing.
 *
 * Schema versioning: stored in a meta table (sql.js has no PRAGMA user_version).
 */

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sms-ai.db');

// Ensure data directory exists (skip for :memory: used in tests)
if (DB_PATH !== ':memory:') {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

/** @type {import('sql.js').Database} */
let _db;

/** Debounce timer for flushing DB to disk */
let _flushTimer = null;

/**
 * Schedule a flush to disk (debounced 500ms).
 * No-op when using :memory: path.
 */
function schedulePersist() {
  if (DB_PATH === ':memory:') return;
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    try {
      const data = _db.export();
      writeFileSync(DB_PATH, Buffer.from(data));
    } catch (err) {
      logger.error({ err }, 'Failed to persist database to disk');
    }
  }, 500);
}

/**
 * Open (or reuse) the database. Async because sql.js WASM must be initialized.
 * Call this once at startup; subsequent calls return the cached instance.
 * @returns {Promise<import('sql.js').Database>}
 */
export async function openDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  if (DB_PATH !== ':memory:' && existsSync(DB_PATH)) {
    const fileBuffer = readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
    logger.info({ path: DB_PATH }, 'Database loaded from file');
  } else {
    _db = new SQL.Database();
    logger.info({ path: DB_PATH }, 'New database created');
  }

  // Enable WAL-equivalent pragmas (sql.js supports these)
  _db.run('PRAGMA foreign_keys = ON');

  runMigrations(_db);
  return _db;
}

/**
 * Get the synchronous DB instance. Must call openDb() first at startup.
 * @returns {import('sql.js').Database}
 */
export function getDb() {
  if (!_db) throw new Error('Database not initialized. Call openDb() first.');
  return _db;
}

// ─── sql.js helper wrappers (match better-sqlite3 API style) ─────────────────

/**
 * Run a statement that returns no rows (INSERT, UPDATE, DELETE, CREATE).
 * @param {string} sql
 * @param {any[]} [params]
 */
function run(sql, params = []) {
  _db.run(sql, params);
  schedulePersist();
}

/**
 * Get a single row or undefined.
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {object|undefined}
 */
function get(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

/**
 * Get all rows as an array of objects.
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {object[]}
 */
function all(sql, params = []) {
  const stmt = _db.prepare(sql);
  const rows = [];
  stmt.bind(params);
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Run multiple statements in a transaction.
 * @param {Function} fn
 */
function transaction(fn) {
  _db.run('BEGIN');
  try {
    fn();
    _db.run('COMMIT');
    schedulePersist();
  } catch (err) {
    _db.run('ROLLBACK');
    throw err;
  }
}

// ─── Migrations ───────────────────────────────────────────────────────────────

const MIGRATIONS = [
  // Version 1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO schema_version VALUES (0);

  CREATE TABLE IF NOT EXISTS users (
    phone            TEXT PRIMARY KEY,
    credits          INTEGER NOT NULL DEFAULT 0,
    opted_out        INTEGER NOT NULL DEFAULT 0,
    first_reply_sent INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL
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
    reason     TEXT NOT NULL,
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

function runMigrations(db) {
  // Ensure schema_version table exists
  db.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0)`);
  const vRow = get('SELECT version FROM schema_version LIMIT 1');
  let currentVersion = vRow ? (vRow.version ?? 0) : 0;

  logger.debug({ currentVersion, target: MIGRATIONS.length }, 'Checking migrations');

  for (let v = currentVersion; v < MIGRATIONS.length; v++) {
    logger.info({ version: v + 1 }, 'Running migration');
    db.run('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.run('UPDATE schema_version SET version = ?', [v + 1]);
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
  }
}

// ─── User helpers ─────────────────────────────────────────────────────────────

export function getUser(phone) {
  return get('SELECT * FROM users WHERE phone = ?', [phone]);
}

export function getOrCreateUser(phone, freeTrialCredits) {
  const existing = get('SELECT * FROM users WHERE phone = ?', [phone]);
  if (existing) return { user: existing, isNew: false };

  const now = new Date().toISOString();
  transaction(() => {
    run(
      'INSERT INTO users (phone, credits, opted_out, first_reply_sent, created_at) VALUES (?, ?, 0, 0, ?)',
      [phone, freeTrialCredits, now],
    );
    run(
      'INSERT INTO credit_ledger (phone, delta, reason, ref, created_at) VALUES (?, ?, ?, NULL, ?)',
      [phone, freeTrialCredits, 'trial', now],
    );
  });

  const user = get('SELECT * FROM users WHERE phone = ?', [phone]);
  return { user, isNew: true };
}

export function deductCredit(phone, ref = null) {
  const now = new Date().toISOString();
  transaction(() => {
    run('UPDATE users SET credits = credits - 1 WHERE phone = ?', [phone]);
    run(
      'INSERT INTO credit_ledger (phone, delta, reason, ref, created_at) VALUES (?, -1, ?, ?, ?)',
      [phone, 'question', ref, now],
    );
  });
}

export function addCredits(phone, amount, reason, ref = null) {
  const now = new Date().toISOString();
  transaction(() => {
    const existing = get('SELECT credits FROM users WHERE phone = ?', [phone]);
    if (existing) {
      run('UPDATE users SET credits = credits + ? WHERE phone = ?', [amount, phone]);
    } else {
      run(
        'INSERT INTO users (phone, credits, opted_out, first_reply_sent, created_at) VALUES (?, ?, 0, 0, ?)',
        [phone, amount, now],
      );
    }
    run(
      'INSERT INTO credit_ledger (phone, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)',
      [phone, amount, reason, ref, now],
    );
  });
}

export function setOptedOut(phone, optedOut) {
  run('UPDATE users SET opted_out = ? WHERE phone = ?', [optedOut ? 1 : 0, phone]);
}

export function markFirstReplySent(phone) {
  run('UPDATE users SET first_reply_sent = 1 WHERE phone = ?', [phone]);
}

// ─── Message helpers ──────────────────────────────────────────────────────────

export function logMessage(msg) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO messages (phone, direction, body, at_message_id, segments, cost, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.phone,
      msg.direction,
      msg.body ?? null,
      msg.atMessageId ?? null,
      msg.segments ?? null,
      msg.cost ?? null,
      msg.status ?? 'queued',
      now,
    ],
  );
  // Get last inserted rowid
  const row = get('SELECT last_insert_rowid() as id');
  return row ? row.id : null;
}

export function updateMessage(rowId, updates) {
  if (updates.status !== undefined) {
    run('UPDATE messages SET status = ? WHERE id = ?', [updates.status, rowId]);
  }
  if (updates.atMessageId !== undefined) {
    run('UPDATE messages SET at_message_id = ? WHERE id = ?', [updates.atMessageId, rowId]);
  }
  if (updates.segments !== undefined) {
    run('UPDATE messages SET segments = ? WHERE id = ?', [updates.segments, rowId]);
  }
  if (updates.cost !== undefined) {
    run('UPDATE messages SET cost = ? WHERE id = ?', [updates.cost, rowId]);
  }
}

export function updateMessageByAtId(atMessageId, status) {
  run('UPDATE messages SET status = ? WHERE at_message_id = ?', [status, atMessageId]);
}

export function getRecentHistory(phone, limit = 3) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return all(
    `SELECT direction, body FROM messages
     WHERE phone = ? AND created_at >= ? AND body IS NOT NULL
     ORDER BY created_at DESC
     LIMIT ?`,
    [phone, since, limit * 2],
  ).reverse();
}

// ─── Deduplication ────────────────────────────────────────────────────────────

export function checkAndMarkProcessed(messageId) {
  const existing = get('SELECT 1 as found FROM processed_ids WHERE message_id = ?', [messageId]);
  if (existing) return true;
  run('INSERT OR IGNORE INTO processed_ids (message_id, created_at) VALUES (?, ?)', [
    messageId,
    new Date().toISOString(),
  ]);
  return false;
}

// ─── Maintenance ──────────────────────────────────────────────────────────────

export function runMaintenance() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  run("UPDATE messages SET body = NULL WHERE body IS NOT NULL AND created_at < ?", [oneDayAgo]);
  run('DELETE FROM processed_ids WHERE created_at < ?', [sevenDaysAgo]);

  logger.info('Maintenance complete');
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

export function getStats() {
  return {
    totalUsers: get('SELECT COUNT(*) as c FROM users').c,
    totalMessages: get("SELECT COUNT(*) as c FROM messages WHERE direction = 'in'").c,
    totalOutbound: get("SELECT COUNT(*) as c FROM messages WHERE direction = 'out'").c,
    avgSegments: get("SELECT AVG(segments) as a FROM messages WHERE direction = 'out' AND segments IS NOT NULL").a,
    totalCreditLedgerRows: get('SELECT COUNT(*) as c FROM credit_ledger').c,
    messagesPerDay: all(
      `SELECT DATE(created_at) as day, COUNT(*) as count
       FROM messages WHERE direction = 'in'
       GROUP BY day ORDER BY day DESC LIMIT 7`,
    ),
  };
}

// ─── Close ────────────────────────────────────────────────────────────────────

export function closeDb() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    // Final flush before close
    if (DB_PATH !== ':memory:' && _db) {
      try {
        const data = _db.export();
        writeFileSync(DB_PATH, Buffer.from(data));
      } catch (_) {}
    }
  }
  if (_db) {
    _db.close();
    _db = null;
  }
}
