/**
 * services/replyFormatter.js
 *
 * Formats outbound SMS replies to:
 *   1. Strip markdown, emojis, zero-width chars
 *   2. Replace curly quotes and long dashes with plain ASCII
 *   3. Transliterate or drop non-GSM-7 characters
 *   4. Enforce a hard cap of MAX_SEGMENTS (default 2)
 *   5. Cut at last sentence boundary within the cap; add '...' only if forced
 *
 * GSM-7 basics:
 *   Single message:  160 chars
 *   Concatenated:    153 chars/segment
 *   Extended chars (€ [ ] { } ~ ^ | \) count as 2 each
 *
 * If ANY char outside GSM-7 remains after sanitizing, the whole message
 * switches to UCS-2 (70 / 67 chars). We aggressively prevent that.
 */

import { config } from '../config.js';

// ─── GSM-7 character sets ─────────────────────────────────────────────────────

// Basic GSM-7 charset (code points that cost 1 unit)
const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);

// Extended GSM-7 charset (count as 2 units each)
const GSM7_EXTENDED = new Set('€[]{}~^|\\');

/**
 * Return true if every character in text is GSM-7 (basic or extended).
 * @param {string} text
 * @returns {boolean}
 */
export function isGsm7(text) {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

/**
 * Count the number of SMS segments required for the given text.
 * Accounts for GSM-7 extended chars (2 units each) and UCS-2 fallback.
 * @param {string} text
 * @returns {{ segments: number, encoding: 'GSM-7'|'UCS-2', units: number }}
 */
export function countSegments(text) {
  if (!text) return { segments: 0, encoding: 'GSM-7', units: 0 };

  let units = 0;
  let isUcs2 = false;

  for (const ch of text) {
    if (GSM7_EXTENDED.has(ch)) {
      units += 2;
    } else if (GSM7_BASIC.has(ch)) {
      units += 1;
    } else {
      isUcs2 = true;
      break;
    }
  }

  if (isUcs2) {
    // Recount in UCS-2 (each char = 1 unit, but limits are different)
    const len = [...text].length; // handle surrogate pairs
    const single = 70;
    const perSeg = 67;
    if (len <= single) return { segments: 1, encoding: 'UCS-2', units: len };
    return { segments: Math.ceil(len / perSeg), encoding: 'UCS-2', units: len };
  }

  const single = 160;
  const perSeg = 153;
  if (units <= single) return { segments: 1, encoding: 'GSM-7', units };
  return { segments: Math.ceil(units / perSeg), encoding: 'GSM-7', units };
}

// ─── Sanitizer ────────────────────────────────────────────────────────────────

// Characters we transliterate to ASCII equivalents
const TRANSLITERATE = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", // curly single quotes
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', // curly double quotes
  '\u2013': '-', '\u2014': '-', '\u2015': '-',                // en/em dash
  '\u2026': '...', // ellipsis
  '\u00A0': ' ',   // non-breaking space
  '\u00B7': '.',   // middle dot
  '\u2022': '-',   // bullet
  '\u25CF': '-',   // filled circle
  '\u2019': "'",   // right single quote (duplicate for safety)
};

/**
 * Sanitize text for GSM-7 SMS delivery.
 * Strips markdown, emojis, zero-width chars; transliterates common Unicode.
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeForGsm7(raw) {
  if (!raw) return '';

  let text = raw;

  // 1. Strip markdown formatting: **, *, __, _, ##, #, `, ```
  text = text.replace(/```[\s\S]*?```/g, ''); // code blocks
  text = text.replace(/`[^`]*`/g, '');        // inline code
  text = text.replace(/#{1,6}\s*/g, '');       // headers
  text = text.replace(/\*{1,3}([^*]*)\*{1,3}/g, '$1'); // bold/italic
  text = text.replace(/_{1,2}([^_]*)_{1,2}/g, '$1');   // underscore emphasis
  text = text.replace(/^\s*[-*+]\s+/gm, '- ');          // bullet points → dash

  // 2. Zero-width and control characters
  text = text.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, ''); // zero-width
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''); // control chars

  // 3. Transliterate known Unicode → ASCII
  for (const [from, to] of Object.entries(TRANSLITERATE)) {
    text = text.replaceAll(from, to);
  }

  // 4. Strip emoji (Unicode ranges for emoticons, symbols, etc.)
  text = text.replace(
    /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1FFFF}]/gu,
    '',
  );

  // 5. Drop any remaining non-GSM-7 characters
  let result = '';
  for (const ch of text) {
    if (GSM7_BASIC.has(ch) || GSM7_EXTENDED.has(ch)) {
      result += ch;
    }
    // else: drop it silently
  }

  // 6. Collapse multiple spaces and trim
  result = result.replace(/ {2,}/g, ' ').trim();

  return result;
}

// ─── Formatter ────────────────────────────────────────────────────────────────

/**
 * Calculate max character units allowed for N segments in GSM-7.
 * @param {number} maxSegments
 * @returns {number}
 */
function maxUnits(maxSegments) {
  if (maxSegments === 1) return 160;
  return maxSegments * 153;
}

/**
 * Truncate text to fit within unitCap GSM-7 units.
 * Cuts at the last sentence boundary (. ! ?) within the cap.
 * Falls back to last word boundary, then hard cut.
 * Appends '...' only when forced to truncate mid-sentence.
 * @param {string} text
 * @param {number} unitCap
 * @returns {string}
 */
function truncateToUnits(text, unitCap) {
  // Fast path: already fits
  const { units } = countSegments(text);
  if (units <= unitCap) return text;

  // Walk character by character, count units
  let acc = 0;
  let chars = [...text];
  let cutIndex = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cost = GSM7_EXTENDED.has(ch) ? 2 : 1;
    if (acc + cost > unitCap - 3) { // reserve 3 units for '...'
      cutIndex = i;
      break;
    }
    acc += cost;
    cutIndex = i + 1;
  }

  const candidate = chars.slice(0, cutIndex).join('');

  // Try to cut at last sentence boundary
  const sentenceEnd = candidate.search(/[.!?][^.!?]*$/);
  if (sentenceEnd > candidate.length * 0.5) {
    // Found a sentence boundary in the second half of the string — clean cut
    const atBoundary = candidate.slice(0, sentenceEnd + 1).trim();
    return atBoundary;
  }

  // Fall back to last word boundary
  const lastSpace = candidate.lastIndexOf(' ');
  if (lastSpace > candidate.length * 0.5) {
    return candidate.slice(0, lastSpace).trim() + '...';
  }

  // Hard cut
  return candidate.trim() + '...';
}

/**
 * Format a reply for SMS delivery.
 * @param {string} rawText - text from Gemini or keyword handler
 * @param {{ isFirstReply?: boolean, maxSegments?: number }} [opts]
 * @returns {string}
 */
export function formatReply(rawText, opts = {}) {
  const maxSegs = opts.maxSegments ?? config.maxSegments ?? 2;
  const cap = maxUnits(maxSegs);

  // 1. Sanitize
  let text = sanitizeForGsm7(rawText);

  // 2. Enforce segment cap
  text = truncateToUnits(text, cap);

  // 3. Append BAL hint on very first reply (only if it fits)
  if (opts.isFirstReply) {
    const hint = ' Reply BAL for credits.';
    const withHint = text + hint;
    if (countSegments(withHint).segments <= maxSegs) {
      text = withHint;
    }
  }

  return text;
}
