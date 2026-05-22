/* ============================================================
   API.JS — All data fetching logic
   Sources: Yahoo Finance (via CORS proxy), Fear & Greed API
   ============================================================ */

const CORS_PROXY = 'https://api.allorigins.win/get?url=';
const YAHOO_BASE = 'https://query1.finance.yahoo.com';
const YAHOO_CHART = 'https://query2.finance.yahoo.com';

// Auto-detect backend URL: custom settings, relative path when served from backend, or localhost
let BACKEND_URL = (localStorage.getItem('swing_backend_url') || '').replace(/\/$/, '') || 
                  ((window.location.protocol === 'file:') ? 'http://localhost:3000' : window.location.origin);
let backendChecked = false;
let backendAvailable = false;

function getAuthHeaders() {
  const token = localStorage.getItem('google_sso_token');
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function fetchAuthConfig() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/config`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('Failed to fetch auth config from backend, assuming no SSO required:', e.message);
    return { googleClientId: '' };
  }
}

function setBackendUrl(url) {
  BACKEND_URL = (url || '').replace(/\/$/, '') || ((window.location.protocol === 'file:') ? 'http://localhost:3000' : window.location.origin);
  backendChecked = false; // Reset backend status check so it re-verifies on next fetch
}

async function checkBackend() {
  if (backendChecked) return backendAvailable;
  
  const testHealth = async (baseUrl) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);
      const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
      clearTimeout(timeoutId);
      return res.ok;
    } catch (e) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
        return res.ok;
      } catch (err) {
        return false;
      }
    }
  };

  backendAvailable = await testHealth(BACKEND_URL);

  const defaultUrl = (window.location.protocol === 'file:') ? 'http://localhost:3000' : window.location.origin;
  if (!backendAvailable && BACKEND_URL !== defaultUrl) {
    console.warn(`Configured backend ${BACKEND_URL} is offline. Testing default backend: ${defaultUrl}`);
    const defaultAvailable = await testHealth(defaultUrl);
    if (defaultAvailable) {
      console.log(`Default backend is online! Auto-resetting BACKEND_URL to ${defaultUrl}`);
      localStorage.removeItem('swing_backend_url');
      BACKEND_URL = defaultUrl;
      backendAvailable = true;
    }
  }

  backendChecked = true;
  console.log('Swing Trading Backend status:', backendAvailable ? 'CONNECTED' : 'DISCONNECTED (Using client-side fallbacks)');
  
  // Update status badge UI dynamically if element exists
  const statusBadge = document.getElementById('connection-status');
  if (statusBadge) {
    if (backendAvailable) {
      statusBadge.className = 'connection-badge connected';
      statusBadge.innerHTML = `
        <div class="market-dot" style="width:8px; height:8px; background-color:#22c55e; border-radius:50%; display:inline-block; margin-right:4px;"></div>
        <span>Live Backend</span>
      `;
      statusBadge.title = 'Dashboard is connected to accurate market scraper service';
    } else {
      statusBadge.className = 'connection-badge mock';
      statusBadge.innerHTML = `
        <div class="market-dot" style="width:8px; height:8px; background-color:#f59e0b; border-radius:50%; display:inline-block; margin-right:4px;"></div>
        <span>Offline Fallback</span>
      `;
      statusBadge.title = 'Backend offline. Showing simulated/mock data due to CORS proxy constraints';
    }
  }

  return backendAvailable;
}

async function fetchFullAnalysisFromBackend(symbol) {
  const res = await fetch(`${BACKEND_URL}/api/analyze?symbol=${encodeURIComponent(symbol)}`, {
    headers: getAuthHeaders()
  });
  // Always parse JSON so we can read error messages from backend
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    // Return error object so analyzeStock can detect it (don't throw here)
    return { error: data.error || `HTTP ${res.status}`, details: data.details || '' };
  }
  return data;
}

async function fetchMarketPulseFromBackend() {
  const res = await fetch(`${BACKEND_URL}/api/market-pulse`, {
    headers: getAuthHeaders()
  });
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return await res.json();
}

// Predefined popular Indian and US stocks
const STOCK_CATALOG = [
  { symbol: 'RELIANCE.NS',   name: 'Reliance Industries',       sector: 'Energy' },
  { symbol: 'TCS.NS',        name: 'Tata Consultancy Services', sector: 'IT' },
  { symbol: 'INFY.NS',       name: 'Infosys Ltd',               sector: 'IT' },
  { symbol: 'HDFCBANK.NS',   name: 'HDFC Bank',                 sector: 'Banking' },
  { symbol: 'ICICIBANK.NS',  name: 'ICICI Bank',                sector: 'Banking' },
  { symbol: 'WIPRO.NS',      name: 'Wipro Ltd',                 sector: 'IT' },
  { symbol: 'TATAMOTORS.NS', name: 'Tata Motors',               sector: 'Auto' },
  { symbol: 'TATASTEEL.NS',  name: 'Tata Steel',                sector: 'Metals' },
  { symbol: 'ADANIENT.NS',   name: 'Adani Enterprises',         sector: 'Conglomerate' },
  { symbol: 'BAJFINANCE.NS', name: 'Bajaj Finance',             sector: 'NBFC' },
  { symbol: 'SBIN.NS',       name: 'State Bank of India',       sector: 'Banking' },
  { symbol: 'SUNPHARMA.NS',  name: 'Sun Pharmaceutical',        sector: 'Pharma' },
  { symbol: 'HINDUNILVR.NS', name: 'Hindustan Unilever',        sector: 'FMCG' },
  { symbol: 'AXISBANK.NS',   name: 'Axis Bank',                 sector: 'Banking' },
  { symbol: 'MARUTI.NS',     name: 'Maruti Suzuki',             sector: 'Auto' },
  { symbol: 'ETERNAL.NS',    name: 'Eternal Limited (Zomato)',  sector: 'Consumer Tech' },
  { symbol: 'BAJAJFINSV.NS', name: 'Bajaj Finserv',             sector: 'NBFC' },
  { symbol: 'KOTAKBANK.NS',  name: 'Kotak Mahindra Bank',       sector: 'Banking' },
  { symbol: 'LT.NS',         name: 'Larsen & Toubro',           sector: 'Engineering' },
  { symbol: 'ASIANPAINT.NS', name: 'Asian Paints',              sector: 'Paints' },
  { symbol: 'HCLTECH.NS',    name: 'HCL Technologies',          sector: 'IT' },
  { symbol: 'ULTRACEMCO.NS', name: 'UltraTech Cement',          sector: 'Cement' },
  { symbol: 'POWERGRID.NS',  name: 'Power Grid Corp',           sector: 'Utilities' },
  { symbol: 'NTPC.NS',       name: 'NTPC Ltd',                  sector: 'Utilities' },
  { symbol: 'NESTLEIND.NS',  name: 'Nestle India',              sector: 'FMCG' },
  { symbol: 'TITAN.NS',      name: 'Titan Company',             sector: 'Consumer' },
  { symbol: 'TATAPOWER.NS',  name: 'Tata Power',                sector: 'Utilities' },
  { symbol: 'DRREDDY.NS',    name: 'Dr. Reddy\'s Laboratories', sector: 'Pharma' },
  { symbol: 'CIPLA.NS',      name: 'Cipla Ltd',                 sector: 'Pharma' },
  { symbol: 'AAPL',   name: 'Apple Inc',          sector: 'Technology' },
  { symbol: 'MSFT',   name: 'Microsoft Corp',     sector: 'Technology' },
  { symbol: 'NVDA',   name: 'NVIDIA Corp',        sector: 'Semiconductors' },
  { symbol: 'GOOGL',  name: 'Alphabet Inc',       sector: 'Technology' },
  { symbol: 'AMZN',   name: 'Amazon.com',         sector: 'E-Commerce' },
  { symbol: 'TSLA',   name: 'Tesla Inc',           sector: 'Auto/EV' },
  { symbol: 'META',   name: 'Meta Platforms',     sector: 'Social Media' },
  { symbol: 'NFLX',   name: 'Netflix Inc',        sector: 'Streaming' },
  { symbol: 'JPM',    name: 'JPMorgan Chase',     sector: 'Banking' },
  { symbol: 'AMD',    name: 'Advanced Micro Devices', sector: 'Semiconductors' },
];

// Sector ETF proxies for heatmap
const SECTOR_MAP = [
  { name: 'Technology', symbol: 'XLK',  icon: '💻' },
  { name: 'Financials', symbol: 'XLF',  icon: '🏦' },
  { name: 'Healthcare', symbol: 'XLV',  icon: '🏥' },
  { name: 'Energy',     symbol: 'XLE',  icon: '⚡' },
  { name: 'Industrials',symbol: 'XLI',  icon: '🏭' },
  { name: 'Materials',  symbol: 'XLB',  icon: '🪨' },
  { name: 'Real Estate',symbol: 'XLRE', icon: '🏢' },
  { name: 'Utilities',  symbol: 'XLU',  icon: '💡' },
];

// Market indices
const MARKET_INDICES = [
  { name: 'NIFTY 50',   symbol: '^NSEI' },
  { name: 'SENSEX',     symbol: '^BSESN' },
  { name: 'S&P 500',    symbol: '^GSPC' },
  { name: 'NASDAQ',     symbol: '^IXIC' },
];

// ── Cache layer
const _cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) { _cache.set(key, { ts: Date.now(), data }); }

// ── Core fetch wrapper with CORS proxy
async function proxyFetch(url) {
  const cacheKey = url;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`${CORS_PROXY}${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const wrapper = await res.json();
    const data = JSON.parse(wrapper.contents);
    cacheSet(cacheKey, data);
    return data;
  } catch (e) {
    console.warn('proxyFetch failed for', url, e.message);
    return null;
  }
}

// ── Direct fetch (for APIs that allow CORS)
async function directFetch(url) {
  const cached = cacheGet(url);
  if (cached) return cached;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cacheSet(url, data);
    return data;
  } catch (e) {
    console.warn('directFetch failed:', url, e.message);
    return null;
  }
}

// ── FEAR & GREED INDEX
async function fetchFearGreed() {
  const data = await directFetch('https://fear-and-greed-index.p.rapidapi.com/v1/fgi');
  // Fallback: alternative.me
  const alt = await directFetch('https://api.alternative.me/fng/?limit=1');
  if (alt && alt.data && alt.data[0]) {
    return {
      value: parseInt(alt.data[0].value),
      text: alt.data[0].value_classification,
    };
  }
  // Static fallback
  return { value: 52, text: 'Neutral' };
}

// ── YAHOO FINANCE QUOTE
async function fetchQuote(symbol) {
  const url = `${YAHOO_BASE}/v8/finance/chart/${symbol}?interval=1d&range=1d`;
  const data = await proxyFetch(url);
  if (!data || !data.chart || !data.chart.result) return generateMockQuote(symbol);

  try {
    const result = data.chart.result[0];
    const meta = result.meta;
    const close = meta.regularMarketPrice || 0;
    const prevClose = meta.chartPreviousClose || meta.previousClose || close;
    const change = close - prevClose;
    const changePct = prevClose ? ((change / prevClose) * 100) : 0;

    return {
      symbol,
      price: close,
      change,
      changePct,
      open: meta.regularMarketOpen || close,
      high: meta.regularMarketDayHigh || close,
      low: meta.regularMarketDayLow || close,
      volume: meta.regularMarketVolume || 0,
      marketCap: meta.marketCap || 0,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || '',
    };
  } catch (e) {
    return generateMockQuote(symbol);
  }
}

// ── YAHOO FINANCE SUMMARY (Fundamentals)
async function fetchFundamentals(symbol) {
  const modules = 'summaryDetail,defaultKeyStatistics,financialData,earningsTrend';
  const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${symbol}?modules=${modules}`;
  const data = await proxyFetch(url);
  if (!data || !data.quoteSummary || !data.quoteSummary.result) {
    return generateMockFundamentals(symbol);
  }

  try {
    const result = data.quoteSummary.result[0];
    const sd = result.summaryDetail || {};
    const ks = result.defaultKeyStatistics || {};
    const fd = result.financialData || {};

    const insiders = ks.heldPercentInsiders?.raw ? parseFloat((ks.heldPercentInsiders.raw * 100).toFixed(2)) : null;
    const institutions = ks.heldPercentInstitutions?.raw ? parseFloat((ks.heldPercentInstitutions.raw * 100).toFixed(2)) : null;
    let publicHeld = null;
    if (insiders !== null || institutions !== null) {
      publicHeld = parseFloat((100 - (insiders || 0) - (institutions || 0)).toFixed(2));
      if (publicHeld < 0) publicHeld = 0;
    }

    return {
      pe: sd.trailingPE?.raw || sd.forwardPE?.raw || null,
      forwardPE: sd.forwardPE?.raw || null,
      pb: ks.priceToBook?.raw || null,
      eps: ks.trailingEps?.raw || null,
      roe: fd.returnOnEquity?.raw ? fd.returnOnEquity.raw * 100 : null,
      debtToEquity: fd.debtToEquity?.raw || null,
      revenueGrowth: fd.revenueGrowth?.raw ? fd.revenueGrowth.raw * 100 : null,
      earningsGrowth: fd.earningsGrowth?.raw ? fd.earningsGrowth.raw * 100 : null,
      profitMargin: fd.profitMargins?.raw ? fd.profitMargins.raw * 100 : null,
      currentRatio: fd.currentRatio?.raw || null,
      dividendYield: sd.dividendYield?.raw ? sd.dividendYield.raw * 100 : null,
      marketCap: sd.marketCap?.raw || 0,
      beta: sd.beta?.raw || null,
      fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh?.raw || null,
      fiftyTwoWeekLow: sd.fiftyTwoWeekLow?.raw || null,
      avgVolume: sd.averageVolume?.raw || 0,
      shareholding: (insiders !== null || institutions !== null) ? {
        insiders,
        institutions,
        public: publicHeld
      } : null
    };
  } catch (e) {
    return generateMockFundamentals(symbol);
  }
}

// ── HISTORICAL OHLCV (for technical analysis)
async function fetchHistorical(symbol, range = '1y', interval = '1d') {
  const url = `${YAHOO_CHART}/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const data = await proxyFetch(url);
  if (!data || !data.chart || !data.chart.result) return generateMockHistorical();

  try {
    const result = data.chart.result[0];
    const timestamps = result.timestamp || [];
    const quotes = result.indicators.quote[0] || {};
    const ohlcv = timestamps.map((t, i) => ({
      date: new Date(t * 1000),
      open: quotes.open?.[i] || 0,
      high: quotes.high?.[i] || 0,
      low: quotes.low?.[i] || 0,
      close: quotes.close?.[i] || 0,
      volume: quotes.volume?.[i] || 0,
    })).filter(d => d.close > 0);
    return ohlcv;
  } catch (e) {
    return generateMockHistorical();
  }
}

// ── QUARTERLY EARNINGS
async function fetchEarnings(symbol) {
  const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${symbol}?modules=earningsHistory,incomeStatementHistoryQuarterly,incomeStatementHistory`;
  const data = await proxyFetch(url);
  if (!data || !data.quoteSummary || !data.quoteSummary.result) {
    return generateMockEarnings();
  }

  try {
    const result = data.quoteSummary.result[0];
    const quarterly = result.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
    const annual = result.incomeStatementHistory?.incomeStatementHistory || [];

    const parseQuarterly = quarterly.slice(0, 8).map(q => ({
      period: q.endDate?.fmt || 'N/A',
      revenue: q.totalRevenue?.raw || 0,
      netIncome: q.netIncome?.raw || 0,
      eps: q.dilutedEPS?.raw || null,
    }));

    const parseAnnual = annual.slice(0, 5).map(a => ({
      period: a.endDate?.fmt || 'N/A',
      revenue: a.totalRevenue?.raw || 0,
      netIncome: a.netIncome?.raw || 0,
      eps: a.dilutedEPS?.raw || null,
    }));

    return { quarterly: parseQuarterly, annual: parseAnnual };
  } catch (e) {
    return generateMockEarnings();
  }
}

// ── SECTOR PERFORMANCE
async function fetchSectorPerformance() {
  const results = await Promise.all(
    SECTOR_MAP.map(async (s) => {
      const q = await fetchQuote(s.symbol);
      return { ...s, change: q.changePct, price: q.price };
    })
  );
  return results;
}

// ── MARKET INDICES
async function fetchMarketIndices() {
  const results = await Promise.all(
    MARKET_INDICES.map(async (idx) => {
      const q = await fetchQuote(idx.symbol);
      return { ...idx, price: q.price, change: q.changePct, rawChange: q.change };
    })
  );
  return results;
}

// ── NEWS SENTIMENT (simulated from Yahoo Finance)
async function fetchNewsSentiment(symbol) {
  const url = `${YAHOO_BASE}/v1/finance/search?q=${symbol}&newsCount=8`;
  const data = await proxyFetch(url);
  const news = [];

  if (data && data.news) {
    data.news.slice(0, 6).forEach(n => {
      const sentiment = analyzeSentimentKeywords(n.title || '');
      news.push({
        headline: n.title,
        source: n.publisher,
        time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toLocaleDateString() : 'Recent',
        sentiment,
        url: n.link,
      });
    });
  }

  if (news.length === 0) return generateMockNews(symbol);
  return news;
}

// Basic keyword-based sentiment analyzer
function analyzeSentimentKeywords(text) {
  const t = text.toLowerCase();
  const bullish = ['surge', 'rally', 'gain', 'beat', 'strong', 'growth', 'profit', 'record', 'upgrade', 'buy', 'bull', 'rise', 'up', 'positive', 'boost', 'outperform', 'expand', 'win', 'exceed', 'high'];
  const bearish = ['fall', 'drop', 'loss', 'miss', 'weak', 'decline', 'down', 'sell', 'bear', 'cut', 'downgrade', 'concern', 'risk', 'crash', 'plunge', 'slump', 'fail', 'negative', 'below', 'low'];

  let score = 0;
  bullish.forEach(w => { if (t.includes(w)) score++; });
  bearish.forEach(w => { if (t.includes(w)) score--; });

  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

// ── SEARCH STOCKS
function searchStocks(query) {
  if (!query || query.length < 1) return [];
  const q = query.toLowerCase();
  return STOCK_CATALOG.filter(s =>
    s.symbol.toLowerCase().includes(q) ||
    s.name.toLowerCase().includes(q) ||
    s.sector.toLowerCase().includes(q)
  ).slice(0, 8);
}

// ============================================================
// MOCK DATA GENERATORS (fallback when API fails)
// ============================================================

function generateMockQuote(symbol) {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const price = 100 + (seed % 4000) + Math.random() * 50;
  const changePct = (Math.random() - 0.45) * 4;
  const change = price * changePct / 100;
  return {
    symbol, price: parseFloat(price.toFixed(2)),
    change: parseFloat(change.toFixed(2)),
    changePct: parseFloat(changePct.toFixed(2)),
    open: price - change * 0.3,
    high: price + Math.abs(change) * 0.8,
    low: price - Math.abs(change) * 0.8,
    volume: Math.floor(1000000 + Math.random() * 5000000),
    marketCap: price * 1e8, currency: 'INR', exchange: 'NSE',
  };
}

function generateMockFundamentals(symbol) {
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = (min, max) => min + ((seed * 9301 + 49297) % 233280 / 233280) * (max - min);
  return {
    pe: parseFloat(rand(8, 60).toFixed(1)),
    forwardPE: parseFloat(rand(6, 45).toFixed(1)),
    pb: parseFloat(rand(0.5, 8).toFixed(2)),
    eps: parseFloat(rand(5, 200).toFixed(2)),
    roe: parseFloat(rand(5, 40).toFixed(1)),
    debtToEquity: parseFloat(rand(0.1, 2.5).toFixed(2)),
    revenueGrowth: parseFloat(rand(-5, 35).toFixed(1)),
    earningsGrowth: parseFloat(rand(-10, 50).toFixed(1)),
    profitMargin: parseFloat(rand(2, 30).toFixed(1)),
    currentRatio: parseFloat(rand(0.8, 3.5).toFixed(2)),
    dividendYield: parseFloat(rand(0, 4).toFixed(2)),
    marketCap: rand(1e10, 1e14),
    beta: parseFloat(rand(0.5, 2).toFixed(2)),
    fiftyTwoWeekHigh: parseFloat(rand(500, 5000).toFixed(2)),
    fiftyTwoWeekLow: parseFloat(rand(100, 400).toFixed(2)),
    avgVolume: Math.floor(rand(500000, 10000000)),
  };
}

function generateMockHistorical() {
  const data = [];
  let price = 1000 + Math.random() * 2000;
  const now = Date.now();
  for (let i = 252; i >= 0; i--) {
    const date = new Date(now - i * 86400000);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const change = (Math.random() - 0.48) * price * 0.025;
    price = Math.max(price + change, 10);
    const open = price + (Math.random() - 0.5) * price * 0.01;
    const high = Math.max(price, open) + Math.random() * price * 0.015;
    const low = Math.min(price, open) - Math.random() * price * 0.015;
    data.push({
      date, open: parseFloat(open.toFixed(2)), high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)), close: parseFloat(price.toFixed(2)),
      volume: Math.floor(500000 + Math.random() * 3000000),
    });
  }
  return data;
}

function generateMockEarnings() {
  const quarters = ['Q4 FY24','Q3 FY24','Q2 FY24','Q1 FY24','Q4 FY23','Q3 FY23','Q2 FY23','Q1 FY23'];
  const years    = ['FY2024','FY2023','FY2022','FY2021','FY2020'];
  let rev = 50000 + Math.random() * 200000;
  let inc = rev * 0.12;
  const quarterly = quarters.map((period, i) => {
    rev *= (0.95 + Math.random() * 0.15);
    inc *= (0.9 + Math.random() * 0.2);
    return { period, revenue: Math.floor(rev * 1e5), netIncome: Math.floor(inc * 1e5), eps: parseFloat((inc * 0.002).toFixed(2)) };
  });
  let arev = 200000 + Math.random() * 800000;
  let ainc = arev * 0.12;
  const annual = years.map((period, i) => {
    arev *= (0.9 + Math.random() * 0.2);
    ainc *= (0.85 + Math.random() * 0.25);
    return { period, revenue: Math.floor(arev * 1e5), netIncome: Math.floor(ainc * 1e5), eps: parseFloat((ainc * 0.001).toFixed(2)) };
  });
  return { quarterly, annual };
}

function generateMockNews(symbol) {
  const templates = [
    { headline: `${symbol} reports strong Q4 results, beats analyst estimates`, sentiment: 'positive' },
    { headline: `${symbol} announces strategic expansion into new markets`, sentiment: 'positive' },
    { headline: `Analysts upgrade ${symbol} with revised target price`, sentiment: 'positive' },
    { headline: `${symbol} faces regulatory scrutiny amid sector concerns`, sentiment: 'negative' },
    { headline: `${symbol} management commentary on macroeconomic headwinds`, sentiment: 'neutral' },
    { headline: `${symbol} unveils new product lineup for FY25`, sentiment: 'positive' },
  ];
  const sources = ['Economic Times', 'Mint', 'Business Standard', 'Reuters', 'Bloomberg', 'CNBC'];
  return templates.map((t, i) => ({
    ...t, source: sources[i % sources.length],
    time: new Date(Date.now() - i * 3600000 * 8).toLocaleDateString(),
    url: '#',
  }));
}

// ── GEMINI AI ANALYSIS (Free Developer Tier)
async function fetchGeminiAnalysis(symbol, name, dataSummary) {
  const apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const prompt = `You are a Swing Trading expert. Provide a concise, professional swing trading analysis for ${name} (${symbol}) based on the following metrics:
${JSON.stringify(dataSummary)}

Requirements:
1. Provide a clear Verdict (Buy, Watch, or Avoid).
2. Point out 2 key strengths and 2 risks.
3. Suggest an entry range, Stop Loss, and target range.
4. Keep it under 200 words, formatted in clean HTML (using tags like <strong>, <br>, <ul/>, <li/>) and style it nicely.`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  } catch (e) {
    console.warn('Gemini API request failed:', e);
    return null;
  }
}

// ── INVY AI CHAT SYSTEM (Client-side, quota-friendly with backend fallback)
async function sendInvyChatMessage(history, message, currentStockContext) {
  const apiKey = localStorage.getItem('gemini_api_key');
  
  if (!apiKey) {
    // Backend fallback proxy (handles free tier proxy using server key or rule-based response)
    const url = `${BACKEND_URL}/api/chat`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ history, message, currentStockContext })
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server responded with status ${res.status}`);
      }
      const data = await res.json();
      return data.response;
    } catch (e) {
      console.warn('Backend proxy chat failed:', e.message);
      throw new Error(`Invy AI Chat error: ${e.message}`);
    }
  }

  // Browser-direct query using user's saved Gemini API Key
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const systemInstructionText = `You are "Invy", a veteran swing trader and investment strategist with 25 years of experience.
Your goal is to guide users to pick stocks at the perfect price using a combination of fundamentals, technical setup, momentum, sentiment & flows, and disciplined risk management.
Always adhere strictly to these rules:
1. Be professional, highly concise, and direct. Keep responses under 120 words.
2. Use bullet points or short paragraphs. Avoid wordy explanations to minimize API usage/quota.
3. Provide realistic setups with clear entry, target price, stop-loss, and risk-to-reward ratio.
4. When talking about a stock, use the provided context to justify your decisions, including win probabilities, risks, and scores.
5. If the user asks for trading advice without a specific stock, guide them using general trading concepts or swing trading principles.`;

  const contents = [...history];

  let messageWithContext = message;
  if (currentStockContext) {
    const quote = currentStockContext.quote || {};
    const scores = currentStockContext.scores || {};
    const tradeSetup = currentStockContext.tradeSetup || {};
    const composite = scores.composite || { total: 0, rating: 'N/A' };
    
    const checklist = scores.checklist || [];
    const passedChecks = checklist.filter(c => c.passed).length;
    const totalChecks = checklist.length || 12;
    const winChance = Math.round(35 + (passedChecks / totalChecks) * 50);

    messageWithContext = `[Context for currently selected stock: ${currentStockContext.name} (${currentStockContext.symbol})
- Price: ₹${(quote.price || 0).toFixed(2)} (Change: ${(quote.changePct || 0).toFixed(2)}%)
- Scores (out of 25 each): Fundamentals: ${scores.fundamental?.score || 0}, Technicals: ${scores.technicalSetup?.score || 0}, Momentum: ${scores.momentum?.score || 0}, Sentiment & Flows: ${scores.sentimentFlow?.score || 0} (Total: ${composite.total}/100)
- Trade Setup: Entry: ₹${(quote.price || 0).toFixed(2)}, Stop Loss: ₹${tradeSetup.stopLoss || 0}, Target 1: ₹${tradeSetup.target1 || 0}, Target 2: ₹${tradeSetup.target2 || 0}, Target 3: ₹${tradeSetup.target3 || 0}
- Win Probability: ${winChance}%, Risk/Reward: ${tradeSetup.riskReward || 0}:1]

User Query: ${message}`;
  }

  contents.push({
    role: 'user',
    parts: [{ text: messageWithContext }]
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: contents,
        system_instruction: {
          parts: [{ text: systemInstructionText }]
        },
        generationConfig: {
          maxOutputTokens: 250,
          temperature: 0.7
        }
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Gemini API error: ${res.status} - ${errorText}`);
    }

    const data = await res.json();
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
      return data.candidates[0].content.parts[0].text;
    } else {
      throw new Error('Invalid response structure from Gemini API');
    }
  } catch (error) {
    console.error('Invy Chat error:', error);
    throw error;
  }
}

// Export
window.API = {
  fetchQuote, fetchFundamentals, fetchHistorical, fetchEarnings,
  fetchSectorPerformance, fetchMarketIndices, fetchFearGreed,
  fetchNewsSentiment, fetchGeminiAnalysis, searchStocks, STOCK_CATALOG, SECTOR_MAP,
  checkBackend, fetchFullAnalysisFromBackend, fetchMarketPulseFromBackend, setBackendUrl,
  sendInvyChatMessage, fetchAuthConfig,
  getBackendUrl: () => BACKEND_URL
};
