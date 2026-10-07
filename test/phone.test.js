/**
 * test/phone.test.js
 * Unit tests for services/phone.js
 */

import { describe, it, expect } from 'vitest';
import { normalizePhone, isValidPhone } from '../src/services/phone.js';

describe('normalizePhone', () => {
  it('accepts already-correct E.164', () => {
    expect(normalizePhone('+254712345678')).toBe('+254712345678');
  });

  it('handles 07XX format', () => {
    expect(normalizePhone('0712345678')).toBe('+254712345678');
  });

  it('handles 01XX format', () => {
    expect(normalizePhone('0112345678')).toBe('+254112345678');
  });

  it('handles 254XXXXXXXXX (no plus)', () => {
    expect(normalizePhone('254712345678')).toBe('+254712345678');
  });

  it('handles 7XXXXXXXXX (9 digits, no leading zero)', () => {
    expect(normalizePhone('712345678')).toBe('+254712345678');
  });

  it('handles 1XXXXXXXXX (9 digits Airtel)', () => {
    expect(normalizePhone('112345678')).toBe('+254112345678');
  });

  it('strips spaces', () => {
    expect(normalizePhone('+254 712 345 678')).toBe('+254712345678');
  });

  it('strips dashes', () => {
    expect(normalizePhone('+254-712-345-678')).toBe('+254712345678');
  });

  it('throws on completely invalid input', () => {
    expect(() => normalizePhone('abc')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => normalizePhone('')).toThrow();
  });

  it('throws on null', () => {
    expect(() => normalizePhone(null)).toThrow();
  });

  it('throws on wrong digit count', () => {
    expect(() => normalizePhone('+25471234')).toThrow(); // too short
  });
});

describe('isValidPhone', () => {
  it('returns true for valid E.164', () => {
    expect(isValidPhone('+254712345678')).toBe(true);
  });

  it('returns false for unnormalized number', () => {
    expect(isValidPhone('0712345678')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidPhone('')).toBe(false);
  });
});
