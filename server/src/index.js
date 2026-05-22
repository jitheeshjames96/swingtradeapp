require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const NodeCache = require('node-cache');
const axios = require('axios');
const { Pool } = require('pg');
const scraper = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, '..', '..');

// Memory Cache with standard 5-minute TTL (Time To Live)
const appCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

app.use(cors());
app.use(express.json());

// Initialize PostgreSQL Pool
let dbPool = null;
if (process.env.DATABASE_URL) {
  try {
    dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('db:5432') ? false : {
        rejectUnauthorized: false
      }
    });
    console.log('PostgreSQL database pool initialized.');
  } catch (err) {
    console.error('Failed to initialize PostgreSQL pool:', err.message);
  }
} else {
  console.log('No DATABASE_URL configured. Falling back to console logging.');
}

// Logging helper
async function logToDatabase(email, action, symbol, details) {
  const timestamp = new Date().toISOString();
  console.log(`[LOG][${timestamp}] User: ${email || 'guest'} | Action: ${action} | Symbol: ${symbol || 'N/A'} | Details: ${details}`);
  
  if (dbPool) {
    try {
      // Create table if it doesn't exist
      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS logs (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255),
          action VARCHAR(50),
          symbol VARCHAR(20),
          details TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      await dbPool.query(
        'INSERT INTO logs (email, action, symbol, details) VALUES ($1, $2, $3, $4)',
        [email || 'guest', action, symbol || null, details || '']
      );
    } catch (err) {
      console.error('Database logging failed:', err.message);
    }
  }
}

// Token verification helper
async function verifyGoogleToken(idToken) {
  if (!idToken) return null;
  try {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    const response = await axios.get(url);
    return response.data;
  } catch (err) {
    console.error('Token verification failed:', err.message);
    return null;
  }
}

// Authentication Middleware
async function authMiddleware(req, res, next) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    // SSO not configured, bypass authentication
    req.user = { email: 'dev@local.com' };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
  }

  const idToken = authHeader.split(' ')[1];
  try {
    const payload = await verifyGoogleToken(idToken);
    if (!payload) {
      return res.status(401).json({ error: 'Unauthorized: Invalid ID token' });
    }

    // Verify audience (client ID)
    if (payload.aud !== clientId) {
      return res.status(401).json({ error: 'Unauthorized: Client ID mismatch' });
    }

    // Check if email is authorized
    const email = payload.email;
    const authorizedEmails = (process.env.AUTHORIZED_EMAIL || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    if (authorizedEmails.length > 0 && !authorizedEmails.includes(email.toLowerCase())) {
      return res.status(403).json({ error: `Forbidden: Email ${email} is not authorized` });
    }

    req.user = { email };
    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    res.status(500).json({ error: 'Internal Server Error in authentication' });
  }
}

// Logger middleware for HTTP requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Auth Configuration Endpoint
app.get('/api/auth/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
});

// Google SSO Login Verification Endpoint
app.post('/api/auth/login', authMiddleware, async (req, res) => {
  const email = req.user?.email || 'unknown';
  await logToDatabase(email, 'login', null, 'User signed in successfully via Google SSO');
  res.json({ status: 'success', email });
});

// Health checks
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

/**
 * Route: Analyze Stock
 * Combines quote, fundamentals, and historical charts with backend caching
 */
app.get('/api/analyze', authMiddleware, async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }

  const cleanSymbol = symbol.trim().toUpperCase();

  // Known broken/unavailable tickers — reject immediately with helpful message
  const BROKEN_TICKERS = new Set([
    'TATAMOTORS.NS', 'TATAMOTORS.BO', // Yahoo Finance dropped post-demerger
  ]);
  const TICKER_ALIASES = {
    'ZOMATO.NS': 'ETERNAL.NS', // Zomato rebranded to Eternal Limited
  };

  if (BROKEN_TICKERS.has(cleanSymbol)) {
    return res.status(404).json({
      error: `${cleanSymbol} is not available on Yahoo Finance due to a corporate restructuring/demerger. Please use an alternative ticker or check NSE India for the latest symbol.`,
      details: 'Ticker unavailable on Yahoo Finance'
    });
  }

  // Apply alias redirect
  const resolvedSymbol = TICKER_ALIASES[cleanSymbol] || cleanSymbol;
  if (resolvedSymbol !== cleanSymbol) {
    console.log(`Ticker alias: ${cleanSymbol} → ${resolvedSymbol}`);
  }

  // Log request to database
  const email = req.user?.email || 'unknown';
  await logToDatabase(email, 'analyze', resolvedSymbol, `Stock analysis requested (original: ${cleanSymbol})`);

  const cacheKey = `analyze_${resolvedSymbol}`;

  // Serve from cache if available
  const cachedData = appCache.get(cacheKey);
  if (cachedData) {
    console.log(`Serving cached analysis for ${resolvedSymbol}`);
    return res.json(cachedData);
  }

  try {
    // 1. Fetch Quote, Fundamentals, Historical Chart, News, and Fear/Greed in parallel!
    const isIndian = resolvedSymbol.endsWith('.NS') || resolvedSymbol.endsWith('.BO');
    
    const quotePromise = scraper.fetchQuote(resolvedSymbol);
    
    const fundamentalsPromise = isIndian
      ? Promise.all([
          scraper.fetchScreenerData(resolvedSymbol).catch(e => { console.warn(`Screener failed for ${resolvedSymbol}: ${e.message}`); return null; }),
          scraper.fetchYahooFundamentals(resolvedSymbol).catch(e => { console.warn(`Yahoo fundamentals failed for ${resolvedSymbol}: ${e.message}`); return null; })
        ]).then(([screener, yahooFund]) => ({ screener, yahooFund }))
      : scraper.fetchYahooFundamentals(resolvedSymbol)
          .catch(e => { console.warn(`Yahoo fundamentals failed for ${resolvedSymbol}: ${e.message}`); return null; })
          .then(yahoo => ({ screener: null, yahooFund: yahoo }));
          
    const historicalPromise = (async () => {
      try {
        const histUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${resolvedSymbol}?interval=1d&range=1y`;
        const response = await axios.get(histUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 4000
        });
        const chartResult = response.data.chart.result[0];
        const timestamps = chartResult.timestamp || [];
        const quotes = chartResult.indicators.quote[0] || {};
        return timestamps.map((t, i) => ({
          date: new Date(t * 1000).toISOString(),
          open: quotes.open?.[i] || 0,
          high: quotes.high?.[i] || 0,
          low: quotes.low?.[i] || 0,
          close: quotes.close?.[i] || 0,
          volume: quotes.volume?.[i] || 0,
        })).filter(d => d.close > 0);
      } catch (e) {
        console.warn(`Historical data fetch failed for ${resolvedSymbol}, returning empty array: ${e.message}`);
        return [];
      }
    })();

    const newsPromise = (async () => {
      try {
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(resolvedSymbol)}&newsCount=8`;
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
        const data = response.data;
        const news = [];
        if (data && data.news) {
          data.news.slice(0, 6).forEach(n => {
            const t = (n.title || '').toLowerCase();
            const bullish = ['surge', 'rally', 'gain', 'beat', 'strong', 'growth', 'profit', 'record', 'upgrade', 'buy', 'bull', 'rise', 'up', 'positive', 'boost', 'outperform', 'expand', 'win', 'exceed', 'high'];
            const bearish = ['fall', 'drop', 'loss', 'miss', 'weak', 'decline', 'down', 'sell', 'bear', 'cut', 'downgrade', 'concern', 'risk', 'crash', 'plunge', 'slump', 'fail', 'negative', 'below', 'low'];
            let sentimentScore = 0;
            bullish.forEach(w => { if (t.includes(w)) sentimentScore++; });
            bearish.forEach(w => { if (t.includes(w)) sentimentScore--; });

            let sentiment = 'neutral';
            if (sentimentScore > 0) sentiment = 'positive';
            else if (sentimentScore < 0) sentiment = 'negative';

            let formattedTime = 'Recent';
            if (n.providerPublishTime) {
              const pubDate = new Date(n.providerPublishTime * 1000);
              const day = pubDate.getDate();
              const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
              const month = months[pubDate.getMonth()];
              const year = pubDate.getFullYear();
              formattedTime = `${day} ${month} ${year}`;
            }

            news.push({
              headline: n.title,
              source: n.publisher,
              time: formattedTime,
              sentiment,
              url: n.link,
            });
          });
        }
        return news;
      } catch (error) {
        console.warn(`News fetch failed in analyze for ${resolvedSymbol}:`, error.message);
        return [];
      }
    })();

    const fearGreedPromise = (async () => {
      try {
        const response = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 4000 });
        if (response.data?.data?.[0]) {
          const item = response.data.data[0];
          return {
            value: parseInt(item.value),
            text: item.value_classification
          };
        }
      } catch (e) {
        console.warn('Fear & Greed fetch failed in analyze:', e.message);
      }
      return { value: 50, text: 'Neutral' };
    })();

    // Await all concurrently
    const [quote, fundResult, historical, news, fearGreed] = await Promise.all([
      quotePromise,
      fundamentalsPromise,
      historicalPromise,
      newsPromise,
      fearGreedPromise
    ]);

    let fundamentals = {};
    let earnings = { quarterly: [], annual: [] };
    let shareholding = null;

    if (isIndian) {
      const { screener, yahooFund } = fundResult || { screener: null, yahooFund: null };
      if (screener) {
        fundamentals = {
          ...yahooFund,
          ...screener.fundamentals
        };
        // Dynamically calculate P/B ratio from quote price and scraped book value
        if (screener.fundamentals.bookValue && quote.price) {
          fundamentals.pb = parseFloat((quote.price / screener.fundamentals.bookValue).toFixed(2));
        } else if (!fundamentals.pb && yahooFund?.pb) {
          fundamentals.pb = yahooFund.pb;
        }
        earnings = { ...screener.earnings };
        shareholding = screener.shareholding || yahooFund?.shareholding || null;
      } else if (yahooFund) {
        fundamentals = yahooFund;
        shareholding = yahooFund.shareholding || null;
      }
    } else {
      fundamentals = fundResult?.yahooFund || {};
      shareholding = fundamentals.shareholding || null;
    }

    const payload = {
      symbol: resolvedSymbol,
      originalSymbol: cleanSymbol !== resolvedSymbol ? cleanSymbol : undefined,
      quote,
      fundamentals,
      earnings,
      shareholding,
      historical,
      news,
      fearGreed,
      cachedAt: new Date().toISOString(),
      isRealData: true
    };

    // Cache the result
    appCache.set(cacheKey, payload);
    res.json(payload);

  } catch (error) {
    console.error(`Analysis failed for ${resolvedSymbol}:`, error.message);
    res.status(500).json({ error: 'Failed to analyze stock', details: error.message });
  }
});

/**
 * STOCK_CATALOG & SECTOR_MAP for backend market summary
 */
const STOCK_CATALOG = [
  // ── Banking & Finance ──
  { symbol: 'HDFCBANK.NS',   name: 'HDFC Bank',                 sector: 'Banking' },
  { symbol: 'ICICIBANK.NS',  name: 'ICICI Bank',                sector: 'Banking' },
  { symbol: 'SBIN.NS',       name: 'State Bank of India',       sector: 'Banking' },
  { symbol: 'KOTAKBANK.NS',  name: 'Kotak Mahindra Bank',       sector: 'Banking' },
  { symbol: 'AXISBANK.NS',   name: 'Axis Bank',                 sector: 'Banking' },
  { symbol: 'INDUSINDBK.NS', name: 'IndusInd Bank',             sector: 'Banking' },
  { symbol: 'BANKBARODA.NS', name: 'Bank of Baroda',            sector: 'Banking' },
  { symbol: 'PNB.NS',        name: 'Punjab National Bank',      sector: 'Banking' },
  { symbol: 'CANBK.NS',      name: 'Canara Bank',               sector: 'Banking' },
  { symbol: 'BAJFINANCE.NS', name: 'Bajaj Finance',             sector: 'NBFC' },
  { symbol: 'BAJAJFINSV.NS', name: 'Bajaj Finserv',             sector: 'NBFC' },
  // ── IT & Technology ──
  { symbol: 'TCS.NS',        name: 'Tata Consultancy Services', sector: 'IT' },
  { symbol: 'INFY.NS',       name: 'Infosys Ltd',               sector: 'IT' },
  { symbol: 'WIPRO.NS',      name: 'Wipro Ltd',                 sector: 'IT' },
  { symbol: 'HCLTECH.NS',    name: 'HCL Technologies',          sector: 'IT' },
  { symbol: 'TECHM.NS',      name: 'Tech Mahindra',             sector: 'IT' },
  { symbol: 'LTIM.NS',       name: 'LTIMindtree',               sector: 'IT' },
  { symbol: 'MPHASIS.NS',    name: 'Mphasis Ltd',               sector: 'IT' },
  // ── Pharma & Healthcare ──
  { symbol: 'SUNPHARMA.NS',  name: 'Sun Pharmaceutical',        sector: 'Pharma' },
  { symbol: 'DRREDDY.NS',    name: "Dr. Reddy's Laboratories",  sector: 'Pharma' },
  { symbol: 'CIPLA.NS',      name: 'Cipla Ltd',                 sector: 'Pharma' },
  { symbol: 'DIVISLAB.NS',   name: "Divi's Laboratories",       sector: 'Pharma' },
  { symbol: 'APOLLOHOSP.NS', name: 'Apollo Hospitals',          sector: 'Healthcare' },
  { symbol: 'ZYDUSLIFE.NS',  name: 'Zydus Lifesciences',        sector: 'Pharma' },
  { symbol: 'BIOCON.NS',     name: 'Biocon Ltd',                sector: 'Pharma' },
  // ── FMCG & Consumer ──
  { symbol: 'HINDUNILVR.NS', name: 'Hindustan Unilever',        sector: 'FMCG' },
  { symbol: 'NESTLEIND.NS',  name: 'Nestle India',              sector: 'FMCG' },
  { symbol: 'BRITANNIA.NS',  name: 'Britannia Industries',      sector: 'FMCG' },
  { symbol: 'TITAN.NS',      name: 'Titan Company',             sector: 'Consumer' },
  { symbol: 'TRENT.NS',      name: 'Trent Ltd',                 sector: 'Consumer' },
  { symbol: 'ETERNAL.NS',    name: 'Eternal Limited (Zomato)',  sector: 'Consumer Tech' },
  { symbol: 'IRCTC.NS',      name: 'IRCTC',                     sector: 'Consumer' },
  // ── Auto ──
  { symbol: 'MARUTI.NS',     name: 'Maruti Suzuki',             sector: 'Auto' },
  { symbol: 'EICHERMOT.NS',  name: 'Eicher Motors',             sector: 'Auto' },
  { symbol: 'HEROMOTOCO.NS', name: 'Hero MotoCorp',             sector: 'Auto' },
  { symbol: 'MAHINDM.NS',    name: 'Mahindra & Mahindra',       sector: 'Auto' },
  // ── Metals & Materials ──
  { symbol: 'TATASTEEL.NS',  name: 'Tata Steel',                sector: 'Metals' },
  { symbol: 'JSWSTEEL.NS',   name: 'JSW Steel',                 sector: 'Metals' },
  { symbol: 'HINDALCO.NS',   name: 'Hindalco Industries',       sector: 'Metals' },
  { symbol: 'VEDL.NS',       name: 'Vedanta Ltd',               sector: 'Metals' },
  { symbol: 'SAIL.NS',       name: 'Steel Authority of India',  sector: 'Metals' },
  { symbol: 'ULTRACEMCO.NS', name: 'UltraTech Cement',          sector: 'Cement' },
  { symbol: 'GRASIM.NS',     name: 'Grasim Industries',         sector: 'Cement' },
  { symbol: 'ASIANPAINT.NS', name: 'Asian Paints',              sector: 'Materials' },
  { symbol: 'PIDILITIND.NS', name: 'Pidilite Industries',       sector: 'Materials' },
  // ── Energy ──
  { symbol: 'RELIANCE.NS',   name: 'Reliance Industries',       sector: 'Energy' },
  { symbol: 'ONGC.NS',       name: 'Oil & Natural Gas Corp',    sector: 'Energy' },
  { symbol: 'COALINDIA.NS',  name: 'Coal India',                sector: 'Energy' },
  { symbol: 'BPCL.NS',       name: 'Bharat Petroleum',          sector: 'Energy' },
  { symbol: 'SUZLON.NS',     name: 'Suzlon Energy',             sector: 'Renewables' },
  // ── Engineering & Industrials ──
  { symbol: 'LT.NS',         name: 'Larsen & Toubro',           sector: 'Engineering' },
  { symbol: 'SIEMENS.NS',    name: 'Siemens India',             sector: 'Engineering' },
  { symbol: 'ABB.NS',        name: 'ABB India',                 sector: 'Engineering' },
  { symbol: 'ADANIENT.NS',   name: 'Adani Enterprises',         sector: 'Conglomerate' },
  { symbol: 'ADANIPORTS.NS', name: 'Adani Ports',               sector: 'Industrials' },
  { symbol: 'HAVELLS.NS',    name: 'Havells India',             sector: 'Industrials' },
  { symbol: 'VOLTAS.NS',     name: 'Voltas Ltd',                sector: 'Industrials' },
  // ── Utilities ──
  { symbol: 'POWERGRID.NS',  name: 'Power Grid Corp',           sector: 'Utilities' },
  { symbol: 'NTPC.NS',       name: 'NTPC Ltd',                  sector: 'Utilities' },
  { symbol: 'TATAPOWER.NS',  name: 'Tata Power',                sector: 'Utilities' },
  // ── Telecom ──
  { symbol: 'BHARTIARTL.NS', name: 'Bharti Airtel',             sector: 'Telecom' },
  // ── Real Estate ──
  { symbol: 'DLF.NS',        name: 'DLF Limited',               sector: 'Real Estate' },
  { symbol: 'OBEROIRLTY.NS', name: 'Oberoi Realty',             sector: 'Real Estate' },
];


const SECTOR_MAP = [
  { name: 'Technology', symbol: 'TCS.NS',         icon: '💻' },
  { name: 'Financials', symbol: '^NSEBANK',        icon: '🏦' },
  { name: 'Healthcare', symbol: 'SUNPHARMA.NS',    icon: '🏥' },
  { name: 'Energy',     symbol: 'RELIANCE.NS',     icon: '⚡' },
  { name: 'Industrials',symbol: 'LT.NS',           icon: '🏭' },
  { name: 'Materials',  symbol: 'TATASTEEL.NS',    icon: '🪨' },
  { name: 'Real Estate',symbol: 'DLF.NS',          icon: '🏢' },
  { name: 'Utilities',  symbol: 'POWERGRID.NS',    icon: '💡' },
  { name: 'Telecom',    symbol: 'BHARTIARTL.NS',   icon: '📡' },
  { name: 'Renewables', symbol: 'SUZLON.NS',       icon: '🌱' },
];

function getEtfSectorName(stockSector) {
  const s = (stockSector || '').toLowerCase();
  if (s === 'it' || s.includes('tech') || s.includes('semiconductor') || s.includes('social') || s.includes('streaming') || s.includes('e-commerce') || s.includes('consumer tech')) {
    return 'Technology';
  }
  if (s.includes('bank') || s.includes('nbfc') || s.includes('financial')) {
    return 'Financials';
  }
  if (s.includes('pharma') || s.includes('health')) {
    return 'Healthcare';
  }
  if (s.includes('renewable') || s.includes('wind') || s.includes('solar') || s.includes('green energy')) {
    return 'Renewables';
  }
  if (s.includes('energy')) {
    return 'Energy';
  }
  if (s.includes('telecom') || s.includes('telco') || s.includes('telecom')) {
    return 'Telecom';
  }
  if (s.includes('auto') || s.includes('engineer') || s.includes('conglomerate') || s.includes('industrial')) {
    return 'Industrials';
  }
  if (s.includes('metal') || s.includes('cement') || s.includes('material') || s.includes('fmcg') || s.includes('consumer')) {
    return 'Materials';
  }
  if (s.includes('utility') || s.includes('utilities')) {
    return 'Utilities';
  }
  if (s.includes('real estate')) {
    return 'Real Estate';
  }
  return '';
}

/**
 * Route: Market Summary (Sector leaders, Gainers/Losers from all catalog stocks)
 */
app.get('/api/market-summary', authMiddleware, async (req, res) => {
  const cacheKey = 'market_summary';
  const cachedData = appCache.get(cacheKey);
  if (cachedData) {
    return res.json(cachedData);
  }

  try {
    const symbols = STOCK_CATALOG.map(s => s.symbol);
    const quotes = await scraper.fetchQuotes(symbols);

    // Map quotes back to catalog items with names and sectors
    const enrichedQuotes = quotes.map(q => {
      const catItem = STOCK_CATALOG.find(s => s.symbol === q.symbol);
      return {
        ...q,
        name: catItem ? catItem.name : q.longName || q.symbol,
        sector: catItem ? catItem.sector : ''
      };
    });

    // 1. Calculate Top 5 Gainers
    const gainers = [...enrichedQuotes]
      .filter(q => typeof q.changePct === 'number')
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 5)
      .map(q => ({
        symbol: q.symbol,
        name: q.name,
        quote: { price: q.price, change: q.change, changePct: q.changePct }
      }));

    // 2. Calculate Top 5 Losers
    const losers = [...enrichedQuotes]
      .filter(q => typeof q.changePct === 'number')
      .sort((a, b) => a.changePct - b.changePct)
      .slice(0, 5)
      .map(q => ({
        symbol: q.symbol,
        name: q.name,
        quote: { price: q.price, change: q.change, changePct: q.changePct }
      }));

    // 3. Group by Sector and compute top 5 Gainers & Losers per sector
    const sectors = [];
    for (const etf of SECTOR_MAP) {
      const sectorStocks = enrichedQuotes.filter(q => getEtfSectorName(q.sector) === etf.name);
      
      let sectorGainers = [];
      let sectorLosers = [];

      if (sectorStocks.length > 0) {
        const sortedDesc = [...sectorStocks].sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
        sectorGainers = sortedDesc.slice(0, 5).map(q => ({
          symbol: q.symbol,
          name: q.name,
          quote: { price: q.price, change: q.change, changePct: q.changePct }
        }));

        const sortedAsc = [...sectorStocks].sort((a, b) => (a.changePct || 0) - (b.changePct || 0));
        sectorLosers = sortedAsc.slice(0, 5).map(q => ({
          symbol: q.symbol,
          name: q.name,
          quote: { price: q.price, change: q.change, changePct: q.changePct }
        }));
      }

      // Fetch ETF price for this sector to get overall sector index change
      let etfChange = 0;
      let etfPrice = 0;
      try {
        const etfQuote = await scraper.fetchQuote(etf.symbol);
        if (etfQuote) {
          etfChange = etfQuote.changePct || 0;
          etfPrice = etfQuote.price || 0;
        }
      } catch (err) {
        console.warn(`Failed to fetch sector ETF ${etf.symbol}: ${err.message}`);
      }

      sectors.push({
        name: etf.name,
        symbol: etf.symbol,
        icon: etf.icon,
        change: etfChange,
        price: etfPrice,
        gainers: sectorGainers,
        losers: sectorLosers
      });
    }

    const payload = {
      gainers,
      losers,
      sectors,
      timestamp: new Date().toISOString()
    };

    // Cache for 120 seconds (2 minutes)
    appCache.set(cacheKey, payload, 120);
    res.json(payload);

  } catch (error) {
    console.error('Failed to generate market summary:', error.message);
    res.status(500).json({ error: 'Failed to retrieve market summary', details: error.message });
  }
});

/**
 * Route: Market indices & Fear/Greed Index
 */
app.get('/api/market-pulse', authMiddleware, async (req, res) => {
  // Log request to database
  const email = req.user?.email || 'unknown';
  await logToDatabase(email, 'market-pulse', null, 'Market pulse requested');

  const cacheKey = 'market_pulse';
  const cachedData = appCache.get(cacheKey);
  if (cachedData) {
    return res.json(cachedData);
  }

  try {
    // Fetch indices (Nifty, Sensex, BankNifty) from Yahoo chart endpoints
    const indicesSymbols = ['^NSEI', '^BSESN', '^NSEBANK'];
    const indicesPromises = indicesSymbols.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const meta = res.data.chart.result[0].meta;
        const price = meta.regularMarketPrice || 0;
        const prev = meta.chartPreviousClose || meta.previousClose || price;
        const change = price - prev;
        const changePct = prev ? (change / prev * 100) : 0;
        const nameMap = { '^NSEI': 'NIFTY 50', '^BSESN': 'SENSEX', '^NSEBANK': 'BANK NIFTY' };
        return {
          symbol: sym,
          name: nameMap[sym] || sym,
          price,
          change: changePct,
          rawChange: change
        };
      } catch (e) {
        return { symbol: sym, name: sym, price: 0, change: 0, rawChange: 0, error: true };
      }
    });

    const indices = await Promise.all(indicesPromises);

    // Fetch Fear & Greed
    let fearGreed = { value: 50, text: 'Neutral' };
    try {
      const response = await axios.get('https://api.alternative.me/fng/?limit=1');
      if (response.data?.data?.[0]) {
        const item = response.data.data[0];
        fearGreed = {
          value: parseInt(item.value),
          text: item.value_classification
        };
      }
    } catch (e) {
      console.warn('Fear & Greed fetch failed:', e.message);
    }

    const payload = { indices, fearGreed, timestamp: new Date().toISOString() };
    appCache.set(cacheKey, payload, 300); // 5 minute TTL
    res.json(payload);

  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve market pulse', details: error.message });
  }
});


// Route: Fetch Yahoo Finance news and analyze sentiment
app.get('/api/news', authMiddleware, async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }

  const cacheKey = `news_${symbol.toUpperCase()}`;
  const cachedData = appCache.get(cacheKey);
  if (cachedData) {
    return res.json(cachedData);
  }

  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=8`;
    const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = response.data;
    const news = [];

    if (data && data.news) {
      data.news.slice(0, 6).forEach(n => {
        // Sentiment detection based on title keywords
        const t = (n.title || '').toLowerCase();
        const bullish = ['surge', 'rally', 'gain', 'beat', 'strong', 'growth', 'profit', 'record', 'upgrade', 'buy', 'bull', 'rise', 'up', 'positive', 'boost', 'outperform', 'expand', 'win', 'exceed', 'high'];
        const bearish = ['fall', 'drop', 'loss', 'miss', 'weak', 'decline', 'down', 'sell', 'bear', 'cut', 'downgrade', 'concern', 'risk', 'crash', 'plunge', 'slump', 'fail', 'negative', 'below', 'low'];
        let sentimentScore = 0;
        bullish.forEach(w => { if (t.includes(w)) sentimentScore++; });
        bearish.forEach(w => { if (t.includes(w)) sentimentScore--; });

        let sentiment = 'neutral';
        if (sentimentScore > 0) sentiment = 'positive';
        else if (sentimentScore < 0) sentiment = 'negative';

        // Precise date formatting
        let formattedTime = 'Recent';
        if (n.providerPublishTime) {
          const pubDate = new Date(n.providerPublishTime * 1000);
          const day = pubDate.getDate();
          const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const month = months[pubDate.getMonth()];
          const year = pubDate.getFullYear();
          formattedTime = `${day} ${month} ${year}`;
        }

        news.push({
          headline: n.title,
          source: n.publisher,
          time: formattedTime,
          sentiment,
          url: n.link,
        });
      });
    }

    // Cache the news for 10 minutes
    appCache.set(cacheKey, news, 600);
    res.json(news);
  } catch (error) {
    console.warn(`Server news fetch failed for ${symbol}:`, error.message);
    res.status(500).json({ error: 'Failed to retrieve news', details: error.message });
  }
});

// Helper function to generate a rich markdown fallback report when Gemini key is missing
function generateDetailedFallbackReport(currentStockContext, userMessage) {
  const msg = (userMessage || '').toLowerCase();
  
  // ── Greeting / intro
  if (!currentStockContext?.symbol && (!msg || msg.match(/^(hi|hello|hey|greet|start|help|what can you do)/))) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Terminal status: Online and ready.
- Capabilities: Stock analysis, swing trade setup generation, indicator explanation, strategy design.

[ANALYSIS LOG]
- To analyze a stock, select it from the watchlist or ask about it.
- To learn concepts, ask about indicators (RSI, MACD, Moving Averages, Bollinger Bands).
- Input stock ticker or search query to proceed.`;
  }
  
  // ── RSI questions
  if (msg.includes('rsi')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Indicator: Relative Strength Index (RSI)
- Primary Use: Momentum & Overbought/Oversold tracking

[ANALYSIS LOG]
- Scale: 0 to 100.
- RSI < 30: Oversold zone (potential long reversal).
- RSI 45-65: Bullish momentum acceleration zone.
- RSI > 70: Overbought zone (high pullback risk).
- Recommendation: Confirm RSI reversals with MACD crossovers before entering.`;
  }
  
  // ── MACD questions
  if (msg.includes('macd')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Indicator: Moving Average Convergence Divergence (MACD)
- Primary Use: Trend direction & Momentum crossovers

[ANALYSIS LOG]
- Components: MACD line, Signal line, Histogram.
- Bullish Trigger: MACD crosses above Signal line (preferably below zero).
- Bearish Trigger: MACD crosses below Signal line.
- Histogram expansion: Momentum strength is increasing.
- Histogram contraction: Momentum is fading.`;
  }
  
  // ── Moving average questions
  if (msg.includes('moving average') || msg.includes('sma') || msg.includes('ema') || msg.includes('200 day') || msg.includes('50 day')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Indicator: SMA (Simple Moving Average) / EMA (Exponential Moving Average)
- Primary Use: Trend filter and dynamic support/resistance

[ANALYSIS LOG]
- 20 EMA: Short-term momentum guide. Great for pullback entries in a strong trend.
- 50 SMA: Medium-term trend benchmark. Price above is structurally bullish.
- 200 SMA: Long-term trend boundary. Golden Cross = 50 SMA crossing above 200 SMA.
- Rule: Only execute long swing trades when price lies above both 50 SMA and 200 SMA.`;
  }
  
  // ── Bollinger Bands questions  
  if (msg.includes('bollinger') || msg.includes('bb') || (msg.includes('band') && !msg.includes('band aid'))) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Indicator: Bollinger Bands (BB)
- Primary Use: Volatility expansion & mean reversion

[ANALYSIS LOG]
- Middle Band: 20-period simple moving average.
- Outer Bands: Middle band +/- 2 standard deviations.
- Volatility Squeeze: Bands contract tightly before a major explosive breakout.
- Mean Reversion: Price tends to bounce off lower band and find resistance at upper band.`;
  }
  
  // ── Entry questions
  if (msg.includes('entry') || msg.includes('when to buy') || msg.includes('buy signal')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Target Setup: Swing Long Entry
- Requirement: 3+ confluent triggers

[ANALYSIS LOG]
- Check 1: Price is positioned above 50 and 200 SMAs.
- Check 2: RSI is situated between 40-60 (momentum sweet spot).
- Check 3: MACD exhibits bullish crossover or green expanding histogram.
- Check 4: Volume is expanding on breakout/reversal candles.
- Risk Rule: Restrict max risk per trade to 1-2% of overall trading capital.`;
  }
  
  // ── Stop loss questions
  if (msg.includes('stop loss') || msg.includes('stoploss') || (msg.includes('sl') && msg.length < 20) || msg.includes('risk management')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Focus: Defensive Risk Management & Position Sizing
- Core Target: Prevent ruin and preserve capital

[ANALYSIS LOG]
- ATR Stop: Place stop loss at 1.5x ATR below entry price.
- Structural Stop: Place stop loss below the nearest swing low or support level.
- Percentage Rule: Stop loss should not exceed 5-7% of position value.
- Golden Rule: Define stop loss *prior* to execution. Never adjust it wider during a trade.`;
  }
  
  // ── Fundamental questions  
  if (msg.includes('fundamental') || msg.includes('pe ratio') || msg.includes('p/e') || msg.includes('roe') || msg.includes('debt')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Subject: Fundamental Scoring Metrics
- Target: Evaluate financial stability and growth

[ANALYSIS LOG]
- P/E Ratio: Cheap (< 20), Fair (20-35), Expensive (> 50).
- Return on Equity (ROE): Target > 15% (underlying capital efficiency).
- Debt/Equity Ratio: Target < 1.0 (excluding banking/finance sectors).
- Growth: Consistent > 10% YoY revenue and profit growth.
- Scoring weight: Max 25 points per pillar in composite model.`;
  }
  
  // ── Score / rating questions
  if (msg.includes('score') || msg.includes('rating') || msg.includes('how is') || msg.includes('analysis')) {
    if (!currentStockContext?.symbol) {
      return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Subject: Scoring Architecture (0-100 scale)
- Rating scale: 🟢 Strong Buy (≥80) | 🟡 Buy (65-79) | 🟠 Hold/Watch (50-64) | 🔴 Avoid (<50)

[ANALYSIS LOG]
- Fundamentals: Weighted 25% (P/E, growth, debt, margins).
- Technical Setup: Weighted 25% (moving averages, support levels).
- Momentum: Weighted 25% (RSI, MACD crossover, volume).
- Sentiment & Flows: Weighted 25% (news sentiment, Fear & Greed).`;
    }
  }
  
  // ── General trading / strategy questions
  if (msg.includes('swing trade') || msg.includes('strategy') || msg.includes('how to') || msg.includes('explain')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Strategy: Swing Trading
- Hold Timeframe: 2 to 14 sessions

[ANALYSIS LOG]
- Screen: Find liquid stocks with solid fundamentals in primary uptrends.
- Timing: Wait for pullbacks to support levels or moving averages (RSI dip).
- Execution: Buy on bullish candle confirmations with expanding volume.
- Exit: Set fixed targets at 1.5x to 3.0x risk parameters.
- Context: Optimal results occur when Fear & Greed lies in the 30-60 zone.`;
  }
  
  // ── Stock-specific report
  if (currentStockContext?.symbol) {
    const symbol = currentStockContext.symbol;
    const name = currentStockContext.name || symbol;
    const quote = currentStockContext.quote || {};
    const scores = currentStockContext.scores || {};
    const tradeSetup = currentStockContext.tradeSetup || {};
    const composite = scores.composite || { total: 0, rating: 'N/A', emoji: '⚪' };
    const checklist = scores.checklist || [];
    const passedChecks = checklist.filter(c => c.passed).length;
    const totalChecks = checklist.length || 12;
    const winChance = Math.round(35 + (passedChecks / totalChecks) * 50);
    const peVal = scores.fundamental?.checklist?.[0]?.value || 'N/A';
    const growthVal = scores.fundamental?.checklist?.[1]?.value || 'N/A';
    const debtVal = scores.fundamental?.checklist?.[2]?.value || 'N/A';
    const trendVal = scores.technicalSetup?.checklist?.[0]?.value || 'N/A';
    const rsiVal = scores.momentum?.checklist?.[0]?.value || 'N/A';
    const macdVal = scores.momentum?.checklist?.[1]?.value || 'N/A';
    const flowVal = scores.sentimentFlow?.checklist?.[0]?.value || 'N/A';
    const fgVal = scores.sentimentFlow?.checklist?.[1]?.value || 'N/A';
    const formatPrice = (p) => typeof p === 'number' ? '₹' + p.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : 'N/A';

    const s1 = tradeSetup.indicators?.sr?.s1 || null;
    const r1 = tradeSetup.indicators?.sr?.r1 || null;
    const price = quote.price || 0;

    let entryZone = '';
    let ratingJustification = '';

    if (composite.total >= 80) {
      const entryMin = s1 ? Math.min(price, s1) : price * 0.98;
      const entryMax = price * 1.01;
      entryZone = `₹${entryMin.toFixed(2)} - ₹${entryMax.toFixed(2)} (Accumulate on minor pullbacks to support S1 at ₹${s1 || 'support'} or 20 EMA, or on breakout above R1 at ₹${r1 || 'resistance'})`;
      ratingJustification = `Strong buy rating is justified by a robust combination of exceptional fundamentals, clear technical breakout above key moving averages, and high institutional volume accumulation.`;
    } else if (composite.total >= 65) {
      const entryMin = s1 ? s1 : price * 0.97;
      entryZone = `₹${entryMin.toFixed(2)} - ₹${price.toFixed(2)} (Optimal entry on minor pullbacks towards support S1 at ₹${s1 || 'support'} or the 50 SMA)`;
      ratingJustification = `Buy rating is supported by a healthy primary uptrend and solid core financials, though wait for key levels or minor cooling of indicators for optimal risk-to-reward.`;
    } else if (composite.total >= 50) {
      entryZone = `Wait for breakout above ₹${r1 ? r1.toFixed(2) : 'R1'} or pullback to ₹${s1 ? s1.toFixed(2) : 'S1'}`;
      ratingJustification = `Watch rating is due to range-bound price action and consolidation. Momentum indicators (RSI/MACD) are flat. Conserve capital until a clear direction is established.`;
    } else {
      entryZone = `N/A (Not suitable for long swing trades)`;
      ratingJustification = `Avoid rating due to weak fundamentals (high debt/declining margins), severe technical markdown structure, or heavy smart-money distribution.`;
    }

    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Verdict: ${composite.rating || 'N/A'}
- Score: ${composite.total || 0}/100
- Entry Trigger: ${entryZone}
- Stop Loss: ${formatPrice(tradeSetup.stopLoss)}
- Targets: T1: ${formatPrice(tradeSetup.target1)} | T2: ${formatPrice(tradeSetup.target2)} | T3: ${formatPrice(tradeSetup.target3)}

[ANALYSIS LOG]
- Active symbol is ${name} (${symbol}) at price ${formatPrice(quote.price)} (${(quote.changePct || 0) >= 0 ? '+' : ''}${(quote.changePct || 0).toFixed(2)}%).
- Pillar scores: Fundamentals: ${scores.fundamental?.score || 0}/25 (P/E: ${peVal}, Growth: ${growthVal}), Technicals: ${scores.technicalSetup?.score || 0}/25 (Trend: ${trendVal}), Momentum: ${scores.momentum?.score || 0}/25 (RSI: ${rsiVal}, MACD: ${macdVal}), Sentiment: ${scores.sentimentFlow?.score || 0}/25 (Flows: ${flowVal}).
- Win Probability: ${winChance}%, Risk/Reward: 1:${tradeSetup.riskReward || 0}.
- Rationale: ${ratingJustification}`;
  }

  // ── Default catch-all
  return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Focus: Help terminal and instructions
- Available topics: Technical analysis, trade entries, risk parameters, fundamental scoring.

[ANALYSIS LOG]
- Ask for 'RSI', 'MACD', 'SMA/EMA', 'Bollinger Bands' to get dynamic indicator details.
- Ask for 'entry checklist' or 'stop loss' to review risk settings.
- Select a stock or input a stock symbol to inspect its real-time scoring and setup logs.`;
}

// Route: Invy AI Chat Backend Proxy
app.post('/api/chat', authMiddleware, async (req, res) => {
  const { history, message, currentStockContext } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const email = req.user?.email || 'unknown';
  const symbol = currentStockContext?.symbol || null;

  // Log the chat to database
  await logToDatabase(email, 'chat', symbol, `User message: ${message.slice(0, 100)}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const fallbackResponse = generateDetailedFallbackReport(currentStockContext, message);
    return res.json({ response: fallbackResponse });
  }


  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const systemInstructionText = `You are "Invy AI", a highly advanced robotic swing trading intelligence agent.
Your goal is to guide users to pick stocks at the perfect price using a combination of fundamentals, technical setup, momentum, sentiment & flows, and disciplined risk management.
You communicate using structured logs and direct technical commands.
Your responses MUST be formatted in markdown with distinct agent logs.
Each response MUST contain the following sections:

[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Verdict: [Strong Buy / Buy / Hold / Avoid]
- Score: [Composite Score]/100
- Entry Trigger: [Price level or setup condition]
- Stop Loss: [Price level]
- Targets: T1: [Price] | T2: [Price] | T3: [Price]

[ANALYSIS LOG]
- [Brief 1-2 sentence technical summary]
- [Brief 1-2 sentence fundamental summary]
- Win Probability: [Calculated probability]%

Rules:
1. Be professional, highly concise, and direct. Keep responses under 150 words. Do NOT include polite pleasantries.
2. Use bullet points or short paragraphs. Avoid wordy explanations to minimize API usage/quota.
3. If there is no stock context or the query is general, output under [AGENT STATUS: COMPLETED] and [ANALYSIS LOG] explaining the general concepts in a robotic, structured, bulleted format.`;

    const contents = [...(history || [])];

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

    const response = await axios.post(url, {
      contents: contents,
      system_instruction: {
        parts: [{ text: systemInstructionText }]
      },
      generationConfig: {
        maxOutputTokens: 250,
        temperature: 0.7
      }
    });

    if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      const text = response.data.candidates[0].content.parts[0].text;
      res.json({ response: text });
    } else {
      throw new Error('Invalid response structure from Gemini API');
    }
  } catch (err) {
    console.error('Backend Chat error:', err.message);
    res.status(500).json({ error: 'Failed to generate response from Gemini API', details: err.message });
  }
});

// Serve frontend static files (CSS, JS, assets)
app.use(express.static(FRONTEND_DIR, {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

// SPA catch-all: serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 Swing Trading Backend listening on port ${PORT}`);
  console.log(`📂 Frontend served from: ${FRONTEND_DIR}`);
  console.log(`🖥️  Open: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
