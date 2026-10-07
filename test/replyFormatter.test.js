/**
 * test/replyFormatter.test.js
 * Unit tests for services/replyFormatter.js
 * Covers: countSegments, sanitizeForGsm7, formatReply
 */

import { describe, it, expect } from 'vitest';
import { countSegments, sanitizeForGsm7, formatReply, isGsm7 } from '../src/services/replyFormatter.js';

// ── countSegments ─────────────────────────────────────────────────────────────

describe('countSegments', () => {
  it('empty string returns 0 segments', () => {
    const r = countSegments('');
    expect(r.segments).toBe(0);
  });

  it('short GSM-7 text = 1 segment', () => {
    const r = countSegments('Hello, how are you?');
    expect(r.segments).toBe(1);
    expect(r.encoding).toBe('GSM-7');
  });

  it('exactly 160 GSM-7 chars = 1 segment', () => {
    const text = 'A'.repeat(160);
    const r = countSegments(text);
    expect(r.segments).toBe(1);
    expect(r.units).toBe(160);
  });

  it('161 GSM-7 chars = 2 segments (153 per seg)', () => {
    const text = 'A'.repeat(161);
    const r = countSegments(text);
    expect(r.segments).toBe(2);
  });

  it('306 GSM-7 chars = 2 segments', () => {
    const text = 'A'.repeat(306);
    const r = countSegments(text);
    expect(r.segments).toBe(2);
  });

  it('307 GSM-7 chars = 3 segments', () => {
    const text = 'A'.repeat(307);
    const r = countSegments(text);
    expect(r.segments).toBe(3);
  });

  it('GSM-7 extended chars ([ ] { }) count as 2 units each', () => {
    // '[' is extended, costs 2. 80 brackets = 160 units = 1 segment
    const text = '['.repeat(80);
    const r = countSegments(text);
    expect(r.encoding).toBe('GSM-7');
    expect(r.units).toBe(160);
    expect(r.segments).toBe(1);
  });

  it('one emoji triggers UCS-2', () => {
    const text = 'Hello 😀';
    const r = countSegments(text);
    expect(r.encoding).toBe('UCS-2');
  });

  it('UCS-2 single message limit is 70 chars', () => {
    const text = '😀'.repeat(70);
    const r = countSegments(text);
    expect(r.segments).toBe(1);
    expect(r.encoding).toBe('UCS-2');
  });

  it('UCS-2 71 chars = 2 segments', () => {
    const text = '😀'.repeat(71);
    const r = countSegments(text);
    expect(r.segments).toBe(2);
  });
});

// ── isGsm7 ────────────────────────────────────────────────────────────────────

describe('isGsm7', () => {
  it('plain ASCII text is GSM-7', () => {
    expect(isGsm7('Hello world 123!')).toBe(true);
  });

  it('emoji is not GSM-7', () => {
    expect(isGsm7('Hello 😊')).toBe(false);
  });

  it('curly quote is not GSM-7', () => {
    expect(isGsm7('it\u2019s')).toBe(false);
  });

  it('extended chars are still GSM-7', () => {
    expect(isGsm7('price is €10')).toBe(true);
  });
});

// ── sanitizeForGsm7 ───────────────────────────────────────────────────────────

describe('sanitizeForGsm7', () => {
  it('strips markdown bold', () => {
    const r = sanitizeForGsm7('**bold text**');
    expect(r).toBe('bold text');
    expect(isGsm7(r)).toBe(true);
  });

  it('strips markdown headers', () => {
    const r = sanitizeForGsm7('## My Header');
    expect(r).not.toContain('#');
  });

  it('strips emoji', () => {
    const r = sanitizeForGsm7('Hello 😀 world');
    expect(isGsm7(r)).toBe(true);
    expect(r).not.toContain('😀');
  });

  it('replaces curly quotes with straight quotes', () => {
    const r = sanitizeForGsm7('\u201CHello\u201D');
    expect(r).toBe('"Hello"');
    expect(isGsm7(r)).toBe(true);
  });

  it('replaces em dash with hyphen', () => {
    const r = sanitizeForGsm7('good\u2014morning');
    expect(r).toContain('-');
    expect(isGsm7(r)).toBe(true);
  });

  it('removes zero-width chars', () => {
    const r = sanitizeForGsm7('hel\u200Blo');
    expect(r).toBe('hello');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeForGsm7('')).toBe('');
  });

  it('output is always GSM-7 safe', () => {
    const messy = '**Bold** with emoji 🌍 and curly \u2018quotes\u2019 and em\u2014dash';
    const r = sanitizeForGsm7(messy);
    expect(isGsm7(r)).toBe(true);
  });
});

// ── formatReply ───────────────────────────────────────────────────────────────

describe('formatReply', () => {
  it('returns clean GSM-7 text', () => {
    const r = formatReply('Malaria is caused by a parasite called Plasmodium.');
    expect(isGsm7(r)).toBe(true);
  });

  it('strips markdown from Gemini output', () => {
    const r = formatReply('**Malaria** is caused by *Plasmodium*. Use mosquito nets.');
    expect(r).not.toContain('*');
    expect(isGsm7(r)).toBe(true);
  });

  it('respects maxSegments=1 cap', () => {
    const longText = 'A'.repeat(200);
    const r = formatReply(longText, { maxSegments: 1 });
    expect(countSegments(r).segments).toBeLessThanOrEqual(1);
  });

  it('respects maxSegments=2 cap (default)', () => {
    const longText = 'This is a long answer that goes on and on. '.repeat(20);
    const r = formatReply(longText);
    expect(countSegments(r).segments).toBeLessThanOrEqual(2);
  });

  it('appends BAL hint on first reply if it fits', () => {
    const r = formatReply('Short answer.', { isFirstReply: true });
    expect(r).toContain('Reply BAL');
  });

  it('does not append BAL hint when not first reply', () => {
    const r = formatReply('Short answer.', { isFirstReply: false });
    expect(r).not.toContain('Reply BAL');
  });

  it('does not exceed segment cap even with BAL hint', () => {
    const longText = 'A'.repeat(290); // near cap
    const r = formatReply(longText, { isFirstReply: true, maxSegments: 2 });
    expect(countSegments(r).segments).toBeLessThanOrEqual(2);
  });

  it('handles empty input gracefully', () => {
    const r = formatReply('');
    expect(typeof r).toBe('string');
  });
});
