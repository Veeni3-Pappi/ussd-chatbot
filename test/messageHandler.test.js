/**
 * test/messageHandler.test.js
 * Integration tests for the full inbound SMS pipeline.
 * Mocks: smsProvider (sendSms), llm (generateReply)
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// ── Mocks (hoisted by vitest — must be declared before any imports) ────────────
vi.mock('../src/providers/smsProvider.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendSms: vi.fn().mockResolvedValue({ messageId: 'mock-msg-id', cost: null }),
  };
});

vi.mock('../src/llm/llm.js', () => ({
  generateReply: vi.fn().mockResolvedValue({
    text: 'Malaria is caused by a Plasmodium parasite spread by mosquitoes. Use nets.',
    inputTokens: 50,
    outputTokens: 80,
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { handleInboundSms } from '../src/services/messageHandler.js';
import { sendSms } from '../src/providers/smsProvider.js';
import { generateReply } from '../src/llm/llm.js';
import { getDb, openDb } from '../src/db.js';
import { clearRateLimit } from '../src/services/rateLimit.js';
import { config } from '../src/config.js';

const PHONE = '+254711000001';

// ── sql.js query helpers ──────────────────────────────────────────────────────
function dbGet(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return row;
}

function dbAll(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function makeMsg(overrides = {}) {
  return {
    from: PHONE,
    text: 'What causes malaria?',
    messageId: `msg-${Date.now()}-${Math.random()}`,
    ...overrides,
  };
}

beforeAll(async () => {
  await openDb();
});

beforeEach(() => {
  vi.clearAllMocks();
  clearRateLimit(PHONE);
  const db = getDb();
  db.run('DELETE FROM users');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM processed_ids');
  db.run('DELETE FROM credit_ledger');
  db.run('DELETE FROM rate_events');
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('handleInboundSms — happy path', () => {
  it('processes a question and sends a reply', async () => {
    await handleInboundSms(makeMsg());
    expect(generateReply).toHaveBeenCalledOnce();
    expect(sendSms).toHaveBeenCalledOnce();
    const [to, text] = sendSms.mock.calls[0];
    expect(to).toBe(PHONE);
    expect(text.length).toBeGreaterThan(0);
  });

  it('deducts 1 credit after successful send', async () => {
    await handleInboundSms(makeMsg());
    const user = dbGet('SELECT * FROM users WHERE phone = ?', [PHONE]);
    expect(user.credits).toBe(2);
  });

  it('logs inbound and outbound messages in DB', async () => {
    await handleInboundSms(makeMsg());
    const msgs = dbAll('SELECT * FROM messages WHERE phone = ?', [PHONE]);
    expect(msgs.filter(m => m.direction === 'in').length).toBe(1);
    expect(msgs.filter(m => m.direction === 'out').length).toBe(1);
  });

  it('marks first reply sent flag', async () => {
    await handleInboundSms(makeMsg());
    const user = dbGet('SELECT * FROM users WHERE phone = ?', [PHONE]);
    expect(user.first_reply_sent).toBe(1);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('handleInboundSms — deduplication', () => {
  it('ignores a duplicate messageId', async () => {
    const msg = makeMsg({ messageId: 'fixed-id-001' });
    await handleInboundSms(msg);
    await handleInboundSms(msg);
    expect(sendSms).toHaveBeenCalledOnce();
  });

  it('does not double-charge credits on duplicate', async () => {
    const msg = makeMsg({ messageId: 'fixed-id-002' });
    await handleInboundSms(msg);
    await handleInboundSms(msg);
    const user = dbGet('SELECT * FROM users WHERE phone = ?', [PHONE]);
    expect(user.credits).toBe(2);
  });
});

// ── Keywords ──────────────────────────────────────────────────────────────────

describe('handleInboundSms — keywords', () => {
  it('BAL replies with credit balance (no LLM call)', async () => {
    await handleInboundSms(makeMsg({ text: 'BAL' }));
    expect(generateReply).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledOnce();
    const [, text] = sendSms.mock.calls[0];
    expect(text).toMatch(/credit/i);
  });

  it('HELP replies with usage guide (no LLM call)', async () => {
    await handleInboundSms(makeMsg({ text: 'HELP' }));
    expect(generateReply).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledOnce();
  });

  it('STOP opts out and sends confirmation', async () => {
    await handleInboundSms(makeMsg({ text: 'STOP' }));
    const user = dbGet('SELECT * FROM users WHERE phone = ?', [PHONE]);
    expect(user.opted_out).toBe(1);
    expect(sendSms).toHaveBeenCalledOnce();
  });

  it('START re-opts in after STOP', async () => {
    await handleInboundSms(makeMsg({ text: 'STOP', messageId: 'stop-001' }));
    await handleInboundSms(makeMsg({ text: 'START', messageId: 'start-001' }));
    const user = dbGet('SELECT * FROM users WHERE phone = ?', [PHONE]);
    expect(user.opted_out).toBe(0);
  });

  it('ignores messages from opted-out numbers', async () => {
    await handleInboundSms(makeMsg({ text: 'STOP', messageId: 'stop-002' }));
    vi.clearAllMocks();
    await handleInboundSms(makeMsg({ text: 'What causes malaria?', messageId: 'after-stop' }));
    expect(generateReply).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('BAL and HELP do not charge credits', async () => {
    getDb().run(
      "INSERT INTO users (phone, credits, opted_out, first_reply_sent, created_at) VALUES (?, 3, 0, 0, datetime('now'))",
      [PHONE],
    );
    await handleInboundSms(makeMsg({ text: 'BAL' }));
    const user = dbGet('SELECT * FROM users WHERE phone = ?', [PHONE]);
    expect(user.credits).toBe(3);
  });
});

// ── Zero credits ──────────────────────────────────────────────────────────────

describe('handleInboundSms — zero credits', () => {
  it('sends top-up message without calling LLM', async () => {
    getDb().run(
      "INSERT INTO users (phone, credits, opted_out, first_reply_sent, created_at) VALUES (?, 0, 0, 0, datetime('now'))",
      [PHONE],
    );
    await handleInboundSms(makeMsg());
    expect(generateReply).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledOnce();
    const [, text] = sendSms.mock.calls[0];
    expect(text).toMatch(/credit/i);
  });
});

// ── LLM failure ───────────────────────────────────────────────────────────────

describe('handleInboundSms — LLM failure', () => {
  it('sends apology and does not charge credit on LLM error', async () => {
    generateReply.mockRejectedValueOnce(new Error('Gemini timeout'));
    await handleInboundSms(makeMsg());
    expect(sendSms).toHaveBeenCalledOnce();
    const [, text] = sendSms.mock.calls[0];
    expect(text).toMatch(/sorry|try again/i);
    const user = dbGet('SELECT * FROM users WHERE phone = ?', [PHONE]);
    expect(user.credits).toBe(3);
  });
});

// ── SMS send failure ──────────────────────────────────────────────────────────

describe('handleInboundSms — SMS send failure', () => {
  it('does not charge credit when SMS fails to send', async () => {
    sendSms.mockRejectedValue(new Error('TextBee unavailable'));
    await handleInboundSms(makeMsg());
    const user = dbGet('SELECT * FROM users WHERE phone = ?', [PHONE]);
    expect(user.credits).toBe(3);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('handleInboundSms — edge cases', () => {
  it('replies with hint for empty message', async () => {
    await handleInboundSms(makeMsg({ text: '   ' }));
    expect(generateReply).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledOnce();
  });

  it('truncates very long text to 500 chars', async () => {
    await handleInboundSms(makeMsg({ text: 'A'.repeat(1000) }));
    expect(generateReply).toHaveBeenCalledOnce();
    expect(generateReply.mock.calls[0][0].question.length).toBeLessThanOrEqual(500);
  });

  it('sends maintenance message without calling LLM', async () => {
    const original = config.maintenanceMode;
    config.maintenanceMode = true;
    await handleInboundSms(makeMsg({ messageId: 'maint-001' }));
    expect(generateReply).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledOnce();
    const [, text] = sendSms.mock.calls[0];
    expect(text).toMatch(/maintenance|paused/i);
    config.maintenanceMode = original;
  });
});
