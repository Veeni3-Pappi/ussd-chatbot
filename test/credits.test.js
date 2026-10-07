/**
 * test/credits.test.js
 * Unit tests for the credit system (db.js + services/credits.js)
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

import { getOrCreateUser, deductCredit, addCredits as dbAddCredits, getUser, getDb, openDb } from '../src/db.js';
import { checkCredits, chargeCredit, balanceReply, noCreditsReply } from '../src/services/credits.js';

/** sql.js helper: get one row */
function dbGet(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return row;
}

const PHONE = '+254700000001';

beforeAll(async () => {
  await openDb();
});

beforeEach(() => {
  const db = getDb();
  db.run('DELETE FROM users');
  db.run('DELETE FROM credit_ledger');
});

// ── getOrCreateUser ───────────────────────────────────────────────────────────

describe('getOrCreateUser', () => {
  it('creates new user with free trial credits', () => {
    const { user, isNew } = getOrCreateUser(PHONE, 3);
    expect(isNew).toBe(true);
    expect(user.credits).toBe(3);
    expect(user.opted_out).toBe(0);
  });

  it('returns existing user on second call', () => {
    getOrCreateUser(PHONE, 3);
    const { user, isNew } = getOrCreateUser(PHONE, 3);
    expect(isNew).toBe(false);
    expect(user.credits).toBe(3);
  });

  it('writes a trial entry to credit_ledger', () => {
    getOrCreateUser(PHONE, 3);
    const row = dbGet("SELECT * FROM credit_ledger WHERE phone = ? AND reason = 'trial'", [PHONE]);
    expect(row).toBeTruthy();
    expect(row.delta).toBe(3);
  });
});

// ── deductCredit ──────────────────────────────────────────────────────────────

describe('deductCredit', () => {
  it('reduces credits by 1', () => {
    getOrCreateUser(PHONE, 3);
    deductCredit(PHONE);
    expect(getUser(PHONE).credits).toBe(2);
  });

  it('writes a question entry to credit_ledger', () => {
    getOrCreateUser(PHONE, 3);
    deductCredit(PHONE, 'MSG-001');
    const row = dbGet("SELECT * FROM credit_ledger WHERE phone = ? AND reason = 'question'", [PHONE]);
    expect(row.delta).toBe(-1);
    expect(row.ref).toBe('MSG-001');
  });

  it('does not double-charge on a single call', () => {
    getOrCreateUser(PHONE, 3);
    deductCredit(PHONE);
    expect(getUser(PHONE).credits).toBe(2);
  });
});

// ── addCredits ────────────────────────────────────────────────────────────────

describe('addCredits', () => {
  it('increases credits correctly', () => {
    getOrCreateUser(PHONE, 0);
    dbAddCredits(PHONE, 10, 'admin');
    expect(getUser(PHONE).credits).toBe(10);
  });

  it('creates user if not exists when adding credits', () => {
    dbAddCredits(PHONE, 5, 'topup', 'MPESA-001');
    expect(getUser(PHONE).credits).toBe(5);
  });
});

// ── checkCredits ──────────────────────────────────────────────────────────────

describe('checkCredits', () => {
  it('returns ok=true when credits > 0', () => {
    getOrCreateUser(PHONE, 3);
    const r = checkCredits(PHONE);
    expect(r.ok).toBe(true);
    expect(r.credits).toBe(3);
  });

  it('returns ok=false when credits = 0', () => {
    getOrCreateUser(PHONE, 0);
    const r = checkCredits(PHONE);
    expect(r.ok).toBe(false);
  });

  it('auto-creates new user with trial credits', () => {
    const r = checkCredits('+254700000099');
    expect(r.isNew).toBe(true);
    expect(r.credits).toBeGreaterThan(0);
  });
});

// ── chargeCredit ──────────────────────────────────────────────────────────────

describe('chargeCredit', () => {
  it('deducts 1 credit', () => {
    getOrCreateUser(PHONE, 5);
    chargeCredit(PHONE);
    expect(getUser(PHONE).credits).toBe(4);
  });
});

// ── Reply text helpers ────────────────────────────────────────────────────────

describe('balanceReply', () => {
  it('handles zero', () => expect(balanceReply(0)).toContain('0'));
  it('handles singular', () => expect(balanceReply(1)).toContain('1 credit'));
  it('handles plural', () => expect(balanceReply(5)).toContain('5 credits'));
});

describe('noCreditsReply', () => {
  it('returns a non-empty string', () => expect(noCreditsReply().length).toBeGreaterThan(0));
});
