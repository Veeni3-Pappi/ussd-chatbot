/**
 * llm/llm.js
 * Gemini integration for generating SMS replies.
 *
 * PRIVACY WARNING: The free Gemini API tier (no billing set up) may use content
 * sent through it to improve Google's products. Switch to a paid API key before
 * real users send private messages. See README for details.
 *
 * Settings:
 *   - temperature ~0.4 for focused, consistent answers
 *   - maxOutputTokens ~120 (replies are short; tokens beyond this are wasted)
 *   - thinking disabled/minimal (thinking tokens are billed as output and add latency)
 *   - 10s timeout via AbortController
 *   - one retry on 429 or 5xx with short backoff
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

// ─── Client (singleton) ───────────────────────────────────────────────────────

let _client;

function getClient() {
  if (!_client) {
    _client = new GoogleGenAI({ apiKey: config.gemini.apiKey });
  }
  return _client;
}

// ─── Generation config ────────────────────────────────────────────────────────

/**
 * Build the generation config for the current model.
 * Thinking mode is disabled via thinkingConfig where supported.
 * @returns {object}
 */
function buildGenerationConfig() {
  return {
    temperature: 0.4,
    maxOutputTokens: 120,
  };
}

// ─── History formatter ────────────────────────────────────────────────────────

/**
 * Convert DB history rows to Gemini chat history format.
 * @param {Array<{direction: string, body: string}>} rows
 * @returns {Array<{role: string, parts: Array<{text: string}>}>}
 */
function buildHistory(rows) {
  return rows
    .filter((r) => r.body) // skip purged messages
    .map((r) => ({
      role: r.direction === 'in' ? 'user' : 'model',
      parts: [{ text: r.body }],
    }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate a short SMS reply using Gemini.
 *
 * @param {{ phone: string, question: string, history?: Array<{direction: string, body: string}> }} params
 * @returns {Promise<{ text: string, inputTokens: number, outputTokens: number }>}
 * @throws Will throw after exhausting retries; caller must handle with apology reply.
 */
export async function generateReply({ phone: _phone, question, history = [] }) {
  const model = config.gemini.model;
  const client = getClient();

  const chatHistory = buildHistory(history);

  // Truncate question at 500 chars (extra safety; route already caps input)
  const userText = question.slice(0, 500);

  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      // Short backoff before retry
      await new Promise((r) => setTimeout(r, 1500));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const chat = client.chats.create({
        model,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          ...buildGenerationConfig(),
        },
        history: chatHistory,
      });

      const response = await chat.sendMessage({
        message: userText,
        // Pass AbortSignal for the 10s timeout
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const text = response.text ?? '';
      const usage = response.usageMetadata ?? {};

      const inputTokens = usage.promptTokenCount ?? 0;
      const outputTokens = usage.candidatesTokenCount ?? 0;

      logger.info(
        { model, inputTokens, outputTokens, chars: text.length },
        'Gemini reply generated',
      );

      return { text, inputTokens, outputTokens };
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;

      const isAbort = err.name === 'AbortError';
      const status = err?.status ?? err?.code ?? 0;
      const isRetryable = isAbort || status === 429 || (status >= 500 && status < 600);

      if (!isRetryable) {
        logger.error({ err, model }, 'Gemini non-retryable error');
        throw err;
      }

      logger.warn({ attempt, status, isAbort, model }, 'Gemini retryable error, will retry');
    }
  }

  logger.error({ err: lastError, model }, 'Gemini failed after retries');
  throw lastError;
}
