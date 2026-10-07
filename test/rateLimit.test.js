/**
 * test/rateLimit.test.js
 * Unit tests for services/rateLimit.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { checkRateLimit, clearRateLimit, rateLimitReply } from '../src/services/rateLimit.js';

const PHONE = '+254700000002';

beforeEach(() => {
  clearRateLimit(PHONE);
  vi.restoreAllMocks();
});

describe('checkRateLimit', () => {
  it('allows messages within limits', () => {
    const r = checkRateLimit(PHONE);
    expect(r.allowed).toBe(true);
  });

  it('blocks after per-minute limit exceeded', () => {
    // Send 3 (the limit)
    checkRateLimit(PHONE);
    checkRateLimit(PHONE);
    checkRateLimit(PHONE);
    // 4th should be blocked
    const r = checkRateLimit(PHONE);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('minute');
  });

  it('blocks after per-day limit exceeded', () => {
    // Mock Date.now to simulate messages spread across different minutes
    let fakeTime = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => fakeTime);

    clearRateLimit(PHONE);

    // Send 5 messages, each 2 minutes apart (past per-minute window)
    for (let i = 0; i < 5; i++) {
      fakeTime += 2 * 60 * 1000; // +2 min each time
      clearRateLimit(PHONE);     // reset per-minute in-memory data for this phone
      // Manually build up the day window by calling with accumulated state
    }

    // Directly test by filling the window map — since the in-memory store uses
    // the Map inside rateLimit.js, we simulate by calling checkRateLimit 5 times
    // with faked times > 1 minute apart each time
    // Reset and do it cleanly:
    clearRateLimit(PHONE);
    fakeTime = Date.now();

    const results = [];
    for (let i = 0; i < 6; i++) {
      // Each call is 2 minutes after the previous (past per-min window)
      fakeTime += 2 * 60 * 1000;
      results.push(checkRateLimit(PHONE));
    }

    // First 5 should be allowed (day limit), 6th should be blocked
    expect(results[0].allowed).toBe(true);
    expect(results[4].allowed).toBe(true);
    expect(results[5].allowed).toBe(false);
    expect(results[5].reason).toBe('day');
  });

  it('returns reason=minute when minute limit hit', () => {
    checkRateLimit(PHONE);
    checkRateLimit(PHONE);
    checkRateLimit(PHONE);
    const r = checkRateLimit(PHONE);
    expect(r.reason).toBe('minute');
  });
});

describe('rateLimitReply', () => {
  it('returns minute reply for minute reason', () => {
    const r = rateLimitReply('minute');
    expect(r.length).toBeGreaterThan(0);
    expect(typeof r).toBe('string');
  });

  it('returns day reply for day reason', () => {
    const r = rateLimitReply('day');
    expect(r.length).toBeGreaterThan(0);
    expect(r).not.toBe(rateLimitReply('minute'));
  });
});

describe('clearRateLimit', () => {
  it('resets the counter for a phone', () => {
    checkRateLimit(PHONE);
    checkRateLimit(PHONE);
    checkRateLimit(PHONE);
    clearRateLimit(PHONE);
    const r = checkRateLimit(PHONE);
    expect(r.allowed).toBe(true);
  });
});
