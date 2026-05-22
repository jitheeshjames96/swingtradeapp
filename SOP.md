# 📖 Standard Operating Procedure (SOP): Swing Trading App

This document outlines the operational procedures, architecture, and step-by-step setup to maintain, run, and scale the **Swing Trading App** using a **100% free tier / zero-cost** setup utilizing unofficial feeds and free-tier AI APIs (like Google Gemini).

---

## 🏗️ Section 1: Zero-Cost System Architecture

To avoid paying monthly subscriptions for stock feeds and AI reasoning, the application utilizes the following structure:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND INTERFACE                            │
│                 (HTML / CSS / Vanilla JS / Chart.js)                    │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
             ┌─────────────────────┴─────────────────────┐
             ▼                                           ▼
┌─────────────────────────┐                 ┌─────────────────────────┐
│     MARKET DATA ENGINE  │                 │    AI ANALYSIS ENGINE   │
│ (Yahoo Finance + Proxies│                 │ (Google Gemini API -    │
│  - 100% Free Live Feed) │                 │  Free Developer Tier)   │
└─────────────────────────┘                 └─────────────────────────┘
```

1.  **Price & Fundamentals Engine**: Uses Yahoo Finance unofficial REST APIs proxied through `allorigins.win` to bypass browser CORS blocks. Provides daily historical candles (1 year), key statistics (PE, ROE, Debt/Equity), and recent news headlines.
2.  **Institutional Proxy Engine (VSA)**: Instead of paid FII/DII subscription feeds, we run **Volume Spread Analysis (VSA)** locally. It flags abnormal volume spikes (>1.5x average) on positive candles as *Accumulation* and negative candles as *Distribution*.
3.  **AI Intelligence**: Integrates with the **Google Gemini API (Free Developer Tier)** to generate automated professional swing trading recommendations based on the calculated stats.

---

## 🔑 Section 2: Getting & Setting Up Your Free AI API Key

To get live AI analysis of the stock scores, you need to plug in a free Google Gemini API Key:

1.  **Get the Key**:
    *   Go to [Google AI Studio](https://aistudio.google.com/).
    *   Sign in with your Google account.
    *   Click **"Get API Key"** and generate a new key.
2.  **Save the Key**:
    *   Open your Swing Trading App folder.
    *   The app will have a settings/gear icon in the top-right header where you can paste this API key.
    *   It is securely stored in your browser's local storage (`localStorage`) so you never have to re-enter it, and it never leaks to the internet.

---

## 🛠️ Section 3: Daily Operational Walkthrough

Here is the recommended workflow to run swing trading screens every day:

```
[Start App] ──► [Wait for Market Pulse Index & Fear/Greed to Load]
                     │
                     ▼
[Scan Watched Stocks or Search Tickers (e.g., RELIANCE.NS, TCS.NS)]
                     │
                     ▼
[Select Stock to Analyze] ──► [Check Technical & Institutional Tabs]
                     │
                     ▼
[Review Stop Loss & Target setups calculated by ATR]
```

### Checklist for High-Probability Swing Setups:
- [ ] **Composite Score**: Above **70** (🟢/🟡 rating).
- [ ] **RSI**: Between **35 and 55** (oversold recovery or early momentum, not overbought).
- [ ] **Institutional Tab**: Shows **Accumulation** (high volume on green candles).
- [ ] **Technical Tab**: SMA 20 is above SMA 50, and price is close to the calculated **S1 support level**.
- [ ] **Risk-to-Reward (R/R) Ratio**: At least **1:2** or higher.

---

## 📂 Section 4: Maintenance & File Glossary

All files are located in `/Users/jitheesh.pj/Swing Trading App/`:

*   `index.html`: The user interface structure.
*   `css/style.css`: The dark theme design styling and charts layout.
*   `js/api.js`: Handles pulling data from Yahoo Finance and Fear & Greed index.
*   `js/analysis.js`: Calculates math/indicators (RSI, MACD, Bollinger Bands, ATR, Pivots).
*   `js/charts.js`: Draws line, bar, volume, and radar charts.
*   `js/ui.js`: Links the calculated data to the webpage elements.
*   `js/app.js`: Connects search, settings, storage, and initial watchlist state.
