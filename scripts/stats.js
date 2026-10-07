/**
 * scripts/stats.js
 * Print usage and cost statistics for SMS-AI.
 *
 * Usage:
 *   node scripts/stats.js
 */

import 'dotenv/config';
import { getDb, getStats } from '../src/db.js';
import { config } from '../src/config.js';

const db = getDb();

// ── Gather stats ──────────────────────────────────────────────────────────────

const base = getStats();

// Total Gemini token usage from all time
const tokenRow = db.prepare(`
  SELECT
    SUM(CAST(json_extract(body, '$.inputTokens') AS INTEGER)) as totalIn,
    SUM(CAST(json_extract(body, '$.outputTokens') AS INTEGER)) as totalOut
  FROM messages
  WHERE direction = 'out' AND body IS NOT NULL
`).get();

// We store token info in the message body? No — let's read from credit_ledger count
// and estimate from message count instead. Token data is logged but not stored in DB.
// For a real stat, you'd add a token_usage table. This gives a cost estimate.
const answeredQuestions = db.prepare(`
  SELECT COUNT(*) as c FROM credit_ledger WHERE reason = 'question' AND delta = -1
`).get().c;

// Average segments per outbound message
const segRow = db.prepare(`
  SELECT AVG(segments) as avg, SUM(segments) as total
  FROM messages WHERE direction = 'out' AND segments IS NOT NULL
`).get();

// Users with zero credits
const broke = db.prepare(`SELECT COUNT(*) as c FROM users WHERE credits = 0`).get().c;

// Top-ups
const topups = db.prepare(`
  SELECT COUNT(*) as count, SUM(delta) as total
  FROM credit_ledger WHERE reason = 'topup'
`).get();

// Last 7 days activity
const daily = db.prepare(`
  SELECT DATE(created_at) as day, COUNT(*) as messages
  FROM messages WHERE direction = 'in'
  GROUP BY day ORDER BY day DESC LIMIT 7
`).all();

// Estimated Gemini cost (rough: assume avg 50 input + 80 output tokens per question)
const estInputTokens  = answeredQuestions * 50;
const estOutputTokens = answeredQuestions * 80;
const estGeminiCost   =
  (estInputTokens  / 1_000_000) * config.gemini.priceInPerM +
  (estOutputTokens / 1_000_000) * config.gemini.priceOutPerM;

// ── Print ─────────────────────────────────────────────────────────────────────

const line = '─'.repeat(44);

console.log('\n📊 SMS-AI Statistics');
console.log(line);
console.log(`Total users              : ${base.totalUsers}`);
console.log(`Users with zero credits  : ${broke}`);
console.log(line);
console.log(`Inbound messages (all)   : ${base.totalMessages}`);
console.log(`Outbound messages (all)  : ${base.totalOutbound}`);
console.log(`Questions answered       : ${answeredQuestions}`);
console.log(`Avg segments / reply     : ${segRow.avg ? segRow.avg.toFixed(2) : 'N/A'}`);
console.log(`Total SMS segments sent  : ${segRow.total ?? 0}`);
console.log(line);
console.log(`Top-up transactions      : ${topups.count ?? 0}`);
console.log(`Total credits topped up  : ${topups.total ?? 0}`);
console.log(line);
console.log(`Est. Gemini input tokens : ~${estInputTokens.toLocaleString()}`);
console.log(`Est. Gemini output tokens: ~${estOutputTokens.toLocaleString()}`);
console.log(`Est. Gemini cost (USD)   : ~$${estGeminiCost.toFixed(4)}`);
console.log(`  (based on $${config.gemini.priceInPerM}/M in, $${config.gemini.priceOutPerM}/M out)`);
console.log(line);

if (daily.length > 0) {
  console.log('\nMessages per day (last 7 days):');
  for (const row of daily) {
    const bar = '█'.repeat(Math.min(Math.round(row.messages / 2), 30));
    console.log(`  ${row.day}  ${String(row.messages).padStart(4)}  ${bar}`);
  }
}

console.log('');
