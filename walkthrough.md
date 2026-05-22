# Swing Trading App — Walkthrough & Status

## 🟢 Live Production URL
**[https://swing-trading-app-nine.vercel.app](https://swing-trading-app-nine.vercel.app)**

---

## What Was Fixed (This Session)

### 1. NGINX Reverse-Proxy Subpath Stripping Bug — FIXED
**Root cause**: In `nginx.conf`, the directive `proxy_pass $backend_api_url/api/;` used a variable. Under NGINX's routing rules, when variables are used in `proxy_pass` and a URI prefix is appended, NGINX fails to translate the URI path correctly and instead sends the raw root request (`/api/`) to the backend, completely discarding the subpaths like `/api/health` or `/api/analyze`. This broke all backend calls routed through the frontend NGINX proxy.

**Fix applied:**
- Changed `proxy_pass $backend_api_url/api/;` to `proxy_pass $backend_api_url;` in `nginx.conf`.
- Reloaded the NGINX configuration inside the running Docker container (`nginx -s reload`).
- Verified that all endpoints (e.g. `/api/health`, `/api/analyze`) are now successfully proxied and return correct JSON payloads.

---

## 🛠️ Previous Changes Implemented

### 1. Infinite Skeleton Loading Bug — FIXED
**Root cause**: Invalid ticker `ETERNAL` (without `.NS` suffix) returned a 404 from Yahoo Finance → the entire watchlist would show loading skeletons forever.

**Fix applied:**
- `loadWatchlist()` now auto-corrects `ETERNAL` → `ETERNAL.NS` from localStorage.
- `analyzeAndStore()` now stores an **error sentinel** (instead of `undefined`) for failed stocks — the skeleton is replaced by a ⚠️ "Invalid ticker — Remove" badge.
- `updateWatchlistUI()` only shows skeleton animation when `state.loading.has(symbol)` is `true` AND no result exists.

### 2. Recommendations Grid Stuck at "Analysing stocks..." — FIXED
**Root cause**: Grid only rendered after ALL stocks had results. If one failed, it never showed anything.

**Fix applied:**
- Filters out `error` states from the recommendations grid.
- Shows **partial results** immediately as each stock loads (progressive rendering).
- Loading placeholder skeleton cards shown for still-loading stocks.
- Proper empty state when all stocks fail.

### 3. analyzeStock Error Propagation — FIXED
- Backend 500 errors (invalid tickers) now **throw** immediately without retrying through CORS proxy.
- Client-side fallback validates `quote.price > 0` before proceeding.
- `fetchFullAnalysisFromBackend` returns the JSON error body instead of throwing, so callers can inspect `data.error`.

### 4. Auto-retry with .NS Suffix — ADDED
- If a symbol returns price = 0 and has no suffix, auto-retries with `.NS` appended.
- Updates `localStorage` watchlist to the corrected symbol silently.

### 5. Real-time Auto-Refresh — ADDED
- Market indices + Fear & Greed auto-refresh every **5 minutes** silently in background.
- Live clock `🕐 HH:MM` in topbar showing last data update time (updates every minute).

### 6. Refined Scoring Engine & Chart Aesthetics — ADDED
- **Tiered Multi-level Valuations**: Replaced single thresholds with tiered valuation mapping (e.g. PE ranges <15, 15-30, 30-45, >=45; PB ranges <3, 3-6, >=6).
- **Financial Sector Adaptation**: Excluded debt-to-equity threshold checks for Banking/NBFC symbols. Replaced with liquidity health check.
- **Mega-cap Scaling**: Relaxed ROE requirements (>9% solid, >12% excellent) for mega-caps (>₹1.5 Lakh Cr) to honor stable large-scale compounders like `RELIANCE.NS`.
- **Chart.js Enhancements**: Added support/resistance lines (S1/R1), semi-transparent Bollinger Bands channel fill, RSI 30-70 channel background, and standard 4-color MACD histogram coloring.

### 7. Year-Based Financials Filter & YoY Correction — ADDED
- **Financial Year Filter**: Added a dropdown selector `id="quarter-filter-select"` to filter quarterly financials dynamically by year (e.g., FY24, FY23).
- **YoY quarterly comparison correction**: Updated YoY calculation to compare the current quarter with the quarter 4 positions back (`i + 4`) in the chronologically ordered 12-quarter scraper data.

### 8. Featured News & Chat Fallback Reports — ADDED
- **Major News Banner**: Featured the top sentiment news item at the top of the sentiment tab using a premium styled badge and gradient.
- **API-Key Fallback Chat**: Added a server-side and client-side markdown generator that builds a detailed stock trading report when the Gemini API key is missing.

### 9. Side-by-Side Rankings & Market-Wide Sector Heatmap — ADDED
- **Top Losers / Gainers Side-by-Side**: Re-ordered daily change columns. "Top Losers" is now rendered on the left and "Top Gainers" on the right.
- **Market-Wide Sector Heatmap**: Computes leaders and laggards dynamically from the full 39-stock catalog instead of the active user watchlist.
- **Real Estate Representation**: Added DLF.NS and PLD to the catalog so the Real Estate sector shows live, valid leader/laggard quotes instead of null fields.
- **Backend & Vercel Sync**: Completely synchronized the `/api/market-summary` routes between Docker containers and Vercel production functions.

### 10. Indian Ticker Focus & US Index Cleanup — ADDED
- **US Indices Removed**: Completely removed S&P 500 and NASDAQ from the top ticker banner, frontend, and backend (`server/src/index.js` & `api/index.js`), leaving only pure Indian market indices: NIFTY 50, SENSEX, and BANK NIFTY.
- **getTradingViewSymbol Refactor**: Simplified the TradingView widget symbol generator to map only BSE/NSE exchanges and removed US stocks mapping references.
- **Latency profiling alignment**: Updated `scratch/test_latency.js` to target `TCS.NS` rather than the US-based `AAPL`.

---

## Live Data Verification (as of deployment)

| Data Point | Value | Source |
|---|---|---|
| NIFTY 50 | 23,822 (+0.71%) | Yahoo Finance |
| SENSEX | 75,790 (+0.81%) | Yahoo Finance |
| Fear & Greed Index | 28 — Fear | CNN Business / Scraper |
| Real Estate Leader | PLD | Market Summary |
| Real Estate Laggard | DLF.NS | Market Summary |
| Utilities Leader | NTPC.NS | Market Summary |
| Utilities Laggard | POWERGRID.NS | Market Summary |

---

## What Still Needs Setup (Optional)

| Variable | Where | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Vercel Env Vars | Google SSO login |
| `AUTHORIZED_EMAIL` | Vercel Env Vars | Restrict dashboard access |
| `DATABASE_URL` | Vercel Env Vars | PostgreSQL activity logging |
| `GEMINI_API_KEY` | Vercel Env Vars OR in-app Settings | Invy AI chat with full context |

Without these set, the app works in **open access mode** with rule-based Invy AI responses.
