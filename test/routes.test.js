/**
 * test/routes.test.js
 * Integration test for Express routes and stream body parsing middleware.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { createHmac } from 'crypto';

// Mock dependencies
vi.mock('../src/providers/smsProvider.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendSms: vi.fn().mockResolvedValue({ messageId: 'test-outbound-id', cost: null }),
  };
});

vi.mock('../src/llm/llm.js', () => ({
  generateReply: vi.fn().mockResolvedValue({
    text: 'This is a test response from Gemini.',
    inputTokens: 10,
    outputTokens: 20,
  }),
}));

import app from '../src/server.js';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { sendSms } from '../src/providers/smsProvider.js';

let server;
let baseUrl;

beforeAll(async () => {
  await openDb();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) server.close();
});

describe('Webhook Routes Integration', () => {
  it('receives TextBee webhook POST with JSON body and triggers handleInboundSms', async () => {
    vi.clearAllMocks();
    const payload = JSON.stringify({
      webhookEvent: 'MESSAGE_RECEIVED',
      data: {
        smsId: 'tb-msg-101',
        sender: '+254712345678',
        message: 'What is malaria?',
      },
    });

    const secret = config.textbee.webhookSecret;
    const sig = secret ? createHmac('sha256', secret).update(Buffer.from(payload)).digest('hex') : '';

    const res = await fetch(`${baseUrl}/webhooks/sms/textbee/${config.webhookSecret}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': sig,
      },
      body: payload,
    });

    expect(res.status).toBe(200);

    // Wait a brief tick for async processing
    await new Promise((r) => setTimeout(r, 200));

    expect(sendSms).toHaveBeenCalled();
  });

  it('receives Africa Talking webhook POST with form-encoded body and triggers handleInboundSms', async () => {
    vi.clearAllMocks();
    const body = new URLSearchParams({
      from: '+254787654321',
      text: 'BAL',
      id: 'at-msg-202',
    }).toString();

    const res = await fetch(`${baseUrl}/webhooks/sms/at/${config.webhookSecret}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body,
    });

    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));

    expect(sendSms).toHaveBeenCalled();
  });
});
