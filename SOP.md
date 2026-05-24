# 📖 Standard Operating Procedure (SOP): SwingTrader Intelligence App

**Last Updated:** May 2026 | **Version:** 2.0

---

## 🏗️ Section 1: System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     FRONTEND (Vanilla JS / Chart.js)                    │
│          index.html · js/app.js · js/api.js · js/analysis.js           │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ HTTPS
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              VERCEL SERVERLESS BACKEND  (api/index.js)                  │
│   Auth · Stock Data · Invy AI · Nexus Robo · Broker · Alerts           │
└───────────┬───────────────────────────────────────┬─────────────────────┘
            │                                       │
            ▼                                       ▼
┌───────────────────────┐               ┌───────────────────────┐
│  Market Data Sources  │               │   AI / DB / Services  │
│  Yahoo Finance (data) │               │  Gemini 1.5 Flash (AI)│
│  alternative.me (F&G) │               │  PostgreSQL (sessions) │
│  NSE/BSE (indices)    │               │  Telegram / WhatsApp  │
└───────────────────────┘               └───────────────────────┘
```

---

## 🔑 Section 2: Environment Variables (Vercel Dashboard)

Set these in Vercel → Project → Settings → Environment Variables:

| Variable | Description | Required |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini API key (AI backbone) | **Yes** |
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `JWT_SECRET` | Auth token signing secret | Yes |
| `ENCRYPTION_KEY` | Broker token AES-256 encryption | Yes |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Yes |
| `TELEGRAM_BOT_TOKEN` | Telegram alert delivery | Optional |
| `WHATSAPP_APIKEY` | WhatsApp alert delivery | Optional |

> **No user-facing API key input.** Gemini key lives server-side only. The frontend settings modal no longer shows any API key fields.

---

## 🧠 Section 3: AI Systems

### Invy AI (Stock Strategist)
- **Backend route:** `POST /api/chat`
- **Auth:** Required (JWT middleware)
- **Key:** `process.env.GEMINI_API_KEY` — server-side only, never exposed to client
- **Token limit:** 600 output tokens (increased from 250)
- **Context injected:** live RSI, MACD, Bollinger, volume ratio, pivots, 5-pillar scores, news, market summary
- **Fallback:** If Gemini unavailable → `generateDetailedFallbackReport()` runs rule-based response

### Nexus Robo-Advisory (Wealth Matrix)
- **Backend route:** `POST /api/nexus-profile`
- **Auth:** Required (JWT middleware)
- **Input:** age, profession, incomeStability, dependents, netIncome, capitalAllocation, riskAppetite, behavioralStressResponse
- **Output:** AI-generated wealth matrix with 6 sections:
  1. Risk Profile summary
  2. Asset allocation (% split: equity/debt/gold/cash)
  3. Equity sector weights (top 5)
  4. Monthly SIP plan (₹ amounts across categories)
  5. Crash scenario analysis (20% NIFTY drawdown impact)
  6. 3 trading rules for this specific profile
- **Token limit:** 900 output tokens

---

## 📊 Section 4: Scoring Engine — Single Source of Truth

All scoring pillar maximums are defined in `js/analysis.js`. The defaults below match the actual max values:

| Pillar | Max Raw Score | Default Weight % |
|---|---|---|
| Fundamentals | 25 pts | 25% |
| Technical Setup | 20 pts | 20% |
| Momentum | 20 pts | 20% |
| Sentiment | 15 pts | 15% |
| Institutional | 20 pts | 20% |
| **Total** | **100 pts** | **100%** |

**Composite formula:** `Σ (pillar_score / pillar_max) × weight%` → normalized to 100.

**Rating thresholds:**
- 🟢 Strong Buy: 80–100
- 🟡 Buy: 65–79
- 🟠 Watch: 50–64
- 🔴 Avoid: 35–49
- ⛔ Strong Avoid: 0–34

> Note: Stocks trading below SMA200 are capped at 64 regardless of score.

---

## 🔐 Section 5: Broker Integration Security Model

Zerodha Kite and Upstox credentials are handled **server-side only**:

1. User submits API Key + Access Token via browser form
2. Backend receives via `POST /api/portfolio/connect`
3. Credentials are **AES-256 encrypted** using `ENCRYPTION_KEY` via `server/src/brokers/cryptoHelper.js`
4. Encrypted tokens stored in `user_broker_connections` table (PostgreSQL)
5. On portfolio sync, backend decrypts and calls broker API — raw tokens never return to browser

---

## 🛠️ Section 6: Daily Trading Workflow

```
[Open App] → [Sign In (Google / Email)] → [Market Pulse Loads]
     ↓
[Check NIFTY 50 / SENSEX / BANK NIFTY + Fear & Greed index]
     ↓
[Watchlist auto-scores all stocks → sorted by composite score]
     ↓
[Click any 🟢 Strong Buy (80+) stock → full analysis opens]
     ↓
[Review: Technical tab → RSI / MACD / Bollinger / Pivots]
     ↓
[Ask Invy AI: "Is this a valid swing setup?" → get entry/SL/target]
     ↓
[Check Institutional tab → volume ratio and accumulation signal]
     ↓
[Set Price/RSI alert → delivered via Telegram/WhatsApp]
     ↓
[Trade → log in portfolio → sync via Zerodha/Upstox]
```

---

## ⚙️ Section 7: Weight Tuning Engine

The weight tuning sliders (in the main dashboard) let you customize how the 5 pillars are weighted. Rules:
- All 5 weights must sum to exactly 100%
- Changes persist in `localStorage` under `stid_weights`
- Reset button restores defaults (25/20/20/15/20)
- In Bear regime: technical and momentum weights auto-reduce by 30%, fundamental weight increases by 30%

---

## 🚀 Section 8: Deployment Pipeline

### Auto-Deploy (Recommended)
1. Push to `main` branch on GitHub
2. Vercel detects push → builds in ~60s → live at `swing-trading-app-nine.vercel.app`

### Manual Deploy
```bash
npm install -g vercel
vercel --prod
```

### Local Development
```bash
cd swingtradeapp
npm install
vercel dev   # runs serverless functions locally on port 3000
```

---

## 🔄 Section 9: Cron Jobs

| Schedule | Endpoint | Purpose |
|---|---|---|
| Daily 11:30 AM IST | `/api/cron-validate` | Validate watchlist tickers, remove delisted |

---

## 🐛 Section 10: Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Invy AI not responding | GEMINI_API_KEY missing in Vercel env | Add key in Vercel dashboard → redeploy |
| Nexus wealth matrix blank | Same as above | Same fix |
| Stocks stuck "Loading" | Yahoo Finance CORS or timeout | Click Reset List in Settings |
| Score showing 0 for all | Backend unreachable | Check Vercel function logs |
| Portfolio not syncing | Broker token expired | Disconnect + reconnect broker |
| Auth not working | JWT_SECRET mismatch | Ensure env var set in Vercel |

---

## 📁 Section 11: Key Files Reference

| File | Purpose |
|---|---|
| `index.html` | Full UI shell — all panels, modals, chat widget |
| `js/app.js` | State management, event listeners, Nexus Robo UI |
| `js/api.js` | All API calls — backend proxy, broker, Invy, Nexus |
| `js/analysis.js` | Scoring engine — 5 pillars, composite calc, trade setup |
| `js/ui.js` | Render functions — watchlist, detail panel, charts |
| `js/charts.js` | Chart.js wrappers — candlestick, sector, pie |
| `api/index.js` | Vercel serverless backend — all routes |
| `server/src/brokers/` | Zerodha + Upstox adapter + AES crypto helper |
| `vercel.json` | Vercel routing + cron config |

