# SMS-AI: Agent Brief

Paste this whole file to your coding agent (Claude Code, Cursor, etc.) as the project brief, or save it in the repo root as `AGENTS.md` / `CLAUDE.md`.

---

## 1. ROLE

You are a senior Node.js backend engineer. Build **SMS-AI**: a service that lets people on basic feature phones in Kenya text a question to a number and receive a short AI-generated answer back by SMS. The user needs no mobile data, only airtime and signal, the same way `*334#` or an M-Pesa balance check works.

Work in small, reviewable commits. If a requirement is ambiguous, or conflicts with the current provider docs, **stop and ask me** instead of guessing.

## 2. PRODUCT CONTEXT

- Target users: feature-phone and low-data users (students, farmers, small traders) in Kenya. Swahili and English matter. Sheng and Kimeru may appear, so fail gracefully.
- The value is access without data. It is not "ChatGPT by SMS" for everyone, so the answers must be short, practical, and cheap to deliver.
- Every outgoing SMS costs real money, so cost control (reply length, credits, rate limits) is a core feature, not an afterthought.
- This is currently a solo-developer project: prefer simple, boring, maintainable choices over clever ones.

## 3. FIXED STACK (do not substitute)

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ (ESM, plain JavaScript with JSDoc types) |
| Web framework | Express |
| SMS + USSD provider | Africa's Talking (npm package `africastalking`) |
| LLM | Google Gemini via the official `@google/genai` SDK |
| Database | SQLite via `better-sqlite3` (keep DB access in one module so it can be swapped for Postgres later) |
| Payments (Phase 3) | Safaricom Daraja M-Pesa STK Push (Lipa na M-Pesa Online) |
| Logging | `pino` |
| Tests | `node:test` or `vitest` |
| Config | `.env` via `dotenv`; never hard-code secrets |

**Before writing code, read the current docs** for the Africa's Talking Node SDK and the Gemini API. SDK usage and model IDs change. Do not guess model names: read `GEMINI_MODEL` from the environment and default to a current Flash-Lite-class model.

## 4. PHASES

- **Phase 1 (build now):** inbound SMS, credit check, Gemini, SMS reply, delivery reports, rate limiting, tests.
- **Phase 2:** USSD menu (balance, ask a question, help, top-up entry point).
- **Phase 3:** M-Pesa STK Push top-ups that add credits automatically.

Build Phase 1 completely and get my confirmation before starting Phase 2. In Phase 1, add the Phase 2 and 3 route files as stubs only (see the project structure).

## 5. ARCHITECTURE

```
Feature phone ──SMS──▶ Africa's Talking ──HTTPS POST──▶ Express webhook
                                                          │
                                  ┌───────────────────────┤
                                  ▼                       ▼
                            SQLite (users,           Gemini API
                            credits, logs)           (short answer)
                                  │                       │
                                  └──────────┬────────────┘
                                             ▼
                             format reply (GSM-7, ≤2 segments)
                                             ▼
                          Africa's Talking send-SMS API ──▶ Phone
```

Keep the provider and the LLM behind adapter modules so either can be swapped without touching business logic.

### Project structure

```
sms-ai/
├─ src/
│  ├─ server.js                  # Express app, middleware, route mounting
│  ├─ config.js                  # reads and validates env vars (fail fast)
│  ├─ db.js                      # SQLite setup + migrations
│  ├─ providers/
│  │  └─ smsProvider.js          # sendSms(to, text), parseInbound(req); wraps africastalking
│  ├─ llm/
│  │  ├─ llm.js                  # generateReply({ phone, question, history })
│  │  └─ systemPrompt.js
│  ├─ routes/
│  │  ├─ sms.js                  # POST /webhooks/sms/:secret
│  │  ├─ delivery.js             # POST /webhooks/delivery/:secret
│  │  ├─ ussd.js                 # POST /webhooks/ussd/:secret   (Phase 1: stub)
│  │  └─ mpesa.js                # POST /webhooks/mpesa/:secret  (Phase 1: stub)
│  ├─ services/
│  │  ├─ messageHandler.js       # the core pipeline (section 6)
│  │  ├─ credits.js
│  │  ├─ rateLimit.js
│  │  ├─ replyFormatter.js
│  │  └─ phone.js                # normalize to +254XXXXXXXXX
│  └─ utils/logger.js
├─ scripts/
│  ├─ addCredits.js              # node scripts/addCredits.js +2547XXXXXXXX 20
│  └─ stats.js                   # users, messages, cost totals
├─ test/
├─ .env.example
├─ README.md
└─ package.json
```

## 6. CORE PIPELINE (Phase 1)

Africa's Talking POSTs **form-encoded** fields for an inbound SMS: `from`, `to`, `text`, `date`, `id`, `linkId` (and sometimes `networkCode`). Use `express.urlencoded({ extended: false })`.

1. **Verify the secret** in the URL path (`/webhooks/sms/:secret`). If wrong, return 404. (Africa's Talking callbacks are not signed, so the secret path is the main protection. Keep it long and random.)
2. **Respond `200` immediately**, then process asynchronously. Do not make Africa's Talking wait on the LLM.
3. **Deduplicate** by message `id` using the `processed_ids` table. Callbacks can be retried.
4. **Normalize** the sender to `+254XXXXXXXXX` (handle `07XX`, `01XX`, `2547XX`, `+2547XX`).
5. **Opted-out numbers** get no reply, unless the message is `START` (re-opt in).
6. **Keywords** (case-insensitive, trimmed), handled before any LLM call:
   - `BAL`: reply with remaining credits.
   - `HELP`: reply with a one-line usage guide.
   - `STOP`: set `opted_out = 1`, send one confirmation, then stay silent.
   - `START`: opt back in.
7. **Validate** the question: non-empty, cap at 500 characters (truncate longer input; do not reject).
8. **Rate limit** per number (configurable, defaults: 5 per minute, 30 per day). On breach, send one short "slow down" message at most once per window, then ignore.
9. **Credit check.** New numbers get `FREE_TRIAL_CREDITS` (default 3). One credit per answered question. At zero credits, reply with a short top-up message and make **no LLM call**.
10. **History.** Load the last 3 exchanges for this number (created in the last 24h) to give the LLM short-term context.
11. **Call Gemini** (section 8) with a 10 s timeout.
12. **Format the reply** (section 7).
13. **Send via `smsProvider.sendSms`.** Store the returned Africa's Talking `messageId` and `cost`.
14. **Deduct 1 credit only after a successful send.** If the send fails, retry once; if it still fails, do not charge, and log the error.
15. **On LLM failure or timeout:** send "Sorry, please try again shortly." (do not charge) and log it.

## 7. SMS REPLY FORMATTING RULES

- SMS segments: **160 chars** for a single GSM-7 message, **153 per segment** when concatenated. If any non-GSM-7 character appears (emoji, curly quotes, many accented letters), the message switches to UCS-2: **70 chars** single, **67 per segment** concatenated. This can triple the cost, so sanitize aggressively.
- GSM-7 extended characters (`€ [ ] { } ~ ^ | \`) count as **2** characters each.
- `replyFormatter.js` must:
  1. Strip markdown (`*`, `#`, backticks, bullets), emojis, and zero-width characters.
  2. Replace curly quotes and long dashes with plain ASCII.
  3. Transliterate or drop any remaining non-GSM-7 character.
  4. Enforce a hard cap of **2 segments** (default ≈ 300 chars; configurable with `MAX_SEGMENTS`).
  5. Cut at the last sentence boundary within the cap, never mid-word. Add `...` only if truncation was forced.
- Do not append promotional text. Exception: on a number's very first reply, append " Reply BAL for credits."
- Export a helper `countSegments(text)` and unit-test it thoroughly.

## 8. GEMINI INTEGRATION

- Use `@google/genai`. Construct the client once and reuse it.
- Pass the system prompt through the SDK's system-instruction config, not by concatenating it into the user message.
- Settings: `temperature` around 0.4, `maxOutputTokens` around 120, and **thinking disabled or minimal** (thinking tokens are billed as output tokens and add latency; the config field differs by model generation, so check the docs for the chosen model).
- Timeout 10 s via `AbortController`, one retry on 429/5xx with a short backoff, then fall back to the apology message.
- Free-tier warning: content sent through the free Gemini API tier may be used by Google to improve its products. Add this as a code comment in `llm.js` and a README section: **switch to a paid key before real users send private messages**.
- Never log full user messages at `info` level in production (see privacy, section 12).

### System prompt (store in `src/llm/systemPrompt.js`)

```
You answer questions by SMS for people with basic phones.

Rules:
- Reply in the same language the user wrote in (English or Kiswahili).
- Maximum 300 characters in total.
- Plain text only: no markdown, no emojis, no bullet symbols, no special characters.
- Lead with the direct answer. Add one short practical tip only if space allows.
- For medical, legal or money questions, give brief general information and advise
  seeing a clinic, lawyer or financial professional. For emergencies, tell them to
  call 999 or 112 or go to the nearest hospital.
- If you do not know, say so in one short sentence. Never invent facts, prices or
  phone numbers.
- Ask at most one follow-up question, and only when truly needed.
- Refuse harmful or illegal requests in one short sentence.
```

## 9. DATABASE (SQLite)

```sql
users(
  phone TEXT PRIMARY KEY,          -- +254XXXXXXXXX
  credits INTEGER NOT NULL DEFAULT 0,
  opted_out INTEGER NOT NULL DEFAULT 0,
  first_reply_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL,         -- 'in' | 'out'
  body TEXT,                       -- purged after 24h (set to NULL)
  at_message_id TEXT,              -- Africa's Talking id for outbound
  segments INTEGER,
  cost TEXT,                       -- as returned by Africa's Talking, e.g. 'KES 0.8000'
  status TEXT,                     -- queued | sent | delivered | failed
  created_at TEXT NOT NULL
);

processed_ids(message_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);

credit_ledger(                      -- append-only audit trail of every credit change
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,            -- 'trial' | 'question' | 'topup' | 'admin' | 'refund'
  ref TEXT,                        -- e.g. M-Pesa receipt number
  created_at TEXT NOT NULL
);

rate_events(phone TEXT NOT NULL, at INTEGER NOT NULL);  -- or keep in memory for v1
```

- Credit changes must be done in a single transaction together with the ledger insert.
- A scheduled job (daily, `node-cron` or a simple `setInterval`) must: set `messages.body = NULL` where older than 24h, and delete `processed_ids` older than 7 days.

## 10. AFRICA'S TALKING SPECIFICS

- **Sandbox:** use `AT_USERNAME=sandbox` plus the sandbox API key. In the sandbox, SMS only goes to the **web simulator** in the dashboard, not to real phones. Real delivery needs a live account with a shortcode or number.
- **Sending:** `africastalking({ apiKey, username }).SMS.send({ to: ['+254...'], message, from })`. The `from` (sender ID or shortcode) is optional and only valid if provisioned for your account. Read `SMSMessageData.Recipients[]` in the response for each recipient's `status`, `cost`, and `messageId`, and store them.
- **Inbound SMS:** set the callback URL in the dashboard to `https://<your-host>/webhooks/sms/<WEBHOOK_SECRET>`. This only works once you have a shortcode or number subscribed to receive messages.
- **Delivery reports:** set a delivery-report callback to `/webhooks/delivery/<WEBHOOK_SECRET>`. The POST includes `id`, `status` (for example Success, Failed, Sent, Buffered, Rejected), `phoneNumber`, `networkCode`, `failureReason`, `retryCount`. Update `messages.status` by `at_message_id`.
- **USSD (Phase 2):** the callback POST has `sessionId`, `serviceCode`, `phoneNumber`, `networkCode`, `text`. `text` is the user's inputs in this session joined by `*` (empty on the first request). Respond with `Content-Type: text/plain`, body starting with `CON ` (continue session) or `END ` (close session). Keep each screen under about 160 characters and respond in a second or two, as USSD sessions time out in tens of seconds.
- Shortcode and USSD code availability, cost, and approval time depend on Africa's Talking and each mobile network. Confirm the current process in their dashboard and docs.

## 11. PHASE 2: USSD MENU (spec for later)

```
*XYZ#
CON Welcome to SMS-AI
1. Ask a question
2. My credits
3. Top up
4. Help
```

- **1 → Ask:** `CON Type your question (short):` → on input, reply `END Your answer will arrive by SMS shortly.` and process it through the **same pipeline** (section 6) in the background. Cap input at about 120 characters because USSD input is awkward.
- **2 → Credits:** `END You have N credits.`
- **3 → Top up:** `CON 1. KES 20  2. KES 50  3. KES 100` → trigger an STK push (Phase 3) → `END Check your phone for the M-Pesa prompt.`
- **4 → Help:** `END Text your question to <number>. 1 credit = 1 answer.`
- Credit packs are placeholders in config (`CREDIT_PACKS`), not hard-coded.
- USSD sessions are stateless between callbacks: derive the state from `text.split('*')`.

## 12. PHASE 3: M-PESA STK PUSH (spec for later)

- Daraja OAuth token (cache until near expiry), then `POST /mpesa/stkpush/v1/processrequest` with the business shortcode, passkey, timestamp, base64 password, `CallBackURL = /webhooks/mpesa/<secret>`.
- Callback handler: on `ResultCode === 0`, read the amount and `MpesaReceiptNumber`, find the pending payment by `CheckoutRequestID`, add credits per the pack, write a `credit_ledger` row with `ref = receipt`, and send a confirmation SMS. **Idempotent**: a repeated callback must never double-credit.
- Add a `payments` table: `checkout_request_id`, `phone`, `amount`, `status`, `receipt`, `created_at`.
- Start in the Daraja sandbox, with the sandbox shortcode and passkey from the Daraja portal.
- Africa's Talking also has its own mobile-payments API. Daraja is the default here, but mention it in the README as an alternative.

## 13. SECURITY, PRIVACY, COMPLIANCE

- All webhook routes require the secret path segment. Reject others with 404.
- Use `helmet`, body-size limits, and a global IP rate limit.
- Never log API keys. Never log full message bodies at `info`; log message ids, phone numbers masked as `+2547****1234`, and lengths.
- Message bodies are purged after 24h (section 9). Mention this in the README.
- Honor `STOP` immediately and permanently until `START`.
- The service handles personal data about Kenyan users. Add a README section listing what is collected and what is retained, and a note for me to check my obligations under the **Kenya Data Protection Act, 2019** (including ODPC registration) and the provider's acceptable-use terms before launch. Do not give legal conclusions; just flag it.
- `MAINTENANCE_MODE=true` makes every inbound message get a single short "service paused" reply, with no LLM calls.

## 14. COST MODEL AND OBSERVABILITY

- The SMS segments cost far more than the LLM call, so track real cost per message from Africa's Talking's `cost` field.
- `scripts/stats.js` must print: total users, questions per day, average segments per reply, total SMS cost, estimated Gemini cost (using a configurable price per million tokens), and cost per answered question.
- Log token usage from each Gemini response.
- Add a `/healthz` endpoint (no secret) that returns `ok` and checks DB access.

## 15. ENVIRONMENT VARIABLES (`.env.example`)

```
PORT=3000
NODE_ENV=development
WEBHOOK_SECRET=change-me-long-random-string
MAINTENANCE_MODE=false

AT_USERNAME=sandbox
AT_API_KEY=
AT_SENDER_ID=

GEMINI_API_KEY=
GEMINI_MODEL=            # verify a current Flash-Lite-class model ID in the docs
GEMINI_PRICE_IN_PER_M=   # USD per 1M input tokens, for the stats script
GEMINI_PRICE_OUT_PER_M=  # USD per 1M output tokens

FREE_TRIAL_CREDITS=3
MAX_SEGMENTS=2
RATE_LIMIT_PER_MIN=5
RATE_LIMIT_PER_DAY=30
CREDIT_PACKS=20:10,50:30,100:70     # KES:credits placeholders

# Phase 3
DARAJA_ENV=sandbox
DARAJA_CONSUMER_KEY=
DARAJA_CONSUMER_SECRET=
DARAJA_SHORTCODE=
DARAJA_PASSKEY=
```

## 16. TESTING

- **Unit tests:** `replyFormatter` (GSM-7 sanitizing, extended-char counting, segment cap, sentence-boundary cut), `phone` normalization, `credits` (no double charge, no charge on failure, ledger consistency), keyword handling, dedupe, rate limiter.
- **Integration tests:** POST a fake Africa's Talking form payload to the webhook with mocked `smsProvider` and `llm`; assert the DB state and the outgoing message.
- **Manual test script in README:** run locally, expose via a tunnel (Cloudflare Tunnel or ngrok), set the callback URL in the sandbox, and send a message from the simulator.
- Test cases to include: empty text, very long text, emoji input, Swahili input, repeated callback (same id), zero credits, STOP then START, LLM timeout, SMS send failure, rate-limit breach.

## 17. DEPLOYMENT NOTES (README section)

- Needs a public HTTPS URL. A small VPS (Nginx + PM2 or Docker), or Render, Railway, or Fly.io, is fine. Document one path end to end.
- SQLite needs a persistent volume. Back it up daily (a simple copy to object storage or `sqlite3 .backup`).
- Run a single instance for v1 so the in-memory rate limiter and SQLite stay consistent.
- Graceful shutdown: finish in-flight messages on SIGTERM.

## 18. ACCEPTANCE CRITERIA (Phase 1 is done when)

1. From the Africa's Talking sandbox simulator, a question sent to the webhook produces a formatted answer SMS in the simulator.
2. A new number gets 3 free credits, each answered question costs 1, and zero credits triggers the top-up message without calling Gemini.
3. Replies never exceed `MAX_SEGMENTS` and contain only GSM-7 characters.
4. Replaying the same callback does not produce a second reply or a second charge.
5. `BAL`, `HELP`, `STOP`, `START` behave as specified.
6. Delivery reports update message status.
7. All tests pass, and `README.md` explains setup, sandbox testing, and going live.

## 19. GOING-LIVE CHECKLIST (list in README, do not automate)

- Live Africa's Talking account with a shortcode or number and callback URLs set.
- Production API keys; **paid** Gemini key (not the free tier).
- Credits purchase flow working (Phase 3), or manual top-ups documented.
- Data-protection review (section 13) completed by me.
- Monitoring and a daily SMS-cost alert threshold.

## 20. QUESTIONS TO ASK ME BEFORE STARTING

1. TypeScript or plain JavaScript? (Default: plain JS with JSDoc.)
2. Do I already have an Africa's Talking account, and is it sandbox only?
3. Which hosting will I use for the first deployment?
4. Which languages must be supported first: English only, or English and Kiswahili?
5. Anything in this brief that conflicts with the current Africa's Talking or Gemini docs? List it before coding.
