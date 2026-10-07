/**
 * services/phone.js
 * Normalize Kenyan phone numbers to E.164 (+254XXXXXXXXX).
 *
 * Handles:
 *   07XXXXXXXX   → +2547XXXXXXXX
 *   01XXXXXXXX   → +2541XXXXXXXX
 *   2547XXXXXXXX → +2547XXXXXXXX
 *   +2547XXXXXXXX → +2547XXXXXXXX  (already correct)
 *   7XXXXXXXX    → +2547XXXXXXXX  (9-digit without leading zero)
 */

/**
 * Normalize a Kenyan phone number to +254XXXXXXXXX (E.164).
 * Throws if the number cannot be normalized.
 * @param {string} raw
 * @returns {string}
 */
export function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Phone number is required');

  // Strip all whitespace, dashes, parentheses
  let n = raw.replace(/[\s\-().]/g, '');

  // Already full E.164
  if (/^\+254\d{9}$/.test(n)) return n;

  // +254 with wrong digit count — let it fall through to the error
  if (n.startsWith('+254')) {
    const digits = n.slice(4);
    if (digits.length === 9) return `+254${digits}`;
    throw new Error(`Invalid Kenyan number: ${raw}`);
  }

  // 254XXXXXXXXX (no plus)
  if (/^254\d{9}$/.test(n)) return `+${n}`;

  // 07XXXXXXXX or 01XXXXXXXX (10 digits starting with 0)
  if (/^0[17]\d{8}$/.test(n)) return `+254${n.slice(1)}`;

  // 7XXXXXXXX or 1XXXXXXXX (9 digits, no leading 0)
  if (/^[17]\d{8}$/.test(n)) return `+254${n}`;

  throw new Error(`Cannot normalize phone number: ${raw}`);
}

/**
 * Return true if the string looks like a valid normalized Kenyan E.164 number.
 * @param {string} phone
 * @returns {boolean}
 */
export function isValidPhone(phone) {
  return /^\+254\d{9}$/.test(phone);
}
