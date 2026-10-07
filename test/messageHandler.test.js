/**
 * test/messageHandler.test.js
 * Integration tests for the full inbound SMS pipeline.
 * Mocks: smsProvider (sendSms), llm (generateReply)
 * Uses in-memory SQLite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Environment setup ─────────────────────────────────────────────────────────
process.env.DB_PATH = ':memory:';
process.env.GEMINI_API_KEY = 'test-key';
process.env.WEBHOOK_SECRET = 'test-secret-that-is-long-enough';
process.env.SMS_PROVIDER = 'textbee';
process.env.TEXTBEE_API_KEY = 'test-tb-key';
process.env.FREE_TRIAL_CREDITS = '3';
process.env.RATE_LIMIT_PER_MIN = '10';
process.env.RATE_LIMIT_PER_DAY = '50';
process.env.MAINTENANCE_MODE = 'false';

// ── Mock SMS provider ─────────────────────────────────────────────────────────
vi.mock('../src/providers/smsProvider.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendSms: vi.fn().mockResolvedValue({ messageId: 'mock-msg-id', cost: null }),
  };
});

// ── Mock LLM ─────────────────────────────────────────────────────────────────
vi.mock('../src/llm/llm.js', () => ({
  generateReply: vi.fn().mockResolvedValue({
    text: 'Malaria is caused by a Plasmodium parasite spread by mosquitoes. Use nets.',
    inputTokens: 50,
    outputTokens: 80,
  }),
}));

const { handleInboundSms } = await import('../src/services/messageHandler.js');
const { sendSms } = await import('../src/providers/smsProvider.js');
const { generateReply } = await import('../src/llm/llm.js');
const { getDb } = await import('../src/db.js');
const { clearRateLimit } = await import('../src/services/rateLimit.js');

const PHONE = '+254711000001';

function makeMsg(overrides = {}) {
  return {
    from: PHONE,
    text: 'What causes malaria?',
    messageId: `msg-${Date.now()}-${Math.random()}`,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRateLimit(PHONE);
  const db = getDb();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM processed_ids').run();
  db.prepare('DELETE FROM credit_ledger').run();
  db.prepare('DELETE FROM rate_events').run();
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('handleInboundSms — happy path', () => {
  it('processes a question and sends a reply', async () => {
    await handleInboundSms(makeMsg());

    expect(generateReply).toHaveBeenCalledOnce();
    expect(sendSms).toHaveBeenCalledOnce();

    const [to, text] = sendSms.mock.calls[0];
    expect(to).toBe(PHONE);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('deducts 1 credit after successful send', async () => {
    await handleInboundSms(makeMsg());

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(PHONE);
    expect(user.credits).toBe(2); // started at 3, charged 1
  });

  it('logs inbound and outbound messages in DB', async () => {
    await handleInboundSms(makeMsg());

    const db = getDb();
    const msgs = db.prepare('SELECT * FROM messages WHERE phone = ?').all(PHONE);
    const inbound = msgs.filter(m => m.direction === 'in');
    const outbound = msgs.filter(m => m.direction === 'out');
    expect(inbound.length).toBe(1);
    expect(outbound.length).toBe(1);
  });

  it('marks first reply sent flag', async () => {
    await handleInboundSms(makeMsg());
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(PHONE);
    expect(user.first_reply_sent).toBe(1);
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────────

describe('handleInboundSms — deduplication', () => {
  it('ignores a duplicate messageId', async () => {
    const msg = makeMsg({ messageId: 'fixed-id-001' });
    await handleInboundSms(msg);
    await handleInboundSms(msg); // same messageId

    expect(sendSms).toHaveBeenCalledOnce(); // only once
    expect(generateReply).toHaveBeenCalledOnce();
  });

  it('does not double-charge credits on duplicate', async () => {
    const msg = makeMsg({ messageId: 'fixed-id-002' });
    await handleInboundSms(msg);
    await handleInboundSms(msg);

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(PHONE);
    expect(user.credits).toBe(2); // still only 1 charge
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

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(PHONE);
    expect(user.opted_out).toBe(1);
    expect(sendSms).toHaveBeenCalledOnce();
  });

  it('START re-opts in after STOP', async () => {
    await handleInboundSms(makeMsg({ text: 'STOP', messageId: 'stop-001' }));
    await handleInboundSms(makeMsg({ text: 'START', messageId: 'start-001' }));

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(PHONE);
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
    // Pre-create user with known credits
    const db = getDb();
    db.prepare("INSERT INTO users (phone, credits, opted_out, first_reply_sent, created_at) VALUES (?, 3, 0, 0, datetime('now'))").run(PHONE);

    await handleInboundSms(makeMsg({ text: 'BAL' }));

    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(PHONE);
    expect(user.credits).toBe(3); // unchanged
  });
});

// ── Zero credits ──────────────────────────────────────────────────────────────

describe('handleInboundSms — zero credits', () => {
  it('sends top-up message without calling LLM', async () => {
    const db = getDb();
    db.prepare("INSERT INTO users (phone, credits, opted_out, first_reply_sent, created_at) VALUES (?, 0, 0, 0, datetime('now'))").run(PHONE);

    await handleInboundSms(makeMsg());

    expect(generateReply).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledOnce();

    const [, text] = sendSms.mock.calls[0];
    expect(text).toMatch(/credit/i);
  });
});

// ── LLM failure ───────────────────────────────────────────────────────────────

describe('handleInboundSms — LLM failure', () => {
  it('sends apology message and does not charge credit on LLM error', async () => {
    generateReply.mockRejectedValueOnce(new Error('Gemini timeout'));

    await handleInboundSms(makeMsg());

    expect(sendSms).toHaveBeenCalledOnce();
    const [, text] = sendSms.mock.calls[0];
    expect(text).toMatch(/sorry|try again/i);

    // Credits should NOT be deducted
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(PHONE);
    expect(user.credits).toBe(3); // unchanged
  });
});

// ── SMS send failure ──────────────────────────────────────────────────────────

describe('handleInboundSms — SMS send failure', () => {
  it('does not charge credit when SMS fails to send', async () => {
    sendSms.mockRejectedValue(new Error('TextBee unavailable'));

    await handleInboundSms(makeMsg());

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(PHONE);
    expect(user.credits).toBe(3); // no charge
  });
});

// ── Empty text ────────────────────────────────────────────────────────────────

describe('handleInboundSms — empty text', () => {
  it('replies with usage hint for empty message', async () => {
    await handleInboundSms(makeMsg({ text: '   ' }));

    expect(generateReply).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledOnce();
  });
});

// ── Very long text ────────────────────────────────────────────────────────────

describe('handleInboundSms — very long text', () => {
  it('truncates to 500 chars and processes normally', async () => {
    const longText = 'A'.repeat(1000);
    await handleInboundSms(makeMsg({ text: longText }));

    expect(generateReply).toHaveBeenCalledOnce();
    const callArg = generateReply.mock.calls[0][0];
    expect(callArg.question.length).toBeLessThanOrEqual(500);
  });
});

// ── Maintenance mode ──────────────────────────────────────────────────────────

describe('handleInboundSms — maintenance mode', () => {
  it('sends maintenance message without calling LLM', async () => {
    // Temporarily enable maintenance mode
    const { config } = await import('../src/config.js');
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
