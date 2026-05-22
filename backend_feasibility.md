# 🔬 Feasibility Study: Backend REST / Rust Service & Scraping (NSE, Moneycontrol, Screener)

This document analyzes the speed, feasibility, and technical constraints of moving data collection and analysis to a backend service (REST API in Node/Python or Rust) rather than fetching directly from the browser.

---

## 🏎️ Section 1: Architecture Comparison

### Option A: Current Client-Side Browser App
*   **How it works**: Javascript in the browser calls Yahoo Finance via a public CORS proxy (`allorigins.win`).
*   **Latency**: **3,000ms – 8,000ms** (highly dependent on CORS proxy speed).
*   **Constraints**:
    *   CORS prevents direct browser requests to NSE, Screener, or Moneycontrol.
    *   CORS proxies add severe latency and frequently hit rate limits.
    *   No caching across different users or sessions.

### Option B: Backend REST API (Node.js/Python)
*   **How it works**: A lightweight server fetches, parses, caches, and exposes a clean `/api/analyse?symbol=TCS` endpoint to the UI.
*   **Latency**: **300ms – 1,200ms** (fast, direct connections without proxy overhead).
*   **Advantages**:
    *   Can bypass CORS restrictions completely.
    *   Can implement server-side caching (e.g. cache stock fundamentals for 24 hours, update prices every 1 minute).
    *   Enables web scraping of HTML pages (Screener/Moneycontrol).

### Option C: Backend REST API in Rust
*   **How it works**: High-performance backend compiled to native binary using libraries like `tokio` (async runtime) and `reqwest` (HTTP client).
*   **Latency**: **50ms – 250ms** (extreme performance).
*   **Advantages**:
    *   Concurrent requests run in parallel at CPU speeds.
    *   Minimal memory consumption (~15MB RAM total vs Node's ~150MB).
    *   Ideal if you are processing massive watchlists or running complex mathematical algorithms.
*   **Disadvantages**: Higher development complexity, longer compile times, and harder to deploy/maintain compared to Node or Python.

---

## 📊 Section 2: Data Sources (NSE, Moneycontrol, Screener)

Here is the feasibility analysis of scraping or calling these platforms directly:

### 1. NSE India (nseindia.com)
*   **Feasibility**: **High (via Backend)** | **Impossible (via Browser)**
*   **Type of Data**: Official real-time stock prices, Option Chain (PCR), FII/DII data, Bulk/Block deals.
*   **How to get it**: NSE exposes hidden JSON APIs used by its website (e.g., `https://www.nseindia.com/api/quote-equity?symbol=RELIANCE`).
*   **Constraints**:
    *   **Anti-Bot Protection**: NSE blocks requests without valid headers. The backend *must* fetch the main page (`/`) first to obtain valid session cookies, and pass those cookies + a real browser `User-Agent` string in subsequent API calls.
    *   **IP Blocking**: Frequent calling will trigger Cloudflare block walls. Requires caching data for at least 1-5 minutes to minimize hits.

### 2. Screener.in
*   **Feasibility**: **Moderate**
*   **Type of Data**: 5-to-10 years of clean quarterly/annual financial statement tables, detailed PE charts.
*   **How to get it**: HTML scraping using libraries like `Cheerio` (Node) or `BeautifulSoup` (Python).
*   **Constraints**:
    *   HTML structure changes will occasionally break the parser.
    *   To get full historical data beyond 5 years, Screener requires a logged-in session, meaning your scraper would need to pass login credentials or cookie sessions.

### 3. Moneycontrol (moneycontrol.com)
*   **Feasibility**: **High**
*   **Type of Data**: Real-time news, forum/comment sentiment, technical pivot points, broker recommendations.
*   **How to get it**: Scrape specific stock pages or read public RSS news feeds.
*   **Constraints**:
    *   Moneycontrol pages contain heavy ad code and bloated HTML, making scraping slower and resource-intensive on the server.

---

## 🛠️ Section 3: Summary of Constraints & Recommendations

| Parameter | Browser (Current) | Backend REST (Node/Python) | Backend REST (Rust) |
|:---|:---|:---|:---|
| **Speed** | 🐌 Slow (3-8s) | ⚡ Fast (0.5-1s) | 🚀 Blazing Fast (<0.2s) |
| **CORS Issues** | Yes (Requires proxy) | None | None |
| **Scraping Ability** | Impossible | Easy (Puppeteer/Axios) | Moderate (reqwest/scraper) |
| **Deployment Cost** | $0 (Vercel/Static) | $0 (Render/Railway Free Tier)| $0 (Render/Railway Free Tier) |
| **Best Choice For** | Simple MVP | **Production & Web Scraping** | High-Frequency Trading |

### Recommendation
For your goal (**Live, Free, Real Indian Market data**), a **Node.js or Python REST API Backend** is the best choice:
1.  It is simple to develop and 100% free to host on platforms like Render or Railway.
2.  It allows us to scrape **Screener.in** and query **NSE India** directly using user-agents and cookie managers, bypassing CORS and anti-bot systems.
3.  The frontend UI remains clean, simple, and loads in less than a second because it only has to make one API call to our backend.
