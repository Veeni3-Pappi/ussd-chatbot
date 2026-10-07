/**
 * scripts/addCredits.js
 * CLI tool to manually add credits to a phone number.
 *
 * Usage:
 *   node scripts/addCredits.js <phone> <amount> [reason] [ref]
 *
 * Examples:
 *   node scripts/addCredits.js +254712345678 10
 *   node scripts/addCredits.js 0712345678 20 admin "manual top-up"
 *   node scripts/addCredits.js +254712345678 5 refund "MSG-001"
 */

import 'dotenv/config';
import { normalizePhone } from '../src/services/phone.js';
import { addCredits, getUser } from '../src/db.js';

const VALID_REASONS = ['topup', 'admin', 'refund'];

const [,, rawPhone, rawAmount, reason = 'admin', ref = null] = process.argv;

if (!rawPhone || !rawAmount) {
  console.error('Usage: node scripts/addCredits.js <phone> <amount> [reason] [ref]');
  console.error('  reason: topup | admin | refund  (default: admin)');
  process.exit(1);
}

if (!VALID_REASONS.includes(reason)) {
  console.error(`Invalid reason "${reason}". Must be one of: ${VALID_REASONS.join(', ')}`);
  process.exit(1);
}

const amount = parseInt(rawAmount, 10);
if (isNaN(amount) || amount <= 0) {
  console.error(`Invalid amount "${rawAmount}". Must be a positive integer.`);
  process.exit(1);
}

let phone;
try {
  phone = normalizePhone(rawPhone);
} catch (err) {
  console.error(`Invalid phone number: ${err.message}`);
  process.exit(1);
}

// Get current balance before
const before = getUser(phone);

addCredits(phone, amount, reason, ref);

const after = getUser(phone);

console.log(`✓ Added ${amount} credit(s) to ${phone}`);
console.log(`  Reason : ${reason}${ref ? ` (${ref})` : ''}`);
console.log(`  Before : ${before?.credits ?? 0} credits`);
console.log(`  After  : ${after.credits} credits`);
