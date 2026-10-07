# SMS-AI

An SMS-based AI assistant for feature-phone users in Kenya. Text a question to a phone number — no mobile data needed — and get a short AI-generated answer back by SMS.

Built with Node.js, TextBee (primary SMS gateway), Africa's Talking (secondary/USSD), Google Gemini, and SQLite.

---

## How It Works

```
User's phone
    │  SMS: "What causes malaria?"
    ▼
Your Android phone (TextBee app)
    │  TextBee uploads to API
    ▼
TextBee API ──POST /webhooks/sms/textbee/:secret──▶ This Express server
    │
    ├─ Dedup → normalize phone → keyword check → rate limit → credit check
    ├─ Load 3 recent exchanges → call Gemini API (10s timeout)
    ├─ Format reply (GSM-7, max 2 SMS segments, strip markdown/emoji)
    ├─ Send reply via TextBee → User's phone
    └─ Deduct 1 credit (only after successful send)
```

---

## Phase Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ Built | Inbound SMS, credits, Gemini, rate limiting, delivery reports |
| 2 | Stub | USSD menu (`*XYZ#`) for balance, questions, top-up |
| 3 | Stub | M-Pesa STK Push for buying credits |

---

## Prerequisites

- Node.js 20+
- An Android phone registered on [TextBee](https://app.textbee.dev) with **Receive SMS** turned on
- A [Google Gemini API key](https://aistudio.google.com/app/apikey)
- (Optional) An [Africa's Talking](https://account.africastalking.com) account for USSD/shortcode

---

## Setup

**1. Clone and install**

```bash
git clone https://github.com/Veeni3-Pappi/ussd-chatbot.git
cd ussd-chatbot
npm install
```

**2. Configure environment**

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```env
WEBHOOK_SECRET=<long-random-string>        # min 32 chars, keep secret
TEXTBEE_API_KEY=<your-textbee-api-key>
TEXTBEE_WEBHOOK_SECRET=<webhook-signing-secret>  # set same value in TextBee dashboard
GEMINI_API_KEY=<your-gemini-api-key>
SMS_PROVIDER=textbee
```

Get your TextBee API key from: https://app.textbee.dev/dashboard → API Keys

**3. Run**

```bash
npm start          # production
npm run dev        # development (auto-restarts on file changes)
```

The server starts on `http://localhost:3000`. Check it with:

```bash
curl http://localhost:3000/healthz
# → {"ok":true,"uptime":5.2}
```

---

## Webhook Setup (TextBee)

TextBee can only reach a public HTTPS URL. For local testing, use a tunnel:

**Cloudflare Tunnel (free, no account needed for quick testing):**

```bash
npx cloudflare-tunnel http 3000
# Outputs: https://abc123.trycloudflare.com
```

**ngrok:**

```bash
ngrok http 3000
# Outputs: https://abc123.ngrok.io
```

Then in the [TextBee dashboard](https://app.textbee.dev/dashboard) → Webhooks → Add Webhook:

```
URL:            https://<your-tunnel>/webhooks/sms/textbee/<WEBHOOK_SECRET>
Events:         MESSAGE_RECEIVED
Signing secret: <TEXTBEE_WEBHOOK_SECRET from your .env>
```

Add a second webhook for delivery reports:

```
URL:    https://<your-tunnel>/webhooks/delivery/textbee/<WEBHOOK_SECRET>
Events: MESSAGE_SENT, MESSAGE_DELIVERED, MESSAGE_FAILED
```

Send a test SMS to your Android phone's number. The reply should arrive within seconds.

---

## Africa's Talking Setup (optional, for USSD/shortcode)

1. Create an account at https://account.africastalking.com
2. Create an app → Settings → copy the API key
3. Set in `.env`:
   ```env
   SMS_PROVIDER=africastalking
   AT_USERNAME=sandbox          # or your live app name
   AT_API_KEY=<key>
   ```
4. In AT dashboard, set the inbound SMS callback URL to:
   ```
   https://<your-host>/webhooks/sms/at/<WEBHOOK_SECRET>
   ```
5. Set delivery report callback to:
   ```
   https://<your-host>/webhooks/delivery/at/<WEBHOOK_SECRET>
   ```

For sandbox testing, messages only go to the AT simulator in the dashboard — not real phones.

---

## SMS Keywords

Send these to the number as plain text:

| Keyword | Response |
|---------|----------|
| `BAL` | Your remaining credit balance |
| `HELP` | Usage instructions |
| `STOP` | Unsubscribe (no more replies) |
| `START` | Resubscribe after STOP |

Any other text is treated as a question for Gemini.

---

## Credit System

- New users get **3 free trial credits** automatically
- Each answered question costs **1 credit**
- Credits are only deducted after the SMS is confirmed sent
- LLM or send failures never charge credits
- Add credits manually with the CLI script (see below)

---

## CLI Scripts

**Add credits to a phone number:**

```bash
node scripts/addCredits.js +254712345678 10
node scripts/addCredits.js 0712345678 20 admin "manual grant"
node scripts/addCredits.js +254712345678 5 refund "MSG-001"
```

**Print usage statistics:**

```bash
node scripts/stats.js
```

Output includes: total users, questions answered, avg SMS segments, estimated Gemini cost, daily message chart.

---

## Running Tests

```bash
npm test
```

All 86 tests should pass. Tests use an in-memory SQLite database (no file created).

Test coverage:
- `phone.test.js` — Kenyan number normalization (15 tests)
- `replyFormatter.test.js` — GSM-7 sanitizing, segment counting, truncation (30 tests)
- `rateLimit.test.js` — per-minute and per-day rate limiting (7 tests)
- `credits.test.js` — credit creation, deduction, ledger consistency (16 tests)
- `messageHandler.test.js` — full pipeline integration (18 tests)

---

## Deployment

**Requirements:**
- A public HTTPS URL (VPS with Nginx, Render, Railway, Fly.io)
- Persistent storage for the SQLite file (use a volume, not ephemeral filesystem)
- Single instance only — the in-memory rate limiter and SQLite are not distributed

**PM2 on a VPS (recommended for v1):**

```bash
npm install -g pm2
pm2 start src/server.js --name sms-ai
pm2 save
pm2 startup
```

**Daily SQLite backup:**

```bash
# Add to crontab: backs up DB every day at 03:00
0 3 * * * cp /path/to/data/sms-ai.db /path/to/backups/sms-ai-$(date +\%Y\%m\%d).db
```

---

## Privacy and Data Retention

- **Message bodies** are stored in SQLite and automatically set to `NULL` after 24 hours
- **Phone numbers** are stored normalized (+254XXXXXXXXX format) and masked in logs
- **Processed message IDs** are deleted after 7 days
- API keys are never logged; message content is only logged at debug level

> ⚠️ **Kenya Data Protection Act, 2019**: This service collects personal data (phone numbers, message content) about Kenyan users. Before going live, review your obligations under the KDPA including possible ODPC registration. Check Africa's Talking and TextBee's acceptable-use policies. This README does not constitute legal advice.

---

## Gemini Free Tier Warning

> ⚠️ The free Gemini API tier may use content sent through it to improve Google's products. Switch to a paid API key before real users send private messages.

---

## Going-Live Checklist

- [ ] Live TextBee account with Android phone online and Receive SMS enabled
- [ ] TextBee webhook URLs configured with correct secrets
- [ ] Production Gemini API key (paid tier)
- [ ] `WEBHOOK_SECRET` is a long random string (32+ chars), not the default
- [ ] `.env` is not committed to git (check `.gitignore`)
- [ ] Data protection review completed
- [ ] SQLite backup job running
- [ ] `/healthz` endpoint monitored (uptime tool, e.g. UptimeRobot)
- [ ] SMS cost alert threshold set in TextBee dashboard

---

## Environment Variables

See `.env.example` for all variables with descriptions.

Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `WEBHOOK_SECRET` | Yes | URL path secret for all webhooks |
| `TEXTBEE_API_KEY` | Yes (if using TextBee) | TextBee API key |
| `TEXTBEE_WEBHOOK_SECRET` | Recommended | HMAC secret for TextBee signature verification |
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `GEMINI_MODEL` | No | Default: `gemini-2.0-flash-lite` |
| `SMS_PROVIDER` | No | `textbee` (default) or `africastalking` |
| `FREE_TRIAL_CREDITS` | No | Default: `3` |
| `MAX_SEGMENTS` | No | Default: `2` (max SMS segments per reply) |
| `MAINTENANCE_MODE` | No | Set to `true` to pause all LLM calls |
