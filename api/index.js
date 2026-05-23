const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const axios = require('axios');
const { Pool } = require('pg');
const scraper = require('../server/src/scraper');

const app = express();
const appCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

app.use(cors());
app.use(express.json());

// Initialize PostgreSQL Pool
let dbPool = null;
if (process.env.DATABASE_URL) {
  try {
    dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
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
  if (idToken === 'DEMO_BYPASS') {
    req.user = { email: 'demo@guest.com' };
    return next();
  }

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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Route: Analyze Stock
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
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(resolvedSymbol)}&newsCount=20`;
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
        const data = response.data;
        const news = [];
        if (data && data.news) {
          const cleanedSym = resolvedSymbol.split('.')[0].toUpperCase();
          const filteredNews = data.news.filter(n => {
            const relatedTickers = Array.isArray(n.relatedTickers) ? n.relatedTickers.map(t => t.toUpperCase()) : [];
            const titleUpper = (n.title || '').toUpperCase();
            return (
              relatedTickers.includes(cleanedSym) ||
              relatedTickers.includes(resolvedSymbol) ||
              titleUpper.includes(cleanedSym)
            );
          });

          filteredNews.slice(0, 6).forEach(n => {
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
              date: n.providerPublishTime,
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
  // ── Large Cap ──
  { symbol: 'RELIANCE.NS',   name: 'Reliance Industries',       sector: 'Energy', cap: 'large' },
  { symbol: 'TCS.NS',        name: 'Tata Consultancy Services', sector: 'IT', cap: 'large' },
  { symbol: 'INFY.NS',       name: 'Infosys Ltd',               sector: 'IT', cap: 'large' },
  { symbol: 'HDFCBANK.NS',   name: 'HDFC Bank',                 sector: 'Banking', cap: 'large' },
  { symbol: 'ICICIBANK.NS',  name: 'ICICI Bank',                sector: 'Banking', cap: 'large' },
  { symbol: 'SBIN.NS',       name: 'State Bank of India',       sector: 'Banking', cap: 'large' },
  { symbol: 'KOTAKBANK.NS',  name: 'Kotak Mahindra Bank',       sector: 'Banking', cap: 'large' },
  { symbol: 'AXISBANK.NS',   name: 'Axis Bank',                 sector: 'Banking', cap: 'large' },
  { symbol: 'BAJFINANCE.NS', name: 'Bajaj Finance',             sector: 'NBFC', cap: 'large' },
  { symbol: 'WIPRO.NS',      name: 'Wipro Ltd',                 sector: 'IT', cap: 'large' },
  { symbol: 'HCLTECH.NS',    name: 'HCL Technologies',          sector: 'IT', cap: 'large' },
  { symbol: 'TECHM.NS',      name: 'Tech Mahindra',             sector: 'IT', cap: 'large' },
  { symbol: 'LTIM.NS',       name: 'LTIMindtree',               sector: 'IT', cap: 'large' },
  { symbol: 'LT.NS',         name: 'Larsen & Toubro',           sector: 'Engineering', cap: 'large' },
  { symbol: 'SIEMENS.NS',    name: 'Siemens India',             sector: 'Engineering', cap: 'large' },
  { symbol: 'SUNPHARMA.NS',  name: 'Sun Pharmaceutical',        sector: 'Pharma', cap: 'large' },
  { symbol: 'DRREDDY.NS',    name: "Dr. Reddy's Laboratories",  sector: 'Pharma', cap: 'large' },
  { symbol: 'CIPLA.NS',      name: 'Cipla Ltd',                 sector: 'Pharma', cap: 'large' },
  { symbol: 'DIVISLAB.NS',   name: "Divi's Laboratories",       sector: 'Pharma', cap: 'large' },
  { symbol: 'APOLLOHOSP.NS', name: 'Apollo Hospitals',          sector: 'Healthcare', cap: 'large' },
  { symbol: 'HINDUNILVR.NS', name: 'Hindustan Unilever',        sector: 'FMCG', cap: 'large' },
  { symbol: 'NESTLEIND.NS',  name: 'Nestle India',              sector: 'FMCG', cap: 'large' },
  { symbol: 'TITAN.NS',      name: 'Titan Company',             sector: 'Consumer', cap: 'large' },
  { symbol: 'MARUTI.NS',     name: 'Maruti Suzuki',             sector: 'Auto', cap: 'large' },
  { symbol: 'M&M.NS',        name: 'Mahindra & Mahindra',       sector: 'Auto', cap: 'large' },
  { symbol: 'TATASTEEL.NS',  name: 'Tata Steel',                sector: 'Metals', cap: 'large' },
  { symbol: 'JSWSTEEL.NS',   name: 'JSW Steel',                 sector: 'Metals', cap: 'large' },
  { symbol: 'ULTRACEMCO.NS', name: 'UltraTech Cement',          sector: 'Cement', cap: 'large' },
  { symbol: 'ONGC.NS',       name: 'Oil & Natural Gas Corp',    sector: 'Energy', cap: 'large' },
  { symbol: 'COALINDIA.NS',  name: 'Coal India',                sector: 'Energy', cap: 'large' },
  { symbol: 'ADANIENT.NS',   name: 'Adani Enterprises',         sector: 'Conglomerate', cap: 'large' },
  { symbol: 'ADANIPORTS.NS', name: 'Adani Ports',               sector: 'Industrials', cap: 'large' },
  { symbol: 'POWERGRID.NS',  name: 'Power Grid Corp',           sector: 'Utilities', cap: 'large' },
  { symbol: 'NTPC.NS',       name: 'NTPC Ltd',                  sector: 'Utilities', cap: 'large' },
  { symbol: 'BHARTIARTL.NS', name: 'Bharti Airtel',             sector: 'Telecom', cap: 'large' },
  { symbol: 'VBL.NS',        name: 'Varun Beverages',           sector: 'Consumer', cap: 'large' },
  { symbol: 'BAJAJ-AUTO.NS', name: 'Bajaj Auto Ltd',            sector: 'Auto', cap: 'large' },
  { symbol: 'ITC.NS',        name: 'ITC Limited',               sector: 'FMCG', cap: 'large' },
  { symbol: 'SBILIFE.NS',    name: 'SBI Life Insurance',        sector: 'Financials', cap: 'large' },
  { symbol: 'SHRIRAMFIN.NS', name: 'Shriram Finance',           sector: 'NBFC', cap: 'large' },
  { symbol: 'TATACONSUM.NS', name: 'Tata Consumer Products',    sector: 'FMCG', cap: 'large' },
  { symbol: 'JIOFIN.NS',     name: 'Jio Financial Services',    sector: 'NBFC', cap: 'large' },
  { symbol: 'BEL.NS',        name: 'Bharat Electronics',        sector: 'Electronics', cap: 'large' },
  { symbol: 'HAL.NS',        name: 'Hindustan Aeronautics',     sector: 'Aerospace', cap: 'large' },
  { symbol: 'IRFC.NS',       name: 'Indian Railway Finance',    sector: 'NBFC', cap: 'large' },
  { symbol: 'TATAMOTORS.NS', name: 'Tata Motors Limited',       sector: 'Auto', cap: 'large' },

  // ── Mid Cap ──
  { symbol: 'BAJAJFINSV.NS', name: 'Bajaj Finserv',             sector: 'NBFC', cap: 'mid' },
  { symbol: 'INDUSINDBK.NS', name: 'IndusInd Bank',             sector: 'Banking', cap: 'mid' },
  { symbol: 'BANKBARODA.NS', name: 'Bank of Baroda',            sector: 'Banking', cap: 'mid' },
  { symbol: 'PNB.NS',        name: 'Punjab National Bank',      sector: 'Banking', cap: 'mid' },
  { symbol: 'CANBK.NS',      name: 'Canara Bank',               sector: 'Banking', cap: 'mid' },
  { symbol: 'MPHASIS.NS',    name: 'Mphasis Ltd',               sector: 'IT', cap: 'mid' },
  { symbol: 'ABB.NS',        name: 'ABB India',                 sector: 'Engineering', cap: 'mid' },
  { symbol: 'ZYDUSLIFE.NS',  name: 'Zydus Lifesciences',        sector: 'Pharma', cap: 'mid' },
  { symbol: 'BIOCON.NS',     name: 'Biocon Ltd',                sector: 'Pharma', cap: 'mid' },
  { symbol: 'BRITANNIA.NS',  name: 'Britannia Industries',      sector: 'FMCG', cap: 'mid' },
  { symbol: 'TRENT.NS',      name: 'Trent Ltd',                 sector: 'Consumer', cap: 'mid' },
  { symbol: 'ETERNAL.NS',    name: 'Eternal Limited (Zomato)',  sector: 'Consumer Tech', cap: 'mid' },
  { symbol: 'IRCTC.NS',      name: 'IRCTC',                     sector: 'Consumer', cap: 'mid' },
  { symbol: 'EICHERMOT.NS',  name: 'Eicher Motors',             sector: 'Auto', cap: 'mid' },
  { symbol: 'HEROMOTOCO.NS', name: 'Hero MotoCorp',             sector: 'Auto', cap: 'mid' },
  { symbol: 'HINDALCO.NS',   name: 'Hindalco Industries',       sector: 'Metals', cap: 'mid' },
  { symbol: 'VEDL.NS',       name: 'Vedanta Ltd',               sector: 'Metals', cap: 'mid' },
  { symbol: 'SAIL.NS',       name: 'Steel Authority of India',  sector: 'Metals', cap: 'mid' },
  { symbol: 'GRASIM.NS',     name: 'Grasim Industries',         sector: 'Cement', cap: 'mid' },
  { symbol: 'ASIANPAINT.NS', name: 'Asian Paints',              sector: 'Materials', cap: 'mid' },
  { symbol: 'PIDILITIND.NS', name: 'Pidilite Industries',       sector: 'Materials', cap: 'mid' },
  { symbol: 'BPCL.NS',       name: 'Bharat Petroleum',          sector: 'Energy', cap: 'mid' },
  { symbol: 'SUZLON.NS',     name: 'Suzlon Energy',             sector: 'Renewables', cap: 'mid' },
  { symbol: 'TATAPOWER.NS',  name: 'Tata Power',                sector: 'Utilities', cap: 'mid' },
  { symbol: 'HAVELLS.NS',    name: 'Havells India',             sector: 'Industrials', cap: 'mid' },
  { symbol: 'VOLTAS.NS',     name: 'Voltas Ltd',                sector: 'Industrials', cap: 'mid' },
  { symbol: 'DLF.NS',        name: 'DLF Limited',               sector: 'Real Estate', cap: 'mid' },
  { symbol: 'OBEROIRLTY.NS', name: 'Oberoi Realty',             sector: 'Real Estate', cap: 'mid' },
  { symbol: 'CDSL.NS',       name: 'CDSL',                      sector: 'Financials', cap: 'mid' },
  { symbol: 'NTPCGREEN.NS',  name: 'NTPC Green Energy',         sector: 'Renewables', cap: 'mid' },
  { symbol: 'ASTRAL.NS',     name: 'Astral Limited',            sector: 'Materials', cap: 'mid' },
  { symbol: 'RVNL.NS',       name: 'Rail Vikas Nigam',          sector: 'Infrastructure', cap: 'mid' },
  { symbol: 'RECLTD.NS',     name: 'REC Limited',               sector: 'NBFC', cap: 'mid' },
  { symbol: 'PFC.NS',        name: 'Power Finance Corp',        sector: 'NBFC', cap: 'mid' },
  { symbol: 'NHPC.NS',       name: 'NHPC Limited',              sector: 'Utilities', cap: 'mid' },
  { symbol: 'IREDA.NS',      name: 'IREDA',                     sector: 'Renewables', cap: 'mid' },
  { symbol: 'SJVN.NS',       name: 'SJVN Limited',              sector: 'Utilities', cap: 'mid' },

  // ── Small Cap ──
  { symbol: 'RPOWER.NS',     name: 'Reliance Power',            sector: 'Utilities', cap: 'small' },
  { symbol: 'ARVIND.NS',     name: 'Arvind Limited',            sector: 'Materials', cap: 'small' },
  { symbol: 'PCJEWELLER.NS', name: 'PC Jeweller',               sector: 'Consumer', cap: 'small' },
  { symbol: 'GTLINFRA.NS',   name: 'GTL Infrastructure',        sector: 'Telecom', cap: 'small' },
  { symbol: 'MOREPENLAB.NS', name: 'Morepen Laboratories',      sector: 'Healthcare', cap: 'small' },
  { symbol: 'SUVENPHAR.NS',  name: 'Suven Pharmaceuticals',     sector: 'Healthcare', cap: 'small' }
];

const STOCK_CATALOG_US = [
  // ── Large Cap ──
  { symbol: 'AAPL',  name: 'Apple Inc.',               sector: 'Technology', cap: 'large' },
  { symbol: 'MSFT',  name: 'Microsoft Corp.',          sector: 'Technology', cap: 'large' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.',            sector: 'Technology', cap: 'large' },
  { symbol: 'AMZN',  name: 'Amazon.com Inc.',          sector: 'Consumer', cap: 'large' },
  { symbol: 'TSLA',  name: 'Tesla Inc.',               sector: 'Auto', cap: 'large' },
  { symbol: 'NVDA',  name: 'NVIDIA Corp.',             sector: 'Technology', cap: 'large' },
  { symbol: 'META',  name: 'Meta Platforms Inc.',      sector: 'Technology', cap: 'large' },
  { symbol: 'WMT',   name: 'Walmart Inc.',             sector: 'Consumer', cap: 'large' },
  { symbol: 'JPM',   name: 'JPMorgan Chase & Co.',     sector: 'Financials', cap: 'large' },
  { symbol: 'V',     name: 'Visa Inc.',                sector: 'Financials', cap: 'large' },
  { symbol: 'DIS',   name: 'The Walt Disney Co.',      sector: 'Consumer', cap: 'large' },
  { symbol: 'PG',    name: 'Procter & Gamble Co.',     sector: 'Consumer', cap: 'large' },
  { symbol: 'HD',    name: 'Home Depot Inc.',          sector: 'Consumer', cap: 'large' },

  // ── Mid Cap ──
  { symbol: 'AMD',   name: 'Advanced Micro Devices',   sector: 'Technology', cap: 'mid' },
  { symbol: 'NFLX',  name: 'Netflix Inc.',             sector: 'Consumer', cap: 'mid' },
  { symbol: 'PLTR',  name: 'Palantir Technologies',    sector: 'Technology', cap: 'mid' },
  { symbol: 'SNAP',  name: 'Snap Inc.',                sector: 'Technology', cap: 'mid' },
  { symbol: 'ROKU',  name: 'Roku Inc.',                sector: 'Consumer', cap: 'mid' },
  { symbol: 'HOOD',  name: 'Robinhood Markets',        sector: 'Financials', cap: 'mid' },

  // ── Small Cap ──
  { symbol: 'GME',   name: 'GameStop Corp.',           sector: 'Consumer', cap: 'small' },
  { symbol: 'AMC',   name: 'AMC Entertainment',        sector: 'Consumer', cap: 'small' },
  { symbol: 'SIRI',  name: 'Sirius XM Holdings',       sector: 'Telecom', cap: 'small' },
  { symbol: 'SPCE',  name: 'Virgin Galactic',          sector: 'Industrials', cap: 'small' },
  { symbol: 'CLOV',  name: 'Clover Health',            sector: 'Healthcare', cap: 'small' }
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
  { name: 'Consumer',   symbol: '^CNXFMCG',        icon: '🛒' },
];

const SECTOR_MAP_US = [
  { name: 'Technology', symbol: 'XLK',    icon: '💻' },
  { name: 'Financials', symbol: 'XLF',    icon: '🏦' },
  { name: 'Healthcare', symbol: 'XLV',    icon: '🏥' },
  { name: 'Energy',     symbol: 'XLE',    icon: '⚡' },
  { name: 'Industrials',symbol: 'XLI',    icon: '🏭' },
  { name: 'Materials',  symbol: 'XLB',    icon: '🪨' },
  { name: 'Real Estate',symbol: 'XLRE',   icon: '🏢' },
  { name: 'Utilities',  symbol: 'XLU',    icon: '💡' },
  { name: 'Telecom',    symbol: 'XLC',    icon: '📡' },
  { name: 'Renewables', symbol: 'ICLN',   icon: '🌱' },
  { name: 'Consumer',   symbol: 'XLY',    icon: '🛒' },
];

function getEtfSectorName(stockSector) {
  const s = (stockSector || '').toLowerCase();
  if (s === 'it' || s.includes('tech') || s.includes('semiconductor') || s.includes('social') || s.includes('streaming') || s.includes('e-commerce') || s.includes('consumer tech')) {
    return 'Technology';
  }
  if (s.includes('bank') || s.includes('nbfc') || s.includes('financial') || s.includes('insurance')) {
    return 'Financials';
  }
  if (s.includes('pharma') || s.includes('health') || s.includes('hospital')) {
    return 'Healthcare';
  }
  if (s.includes('renewable') || s.includes('wind') || s.includes('solar') || s.includes('green energy') || s.includes('clean energy')) {
    return 'Renewables';
  }
  if (s.includes('energy')) {
    return 'Energy';
  }
  if (s.includes('telecom') || s.includes('telco') || s.includes('telecommunications')) {
    return 'Telecom';
  }
  if (s.includes('auto') || s.includes('engineer') || s.includes('conglomerate') || s.includes('industrial') || s.includes('aerospace') || s.includes('defense') || s.includes('defence') || s.includes('electronics') || s.includes('infrastructure')) {
    return 'Industrials';
  }
  if (s.includes('fmcg') || s.includes('consumer') || s.includes('retail')) {
    return 'Consumer';
  }
  if (s.includes('metal') || s.includes('cement') || s.includes('material')) {
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

function guessSector(symbol, name) {
  const s = ((symbol || '') + ' ' + (name || '')).toLowerCase();
  if (s.includes('bank') || s.includes('nbfc') || s.includes('financial') || s.includes('finance') || s.includes('insurance') || s.includes('capital') || s.includes('investment') || s.includes('credit') || s.includes('fintech') || s.includes('wealth') || s.includes('holding') || s.includes('mutual')) {
    return 'Financials';
  }
  if (s.includes('pharma') || s.includes('health') || s.includes('hospital') || s.includes('biotech') || s.includes('life sciences') || s.includes('diagnostics') || s.includes('labs') || s.includes('clinic')) {
    return 'Healthcare';
  }
  if (s.includes('software') || s.includes('technologies') || s.includes('tech') || s.includes('systems') || s.includes('digital') || s.includes('consultancy') || s.includes('infosys') || s.includes('computers') || s.includes('semiconductor') || s.includes('cyber')) {
    return 'Technology';
  }
  if (s.includes('wind') || s.includes('solar') || s.includes('renewable') || s.includes('green energy') || s.includes('suzlon') || s.includes('clean energy')) {
    return 'Renewables';
  }
  if (s.includes('power') || s.includes('grid') || s.includes('ntpc') || s.includes('electricity') || s.includes('utility') || s.includes('utilities')) {
    return 'Utilities';
  }
  if (s.includes('energy') || s.includes('petroleum') || s.includes('oil') || s.includes('gas') || s.includes('coal') || s.includes('fuel') || s.includes('refinery') || s.includes('ongc') || s.includes('bpcl') || s.includes('hpcl') || s.includes('iocl')) {
    return 'Energy';
  }
  if (s.includes('steel') || s.includes('metal') || s.includes('iron') || s.includes('aluminum') || s.includes('zinc') || s.includes('copper') || s.includes('sail') || s.includes('jsw') || s.includes('hindalco') || s.includes('vedanta') || s.includes('cement') || s.includes('ultratech') || s.includes('grasim') || s.includes('materials') || s.includes('paints') || s.includes('chemicals') || s.includes('industries') || s.includes('pidilite')) {
    return 'Materials';
  }
  if (s.includes('telecommunication') || s.includes('telecom') || s.includes('airtel') || s.includes('communications') || s.includes('mobile') || s.includes('network') || s.includes('broadband')) {
    return 'Telecom';
  }
  if (s.includes('realty') || s.includes('estate') || s.includes('dlf') || s.includes('property') || s.includes('properties') || s.includes('infra') || s.includes('construction') || s.includes('developer')) {
    return 'Real Estate';
  }
  if (s.includes('motors') || s.includes('auto') || s.includes('automobile') || s.includes('maruti') || s.includes('suzuki') || s.includes('eicher') || s.includes('mahindra') || s.includes('tatamotors') || s.includes('automotive')) {
    return 'Auto';
  }
  if (s.includes('retail') || s.includes('trent') || s.includes('titan') || s.includes('britannia') || s.includes('unilever') || s.includes('nestle') || s.includes('fmcg') || s.includes('foods') || s.includes('beverages') || s.includes('hotel') || s.includes('hotels') || s.includes('consumer') || s.includes('zomato') || s.includes('swiggy') || s.includes('e-commerce')) {
    return 'Consumer';
  }
  return 'Industrials';
}

/**
 * Route: Market Summary (Sector leaders, Gainers/Losers from all catalog stocks)
 */
app.get('/api/market-summary', async (req, res) => {
  const market = (req.query.market || 'IN').toUpperCase();
  const cacheKey = `market_summary_${market}`;
  const cachedData = appCache.get(cacheKey);
  if (cachedData) {
    return res.json(cachedData);
  }

  try {
    const catalog = market === 'US' ? STOCK_CATALOG_US : STOCK_CATALOG;
    const sectorMap = market === 'US' ? SECTOR_MAP_US : SECTOR_MAP;

    const symbols = catalog.map(s => s.symbol);
    const quotes = await scraper.fetchQuotes(symbols);

    // Map quotes back to catalog items with names and sectors
    const enrichedQuotes = quotes.map(q => {
      const catItem = catalog.find(s => s.symbol === q.symbol);
      return {
        ...q,
        name: catItem ? catItem.name : q.longName || q.symbol,
        sector: catItem ? catItem.sector : '',
        cap: catItem ? catItem.cap : 'mid'
      };
    });

    // 1. Calculate Top 5 Gainers
    const gainers = [...enrichedQuotes]
      .filter(q => typeof q.changePct === 'number' && q.changePct > 0)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 5)
      .map(q => ({
        symbol: q.symbol,
        name: q.name,
        quote: { price: q.price, change: q.change, changePct: q.changePct }
      }));

    // 2. Calculate Top 5 Losers
    const losers = [...enrichedQuotes]
      .filter(q => typeof q.changePct === 'number' && q.changePct < 0)
      .sort((a, b) => a.changePct - b.changePct)
      .slice(0, 5)
      .map(q => ({
        symbol: q.symbol,
        name: q.name,
        quote: { price: q.price, change: q.change, changePct: q.changePct }
      }));

    // 3. Group by Sector and compute top 5 Gainers & Losers per sector
    const sectors = [];
    for (const etf of sectorMap) {
      const sectorStocks = enrichedQuotes.filter(q => getEtfSectorName(q.sector) === etf.name);
      
      let sectorGainers = [];
      let sectorLosers = [];

      if (sectorStocks.length > 0) {
        const sortedDesc = [...sectorStocks]
          .filter(q => (q.changePct || 0) > 0)
          .sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
        sectorGainers = sortedDesc.slice(0, 5).map(q => ({
          symbol: q.symbol,
          name: q.name,
          quote: { price: q.price, change: q.change, changePct: q.changePct }
        }));

        const sortedAsc = [...sectorStocks]
          .filter(q => (q.changePct || 0) < 0)
          .sort((a, b) => (a.changePct || 0) - (b.changePct || 0));
        sectorLosers = sortedAsc.slice(0, 5).map(q => ({
          symbol: q.symbol,
          name: q.name,
          quote: { price: q.price, change: q.change, changePct: q.changePct }
        }));
      }

      // Fetch ETF price for this sector to get overall sector index change, but compute average of stock changePct if available
      let etfChange = 0;
      let etfPrice = 0;
      let hasStockAverage = false;

      if (sectorStocks.length > 0) {
        let sumChange = 0;
        let validCount = 0;
        for (const stock of sectorStocks) {
          if (typeof stock.changePct === 'number' && !isNaN(stock.changePct)) {
            sumChange += stock.changePct;
            validCount++;
          }
        }
        if (validCount > 0) {
          etfChange = sumChange / validCount;
          hasStockAverage = true;
        }
      }

      try {
        const etfQuote = await scraper.fetchQuote(etf.symbol);
        if (etfQuote) {
          etfPrice = etfQuote.price || 0;
          if (!hasStockAverage) {
            etfChange = etfQuote.changePct || 0;
          }
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
      allQuotes: enrichedQuotes.map(q => ({
        symbol: q.symbol,
        name: q.name,
        sector: q.sector,
        cap: q.cap || 'mid',
        price: q.price,
        change: q.change,
        changePct: q.changePct
      })),
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

// Route: Market indices & Fear/Greed Index
app.get('/api/market-pulse', async (req, res) => {
  const market = (req.query.market || 'IN').toUpperCase();
  const cacheKey = `market_pulse_${market}`;
  const cachedData = appCache.get(cacheKey);
  if (cachedData) {
    return res.json(cachedData);
  }

  // Log request to database
  const email = req.user?.email || 'unknown';
  await logToDatabase(email, 'market-pulse', null, `Market pulse requested for ${market}`);

  try {
    // Select indices based on market
    const indicesList = market === 'US' ? [
      { name: 'S&P 500',   symbol: '^GSPC' },
      { name: 'NASDAQ',    symbol: '^IXIC' },
      { name: 'DOW JONES', symbol: '^DJI' }
    ] : [
      { name: 'NIFTY 50',     symbol: '^NSEI' },
      { name: 'SENSEX',       symbol: '^BSESN' },
      { name: 'BANK NIFTY',   symbol: '^NSEBANK' },
      { name: 'NIFTY IT',     symbol: '^CNXIT' },
      { name: 'NIFTY PHARMA', symbol: '^CNXPHARMA' },
      { name: 'NIFTY FMCG',   symbol: '^CNXFMCG' },
      { name: 'NIFTY AUTO',   symbol: '^CNXAUTO' },
      { name: 'NIFTY METAL',  symbol: '^CNXMETAL' },
      { name: 'NIFTY ENERGY', symbol: '^CNXENERGY' },
      { name: 'NIFTY INFRA',  symbol: '^CNXINFRA' },
      { name: 'NIFTY REALTY', symbol: '^CNXREALTY' }
    ];

    const indicesSymbols = indicesList.map(idx => idx.symbol);
    const indicesPromises = indicesSymbols.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const meta = res.data.chart.result[0].meta;
        const price = meta.regularMarketPrice || 0;
        const prev = meta.chartPreviousClose || meta.previousClose || price;
        const change = price - prev;
        const changePct = prev ? (change / prev * 100) : 0;
        const nameMap = { 
          '^NSEI': 'NIFTY 50', 
          '^BSESN': 'SENSEX', 
          '^NSEBANK': 'BANK NIFTY',
          '^CNXIT': 'NIFTY IT',
          '^CNXPHARMA': 'NIFTY PHARMA',
          '^CNXFMCG': 'NIFTY FMCG',
          '^CNXAUTO': 'NIFTY AUTO',
          '^CNXMETAL': 'NIFTY METAL',
          '^CNXENERGY': 'NIFTY ENERGY',
          '^CNXINFRA': 'NIFTY INFRA',
          '^CNXREALTY': 'NIFTY REALTY',
          '^GSPC': 'S&P 500',
          '^IXIC': 'NASDAQ',
          '^DJI': 'DOW JONES'
        };
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

/**
 * Route: Live Stock Search (Yahoo Finance search endpoint)
 */
app.get('/api/search', authMiddleware, async (req, res) => {
  const query = (req.query.q || '').trim();
  const market = (req.query.market || 'IN').toUpperCase();
  if (!query) {
    return res.json([]);
  }

  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=0`;
    const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    
    if (response.data && response.data.quotes) {
      let filteredQuotes = response.data.quotes.filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'INDEX');
      if (market === 'US') {
        filteredQuotes = filteredQuotes.filter(q => !q.symbol.endsWith('.NS') && !q.symbol.endsWith('.BO'));
      } else {
        filteredQuotes = filteredQuotes.filter(q => q.symbol.endsWith('.NS') || q.symbol.endsWith('.BO') || q.symbol.startsWith('^'));
      }

      const results = filteredQuotes
        .slice(0, 8)
        .map(q => {
          const name = q.longname || q.shortname || q.symbol;
          const guessedSector = guessSector(q.symbol, name);
          return {
            symbol: q.symbol,
            name: name,
            sector: guessedSector
          };
        });
      return res.json(results);
    }
    
    return res.json([]);
  } catch (err) {
    console.error(`Search error for query "${query}":`, err.message);
    return res.status(500).json({ error: 'Failed to search stocks' });
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
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=20`;
    const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = response.data;
    const news = [];

    if (data && data.news) {
      const cleanedSym = symbol.split('.')[0].toUpperCase();
      const upperSym = symbol.toUpperCase();
      const filteredNews = data.news.filter(n => {
        const relatedTickers = Array.isArray(n.relatedTickers) ? n.relatedTickers.map(t => t.toUpperCase()) : [];
        const titleUpper = (n.title || '').toUpperCase();
        return (
          relatedTickers.includes(cleanedSym) ||
          relatedTickers.includes(upperSym) ||
          titleUpper.includes(cleanedSym)
        );
      });

      filteredNews.slice(0, 6).forEach(n => {
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
          date: n.providerPublishTime,
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

// Smart conversational fallback when no Gemini API key is configured
function generateDetailedFallbackReport(currentStockContext, userMessage) {
  const msg = (userMessage || '').toLowerCase();
  
  // 1. General Queries (Greeting, Indicators, Concept Explanations, Indices)
  // These should be answered directly even if a stock is active
  // ── Greeting / intro
  if (!msg || msg.match(/^(hi|hello|hey|greet|start|help|what can you do)/)) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Terminal status: Online and ready.
- Capabilities: Stock analysis, swing trade setup generation, indicator explanation, strategy design.

[ANALYSIS LOG]
- To analyze a stock, select it from the watchlist or ask about it.
- To learn concepts, ask about indicators (RSI, MACD, Moving Averages, Bollinger Bands).
- Input stock ticker or search query to proceed.`;
  }

  // ── Indian Market Indices (Nifty, Sensex, BSE, NSE)
  if (msg.includes('nifty') || msg.includes('sensex') || msg.includes('banknifty') || msg.includes('bank nifty') || msg.includes('index') || msg.includes('market today') || msg.includes('bse') || msg.includes('nse')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Subject: Indian Market Indices (BSE/NSE)
- Data: Live via market pulse banner (top of dashboard)

[ANALYSIS LOG]
- NIFTY 50: Benchmark index of 50 large-cap NSE stocks.
- SENSEX: BSE benchmark of 30 blue-chip companies.
- BANK NIFTY: Tracks 12 large Indian banking stocks.
- Sector Indices: NIFTY IT, NIFTY Pharma, NIFTY Auto, NIFTY FMCG, etc. track sector performance.
- Rule: When NIFTY > 200 SMA → market is in primary uptrend. Favor long swing trades.
- Rule: When BANK NIFTY > NIFTY → sector rotation into financials.`;
  }

  const activeSymbol = currentStockContext?.symbol;
  const activeName = currentStockContext?.name;
  const isQueryAboutActiveStock = activeSymbol && (msg.includes(activeSymbol.toLowerCase()) || (activeName && msg.includes(activeName.toLowerCase())) || msg.includes('this stock') || msg.includes('it') || msg.includes('its') || msg.includes('current stock') || msg.includes('selected stock'));

  // ── RSI questions
  if (msg.includes('rsi') && !isQueryAboutActiveStock) {
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
  if (msg.includes('macd') && !isQueryAboutActiveStock) {
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
  if ((msg.includes('moving average') || msg.includes('sma') || msg.includes('ema') || msg.includes('200 day') || msg.includes('50 day')) && !isQueryAboutActiveStock) {
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
  if ((msg.includes('bollinger') || msg.includes('bb') || (msg.includes('band') && !msg.includes('band aid'))) && !isQueryAboutActiveStock) {
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
  if ((msg.includes('entry') || msg.includes('when to buy') || msg.includes('buy signal')) && !isQueryAboutActiveStock) {
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
  if ((msg.includes('stop loss') || msg.includes('stoploss') || (msg.includes('sl') && msg.length < 20) || msg.includes('risk management')) && !isQueryAboutActiveStock) {
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
  if ((msg.includes('fundamental') || msg.includes('pe ratio') || msg.includes('p/e') || msg.includes('roe') || msg.includes('debt') || msg.includes('valuation')) && !isQueryAboutActiveStock) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Subject: Fundamental Scoring Metrics
- Target: Evaluate financial stability and growth

[ANALYSIS LOG]
- P/E Ratio: Cheap (< 15 for Indian, < 20 for US), Fair (15-35), Expensive (> 50).
- Return on Equity (ROE): Target > 15% (underlying capital efficiency).
- Debt/Equity Ratio: Target < 1.0 (excluding banking/finance sectors).
- Growth: Consistent > 10% YoY revenue and profit growth.
- Scoring weight: Max 25 points per pillar in composite model.`;
  }
  
  // ── Score / rating questions
  if ((msg.includes('score') || msg.includes('rating') || msg.includes('how is') || msg.includes('analysis')) && !isQueryAboutActiveStock) {
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

  // 2. Stock-Specific Fallback Report
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
    
    const isUS = !symbol.endsWith('.NS') && !symbol.endsWith('.BO');
    const cSym = isUS ? '$' : '₹';
    const formatPrice = (p) => typeof p === 'number' ? cSym + p.toLocaleString(isUS ? 'en-US' : 'en-IN', { minimumFractionDigits: 2 }) : 'N/A';
    const price = quote.price || 0;

    const s1 = tradeSetup.indicators?.sr?.s1 || null;
    const r1 = tradeSetup.indicators?.sr?.r1 || null;

    let ratingJustification = '';
    if (composite.total >= 80) {
      ratingJustification = `Strong buy rating is justified by a robust combination of exceptional fundamentals, clear technical breakout above key moving averages, and high institutional volume accumulation.`;
    } else if (composite.total >= 65) {
      ratingJustification = `Buy rating is supported by a healthy primary uptrend and solid core financials, though wait for key levels or minor cooling of indicators for optimal risk-to-reward.`;
    } else if (composite.total >= 50) {
      ratingJustification = `Watch rating is due to range-bound price action and consolidation. Momentum indicators (RSI/MACD) are flat. Conserve capital until a clear direction is established.`;
    } else {
      ratingJustification = `Avoid rating due to weak fundamentals (high debt/declining margins), severe technical markdown structure, or heavy smart-money distribution.`;
    }

    if (msg.includes('rsi')) {
      return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Active Stock: ${name} (${symbol})
- Metric: Relative Strength Index (RSI)
- Current RSI Value: ${rsiVal}

[ANALYSIS LOG]
- The current RSI for ${symbol} is ${rsiVal}.
- In swing trading, RSI below 30 is oversold, while RSI 45-65 represents bullish momentum acceleration.
- Current Interpretation: ${symbol}'s RSI is in the ${parseFloat(rsiVal) < 30 ? 'OVERSOLD zone, indicating a possible reversal.' : parseFloat(rsiVal) > 70 ? 'OVERBOUGHT zone, indicating short-term pullback risk.' : 'neutral momentum sweet spot, favorable for trend continuation.'}
- Rationale: ${ratingJustification}`;
    }

    if (msg.includes('macd')) {
      return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Active Stock: ${name} (${symbol})
- Metric: Moving Average Convergence Divergence (MACD)
- Current MACD Value: ${macdVal}

[ANALYSIS LOG]
- The current MACD status for ${symbol} is: ${macdVal}.
- A bullish MACD crossover occurs when the MACD line crosses above the signal line.
- Current Interpretation: ${macdVal.toLowerCase().includes('bullish') || macdVal.toLowerCase().includes('above') ? 'Bullish crossover confirmed. Momentum is accelerating upward.' : 'Bearish or flat crossover. Exercise caution before entry.'}
- Rationale: ${ratingJustification}`;
    }

    if (msg.includes('stop loss') || msg.includes('stoploss') || (msg.includes('sl') && msg.length < 20) || msg.includes('risk')) {
      return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Active Stock: ${name} (${symbol})
- Metric: Risk Parameters (Stop Loss & Target)
- Target SL: ${formatPrice(tradeSetup.stopLoss)}

[ANALYSIS LOG]
- For ${symbol}, the calculated stop loss is placed at ${formatPrice(tradeSetup.stopLoss)}.
- Upside targets: T1: ${formatPrice(tradeSetup.target1)} | T2: ${formatPrice(tradeSetup.target2)} | T3: ${formatPrice(tradeSetup.target3)}.
- Win Probability: ${winChance}% with a Risk/Reward ratio of 1:${tradeSetup.riskReward || 0}.
- Always strictly respect the stop loss to protect trading capital.`;
    }

    if (msg.includes('pe ratio') || msg.includes('p/e') || msg.includes('pe') || msg.includes('fundamental') || msg.includes('valuation') || msg.includes('debt')) {
      return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Active Stock: ${name} (${symbol})
- Metric: Fundamental Valuation (P/E & Debt)
- Current P/E: ${peVal}

[ANALYSIS LOG]
- ${symbol}'s current P/E Ratio is ${peVal}.
- Debt-to-Equity is assessed at ${debtVal}, and YoY Growth is ${growthVal}.
- Pillar Score: Fundamentals: ${scores.fundamental?.score || 0}/25.
- Valuation context: ${parseFloat(peVal) < 20 ? 'Under-valued / Cheap' : parseFloat(peVal) > 45 ? 'Over-valued / Expensive' : 'Reasonable / Fairly valued'} compared to industry averages.`;
    }

    // Default stock-specific response:
    let entryZone = '';
    if (composite.total >= 80) {
      const entryMin = s1 ? Math.min(price, s1) : price * 0.98;
      const entryMax = price * 1.01;
      entryZone = `${cSym}${entryMin.toFixed(2)} - ${cSym}${entryMax.toFixed(2)} (Accumulate on minor pullbacks to support S1 at ${cSym}${s1 || 'support'} or 20 EMA, or on breakout above R1 at ${cSym}${r1 || 'resistance'})`;
    } else if (composite.total >= 65) {
      const entryMin = s1 ? s1 : price * 0.97;
      entryZone = `${cSym}${entryMin.toFixed(2)} - ${cSym}${price.toFixed(2)} (Optimal entry on minor pullbacks towards support S1 at ${cSym}${s1 || 'support'} or the 50 SMA)`;
    } else if (composite.total >= 50) {
      entryZone = `Wait for breakout above ${cSym}${r1 ? r1.toFixed(2) : 'R1'} or pullback to ${cSym}${s1 ? s1.toFixed(2) : 'S1'}`;
    } else {
      entryZone = `N/A (Not suitable for long swing trades)`;
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

  // ── Greeting / intro
  if (!msg || msg.match(/^(hi|hello|hey|greet|start|help|what can you do)/)) {
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
  const { history, message, currentStockContext, marketSummary } = req.body;
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
    const systemInstructionText = `You are "Invy AI", a highly advanced, intelligent swing trading assistant.
Your goal is to guide users to pick stocks at the perfect price using a combination of fundamentals, technical setup, momentum, sentiment & flows, and disciplined risk management.

Formatting & Response Rules:
1. If the user is asking about a specific stock setup or analyzing a stock, you must respond with a highly structured decision log in markdown:
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

2. If the user is asking a general trading question (e.g. "What is RSI?", "How does swing trading work?"), do NOT use the rigid log/verdict tables above. Instead, provide a highly conversational, educational, clear, and customized explanation in elegant markdown. Keep it engaging, direct, and helpful.
3. Be professional and concise. Keep responses under 200 words. Avoid generic or overly wordy text.`;

    const contents = [...(history || [])];

    let messageWithContext = message;
    let summaryText = "";
    if (marketSummary) {
      const topGainersStr = (marketSummary.gainers || []).map(g => `${g.symbol}: ${g.quote?.changePct >= 0 ? '+' : ''}${(g.quote?.changePct || 0).toFixed(2)}%`).join(', ');
      const topLosersStr = (marketSummary.losers || []).map(l => `${l.symbol}: ${l.quote?.changePct >= 0 ? '+' : ''}${(l.quote?.changePct || 0).toFixed(2)}%`).join(', ');
      const sectorPerfStr = (marketSummary.sectors || []).map(s => `${s.name}: ${s.change >= 0 ? '+' : ''}${(s.change || 0).toFixed(2)}%`).join(', ');
      summaryText = `[Current Market Summary Context:
- Top Gainers: ${topGainersStr || 'N/A'}
- Top Losers: ${topLosersStr || 'N/A'}
- Sector Performance: ${sectorPerfStr || 'N/A'}]`;
    }

    if (currentStockContext && currentStockContext.symbol) {
      const symbol = currentStockContext.symbol;
      const quote = currentStockContext.quote || {};
      const scores = currentStockContext.scores || {};
      const tradeSetup = currentStockContext.tradeSetup || {};
      const composite = scores.composite || { total: 0, rating: 'N/A' };
      
      const checklist = scores.checklist || [];
      const passedChecks = checklist.filter(c => c.passed).length;
      const totalChecks = checklist.length || 12;
      const winChance = Math.round(35 + (passedChecks / totalChecks) * 50);

      const isUS = !symbol.endsWith('.NS') && !symbol.endsWith('.BO');
      const cSym = isUS ? '$' : '₹';

      messageWithContext = `${summaryText}
[Context for currently selected stock: ${currentStockContext.name} (${currentStockContext.symbol})
- Price: ${cSym}${(quote.price || 0).toFixed(2)} (Change: ${(quote.changePct || 0).toFixed(2)}%)
- Scores (out of 25 each): Fundamentals: ${scores.fundamental?.score || 0}, Technicals: ${scores.technicalSetup?.score || 0}, Momentum: ${scores.momentum?.score || 0}, Sentiment & Flows: ${scores.sentimentFlow?.score || 0} (Total: ${composite.total}/100)
- Trade Setup: Entry: ${cSym}${(quote.price || 0).toFixed(2)}, Stop Loss: ${cSym}${tradeSetup.stopLoss || 0}, Target 1: ${cSym}${tradeSetup.target1 || 0}, Target 2: ${cSym}${tradeSetup.target2 || 0}, Target 3: ${cSym}${tradeSetup.target3 || 0}
- Win Probability: ${winChance}%, Risk/Reward: ${tradeSetup.riskReward || 0}:1]

User Query: ${message}`;
    } else if (summaryText) {
      messageWithContext = `${summaryText}

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

// ============================================================
// RECOMMENDATIONS ENGINE, WEBHOOKS & SETTINGS ENDPOINTS
// ============================================================

let simulatedRecommendations = [
  {
    id: 1,
    symbol: 'RELIANCE.NS',
    name: 'Reliance Industries Limited',
    sector: 'Energy',
    market: 'IN',
    rating: 'STRONG BUY',
    price: 2450.50,
    target_1: 2550.00,
    target_2: 2680.00,
    stop_loss: 2380.00,
    status: 'ACTIVE',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    id: 2,
    symbol: 'TCS.NS',
    name: 'Tata Consultancy Services Limited',
    sector: 'Technology',
    market: 'IN',
    rating: 'BUY',
    price: 3820.00,
    target_1: 3990.00,
    target_2: 4150.00,
    stop_loss: 3720.00,
    status: 'ACTIVE',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    id: 3,
    symbol: 'AAPL',
    name: 'Apple Inc.',
    sector: 'Technology',
    market: 'US',
    rating: 'STRONG BUY',
    price: 180.20,
    target_1: 192.00,
    target_2: 205.00,
    stop_loss: 172.00,
    status: 'ACTIVE',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
];

let recommendationsInitialized = false;
async function initializeRecommendationsPrice() {
  if (recommendationsInitialized) return;
  console.log('Initializing simulated recommendations prices with live market data...');
  for (const rec of simulatedRecommendations) {
    try {
      const quote = await scraper.fetchQuote(rec.symbol);
      if (quote && quote.price && quote.price > 0) {
        rec.price = quote.price;
        rec.stop_loss = parseFloat((quote.price * 0.95).toFixed(2));
        rec.target_1 = parseFloat((quote.price * 1.05).toFixed(2));
        rec.target_2 = parseFloat((quote.price * 1.12).toFixed(2));
        console.log(`Initialized simulated recommendation for ${rec.symbol} at ${rec.price} (SL: ${rec.stop_loss}, T1: ${rec.target_1}, T2: ${rec.target_2})`);
      }
    } catch (e) {
      console.warn(`Failed to initialize simulated recommendation price for ${rec.symbol}:`, e.message);
    }
  }
  recommendationsInitialized = true;
}

let simulatedSettings = {
  telegram_enabled: false,
  telegram_chat_id: '',
  telegram_bot_token: '',
  whatsapp_enabled: false,
  whatsapp_phone: '',
  whatsapp_apikey: ''
};

async function sendAlertNotification(symbol, status, currentPrice, target2, stopLoss) {
  let settings = simulatedSettings;
  if (dbPool) {
    try {
      const res = await dbPool.query('SELECT * FROM user_settings ORDER BY id ASC LIMIT 1');
      if (res.rows[0]) {
        settings = res.rows[0];
      }
    } catch (e) {
      console.warn('Failed to fetch user settings for alert notification:', e.message);
    }
  }

  const isUS = !symbol.endsWith('.NS') && !symbol.endsWith('.BO');
  const cSym = isUS ? '$' : '₹';
  const emoji = status === 'WIN' ? '🟢' : '🔴';
  const msg = `${emoji} *SWING TRADE UPDATE: ${status}* ${emoji}\n\n` +
              `*Stock:* ${symbol.toUpperCase()}\n` +
              `*Status:* Closed as ${status}\n` +
              `*Exit Price:* ${cSym}${currentPrice.toFixed(2)}\n` +
              `*Original Stop Loss:* ${cSym}${stopLoss.toFixed(2)}\n` +
              `*Original Target:* ${cSym}${target2.toFixed(2)}\n` +
              `*Timestamp:* ${new Date().toLocaleString()}`;

  // Send Telegram
  if (settings.telegram_enabled && settings.telegram_chat_id && settings.telegram_bot_token) {
    try {
      const tgUrl = `https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`;
      await axios.post(tgUrl, {
        chat_id: settings.telegram_chat_id,
        text: msg,
        parse_mode: 'Markdown'
      }, { timeout: 8000 });
      console.log(`Dispatched real Telegram status update for ${symbol} (${status})`);
    } catch (err) {
      console.error(`Failed to send Telegram status update alert for ${symbol}:`, err.message);
    }
  }

  // Send WhatsApp via CallMeBot
  if (settings.whatsapp_enabled && settings.whatsapp_phone && settings.whatsapp_apikey) {
    try {
      const cleanPhone = settings.whatsapp_phone.replace(/\+/g, '').trim();
      const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(cleanPhone)}&text=${encodeURIComponent(msg)}&apikey=${encodeURIComponent(settings.whatsapp_apikey)}`;
      await axios.get(waUrl, { timeout: 8000 });
      console.log(`Dispatched real WhatsApp status update for ${symbol} (${status})`);
    } catch (err) {
      console.error(`Failed to send WhatsApp status update alert for ${symbol}:`, err.message);
    }
  }
}

async function sendWelcomeActiveRecommendationsAlert(settings) {
  let activeRecs = [];
  if (dbPool) {
    try {
      const dbRes = await dbPool.query("SELECT * FROM recommendations WHERE status = 'ACTIVE' ORDER BY rating DESC, symbol ASC");
      activeRecs = dbRes.rows.map(r => ({
        symbol: r.symbol,
        name: r.name,
        rating: r.rating,
        price: parseFloat(r.price),
        target_1: parseFloat(r.target_1),
        target_2: parseFloat(r.target_2),
        stop_loss: parseFloat(r.stop_loss),
        market: r.market
      }));
    } catch (dbErr) {
      console.error('Failed to query recommendations for welcome alert:', dbErr.message);
    }
  } else {
    activeRecs = (simulatedRecommendations || []).filter(r => r.status === 'ACTIVE' || !r.status);
  }

  if (activeRecs.length > 0) {
    const listMsg = activeRecs.map(r => {
      const isUS = r.market === 'US';
      const cSym = isUS ? '$' : '₹';
      return `📌 *${r.symbol.toUpperCase()}* (${r.rating || 'BUY'})\n` +
             `Price: ${cSym}${r.price.toFixed(2)} | Stop: ${cSym}${r.stop_loss.toFixed(2)}\n` +
             `Target 1: ${cSym}${r.target_1.toFixed(2)} | Target 2: ${cSym}${r.target_2.toFixed(2)}`;
    }).join('\n\n');

    const msg = `🔔 *Swing Trading Alerts Enabled!* 🔔\n\n` +
                `Here is a summary of our current active swing trading picks:\n\n` +
                `${listMsg}\n\n` +
                `We will notify you immediately if any pick hits its target or stop loss!`;

    // Send Telegram
    if (settings.telegram_enabled && settings.telegram_chat_id && settings.telegram_bot_token) {
      try {
        const tgUrl = `https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`;
        await axios.post(tgUrl, {
          chat_id: settings.telegram_chat_id,
          text: msg,
          parse_mode: 'Markdown'
        }, { timeout: 8000 });
        console.log(`Welcome active recommendations Telegram alert sent successfully!`);
      } catch (err) {
        console.error(`Failed to send Welcome Telegram alert:`, err.message);
      }
    }

    // Send WhatsApp via CallMeBot
    if (settings.whatsapp_enabled && settings.whatsapp_phone && settings.whatsapp_apikey) {
      try {
        const cleanPhone = settings.whatsapp_phone.replace(/\+/g, '').trim();
        const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(cleanPhone)}&text=${encodeURIComponent(msg)}&apikey=${encodeURIComponent(settings.whatsapp_apikey)}`;
        await axios.get(waUrl, { timeout: 8000 });
        console.log(`Welcome active recommendations WhatsApp alert sent successfully!`);
      } catch (err) {
        console.error(`Failed to send Welcome WhatsApp alert:`, err.message);
      }
    }
  }
}

async function initTables() {
  if (dbPool) {
    try {
      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS recommendations (
          id SERIAL PRIMARY KEY,
          symbol VARCHAR(20) UNIQUE,
          name VARCHAR(100),
          sector VARCHAR(50),
          market VARCHAR(10),
          rating VARCHAR(20),
          price DECIMAL(12,2),
          target_1 DECIMAL(12,2),
          target_2 DECIMAL(12,2),
          stop_loss DECIMAL(12,2),
          status VARCHAR(20) DEFAULT 'ACTIVE',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS user_settings (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE,
          telegram_enabled BOOLEAN DEFAULT false,
          telegram_chat_id VARCHAR(50) DEFAULT '',
          telegram_bot_token TEXT DEFAULT '',
          whatsapp_enabled BOOLEAN DEFAULT false,
          whatsapp_phone VARCHAR(50) DEFAULT '',
          whatsapp_apikey TEXT DEFAULT '',
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await dbPool.query(`
        ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT DEFAULT '';
        ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS whatsapp_apikey TEXT DEFAULT '';
      `).catch(err => console.log('Migration error (can ignore if columns exist):', err.message));
    } catch (err) {
      console.error('Failed to initialize recommendations / settings tables:', err.message);
    }
  }
}

async function screenNewRecommendation(symbol, name, sector, market) {
  try {
    const quote = await scraper.fetchQuote(symbol);
    if (!quote || !quote.price || quote.price === 0) return null;

    const histUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
    const response = await axios.get(histUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 4000
    });
    const chartResult = response.data?.chart?.result?.[0];
    if (!chartResult) return null;
    const timestamps = chartResult.timestamp || [];
    const quotes = chartResult.indicators.quote[0] || {};
    const historical = timestamps.map((t, i) => ({
      date: new Date(t * 1000).toISOString(),
      open: quotes.open?.[i] || 0,
      high: quotes.high?.[i] || 0,
      low: quotes.low?.[i] || 0,
      close: quotes.close?.[i] || 0,
      volume: quotes.volume?.[i] || 0,
    })).filter(d => d.close > 0);

    if (historical.length < 30) return null;

    const closes = historical.map(d => d.close);
    const highs = historical.map(d => d.high);
    const lows = historical.map(d => d.low);
    const volumes = historical.map(d => d.volume);

    // SMA 50
    const sma50Array = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < 49) { sma50Array.push(null); continue; }
      const sum = closes.slice(i - 49, i + 1).reduce((a, b) => a + b, 0);
      sma50Array.push(sum / 50);
    }
    const sma50 = sma50Array[sma50Array.length - 1] || closes[closes.length - 1];

    // Volume Avg 20
    const volAvgArray = [];
    for (let i = 0; i < volumes.length; i++) {
      if (i < 19) { volAvgArray.push(null); continue; }
      const sum = volumes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0);
      volAvgArray.push(sum / 20);
    }
    const volAvg = volAvgArray[volAvgArray.length - 1] || 1;
    const latestVol = volumes[volumes.length - 1];
    const volRatio = latestVol / volAvg;

    // RSI 14
    let rsi = 50;
    if (closes.length >= 15) {
      let gains = 0, losses = 0;
      for (let i = 1; i <= 14; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains += d;
        else losses += Math.abs(d);
      }
      let avgGain = gains / 14;
      let avgLoss = losses / 14;
      for (let i = 15; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * 13 + (d > 0 ? d : 0)) / 14;
        avgLoss = (avgLoss * 13 + (d < 0 ? Math.abs(d) : 0)) / 14;
      }
      rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }

    // Pivots
    const prevDay = historical[historical.length - 2] || historical[historical.length - 1];
    const pivot = (prevDay.high + prevDay.low + prevDay.close) / 3;
    const s1 = 2 * pivot - prevDay.high;

    // ATR
    const tr = closes.map((c, i) => {
      if (i === 0) return highs[i] - lows[i];
      return Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    });
    let atr = tr[0];
    const k = 2 / 15;
    for (let i = 1; i < tr.length; i++) {
      atr = tr[i] * k + atr * (1 - k);
    }

    const currentPrice = quote.price;
    const stopLoss = parseFloat((currentPrice - 1.5 * atr).toFixed(2));
    const target1 = parseFloat((currentPrice + 2.0 * atr).toFixed(2));
    const target2 = parseFloat((currentPrice + 4.0 * atr).toFixed(2));

    const rsiMatch = rsi >= 45 && rsi <= 65;
    const volMatch = volRatio > 1.3;
    const smaMatch = currentPrice > sma50;
    const supportMatch = s1 && (currentPrice <= s1 * 1.05 && currentPrice >= s1 * 0.95);

    let rating = 'WATCH / HOLD';
    if (rsiMatch && volMatch && smaMatch && supportMatch) rating = 'STRONG BUY';
    else if (rsiMatch && smaMatch) rating = 'BUY';

    return {
      symbol,
      name,
      sector,
      market,
      rating,
      price: currentPrice,
      target_1: target1,
      target_2: target2,
      stop_loss: stopLoss,
      status: 'ACTIVE'
    };
  } catch (err) {
    console.warn(`Screening error for ${symbol}:`, err.message);
    return null;
  }
}

// Route: Get and Update Recommendations
app.get('/api/recommendations', authMiddleware, async (req, res) => {
  const market = (req.query.market || 'IN').toUpperCase();
  await initTables();

  try {
    let recs = [];
    if (dbPool) {
      const result = await dbPool.query('SELECT * FROM recommendations ORDER BY created_at DESC');
      if (result.rows.length === 0) {
        console.log('Seeding empty database recommendations table with live-priced defaults...');
        await initializeRecommendationsPrice();
        for (const rec of simulatedRecommendations) {
          try {
            await dbPool.query(
              `INSERT INTO recommendations (symbol, name, sector, market, rating, price, target_1, target_2, stop_loss, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE')`,
              [rec.symbol, rec.name, rec.sector, rec.market, rec.rating, rec.price, rec.target_1, rec.target_2, rec.stop_loss]
            );
          } catch (seedErr) {
            console.error(`Database seeding failed for ${rec.symbol}:`, seedErr.message);
          }
        }
        const newResult = await dbPool.query('SELECT * FROM recommendations ORDER BY created_at DESC');
        recs = newResult.rows.map(r => ({
          ...r,
          price: parseFloat(r.price),
          target_1: parseFloat(r.target_1),
          target_2: parseFloat(r.target_2),
          stop_loss: parseFloat(r.stop_loss)
        }));
      } else {
        recs = result.rows.map(r => ({
          ...r,
          price: parseFloat(r.price),
          target_1: parseFloat(r.target_1),
          target_2: parseFloat(r.target_2),
          stop_loss: parseFloat(r.stop_loss)
        }));
      }
    } else {
      await initializeRecommendationsPrice();
      recs = simulatedRecommendations;
    }

    // 1. Live status update for active recommendations
    const activeRecs = recs.filter(r => r.status === 'ACTIVE');
    for (const r of activeRecs) {
      try {
        const quote = await scraper.fetchQuote(r.symbol);
        if (quote && quote.price && quote.price > 0) {
          const currentPrice = quote.price;
          let newStatus = 'ACTIVE';
          if (currentPrice >= r.target_2) {
            newStatus = 'WIN';
          } else if (currentPrice <= r.stop_loss) {
            newStatus = 'LOSS';
          }

          if (newStatus !== 'ACTIVE') {
            r.status = newStatus;
            r.updated_at = new Date().toISOString();
            if (dbPool) {
              await dbPool.query(
                'UPDATE recommendations SET status = $1, updated_at = NOW() WHERE id = $2',
                [newStatus, r.id]
              );
            }
            console.log(`Alert! ${r.symbol} closed as ${newStatus} at current price ${currentPrice}`);
            // Send real webhook notifications for Target/SL hit
            sendAlertNotification(r.symbol, newStatus, currentPrice, r.target_2, r.stop_loss).catch(err => {
              console.error(`Alert dispatch error for status change:`, err.message);
            });
          }
        }
      } catch (err) {
        console.warn(`Failed to update status for ${r.symbol}:`, err.message);
      }
    }

    // 2. Ensure at least 3 active recommendations for the requested market
    let activeMarketRecs = recs.filter(r => r.market === market && r.status === 'ACTIVE');
    if (activeMarketRecs.length < 3) {
      const needed = 3 - activeMarketRecs.length;
      const catalog = market === 'US' ? STOCK_CATALOG_US : STOCK_CATALOG;
      
      // Filter candidates not already recommended
      const existingSymbols = new Set(recs.map(r => r.symbol));
      const candidates = catalog.filter(c => !existingSymbols.has(c.symbol));

      let addedCount = 0;
      for (const c of candidates) {
        if (addedCount >= needed) break;
        const newRec = await screenNewRecommendation(c.symbol, c.name, c.sector, market);
        if (newRec) {
          if (dbPool) {
            try {
              const insertRes = await dbPool.query(
                `INSERT INTO recommendations (symbol, name, sector, market, rating, price, target_1, target_2, stop_loss, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE')
                 RETURNING *`,
                [newRec.symbol, newRec.name, newRec.sector, newRec.market, newRec.rating, newRec.price, newRec.target_1, newRec.target_2, newRec.stop_loss]
              );
              if (insertRes.rows[0]) {
                const inserted = insertRes.rows[0];
                recs.unshift({
                  ...inserted,
                  price: parseFloat(inserted.price),
                  target_1: parseFloat(inserted.target_1),
                  target_2: parseFloat(inserted.target_2),
                  stop_loss: parseFloat(inserted.stop_loss)
                });
              }
            } catch (ie) {
              console.error(`Database insertion failed for ${newRec.symbol}:`, ie.message);
            }
          } else {
            newRec.id = recs.length + 1;
            newRec.created_at = new Date().toISOString();
            newRec.updated_at = new Date().toISOString();
            recs.unshift(newRec);
          }
          addedCount++;
        }
      }

      // If strict screening didn't find enough, relax rules and pick from top of remaining candidates
      if (addedCount < needed) {
        const remainingCandidates = candidates.filter(c => !recs.some(r => r.symbol === c.symbol));
        for (const c of remainingCandidates) {
          if (addedCount >= needed) break;
          // relaxed candidate: just fetch quote and build simple setup
          try {
            const quote = await scraper.fetchQuote(c.symbol);
            if (quote && quote.price && quote.price > 0) {
              const currentPrice = quote.price;
              const stopLoss = parseFloat((currentPrice * 0.95).toFixed(2));
              const target1 = parseFloat((currentPrice * 1.05).toFixed(2));
              const target2 = parseFloat((currentPrice * 1.10).toFixed(2));
              const newRec = {
                symbol: c.symbol,
                name: c.name,
                sector: c.sector,
                market,
                rating: 'BUY',
                price: currentPrice,
                target_1: target1,
                target_2: target2,
                stop_loss: stopLoss,
                status: 'ACTIVE'
              };

              if (dbPool) {
                const insertRes = await dbPool.query(
                  `INSERT INTO recommendations (symbol, name, sector, market, rating, price, target_1, target_2, stop_loss, status)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE')
                   RETURNING *`,
                  [newRec.symbol, newRec.name, newRec.sector, newRec.market, newRec.rating, newRec.price, newRec.target_1, newRec.target_2, newRec.stop_loss]
                );
                if (insertRes.rows[0]) {
                  const inserted = insertRes.rows[0];
                  recs.unshift({
                    ...inserted,
                    price: parseFloat(inserted.price),
                    target_1: parseFloat(inserted.target_1),
                    target_2: parseFloat(inserted.target_2),
                    stop_loss: parseFloat(inserted.stop_loss)
                  });
                }
              } else {
                newRec.id = recs.length + 1;
                newRec.created_at = new Date().toISOString();
                newRec.updated_at = new Date().toISOString();
                recs.unshift(newRec);
              }
              addedCount++;
            }
          } catch (err) {
            console.warn(`Relaxed fallback screening failed for ${c.symbol}:`, err.message);
          }
        }
      }
    }

    res.json({ recommendations: recs });
  } catch (err) {
    console.error('Failed to retrieve or update recommendations:', err.message);
    res.status(500).json({ error: 'Failed to process recommendations' });
  }
});

// Route: Get Alert Settings
app.get('/api/settings', authMiddleware, async (req, res) => {
  const email = req.user?.email || 'dev@local.com';
  await initTables();

  try {
    if (dbPool) {
      const result = await dbPool.query('SELECT * FROM user_settings WHERE email = $1', [email]);
      if (result.rows[0]) {
        return res.json(result.rows[0]);
      }
    }
    res.json({
      email,
      telegram_enabled: simulatedSettings.telegram_enabled,
      telegram_chat_id: simulatedSettings.telegram_chat_id,
      telegram_bot_token: simulatedSettings.telegram_bot_token,
      whatsapp_enabled: simulatedSettings.whatsapp_enabled,
      whatsapp_phone: simulatedSettings.whatsapp_phone,
      whatsapp_apikey: simulatedSettings.whatsapp_apikey
    });
  } catch (err) {
    console.error('Failed to get user settings:', err.message);
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// Route: Save Alert Settings
app.post('/api/settings', authMiddleware, async (req, res) => {
  const email = req.user?.email || 'dev@local.com';
  const { telegram_enabled, telegram_chat_id, telegram_bot_token, whatsapp_enabled, whatsapp_phone, whatsapp_apikey } = req.body;
  await initTables();

  try {
    if (dbPool) {
      await dbPool.query(
        `INSERT INTO user_settings (email, telegram_enabled, telegram_chat_id, telegram_bot_token, whatsapp_enabled, whatsapp_phone, whatsapp_apikey, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (email) DO UPDATE
         SET telegram_enabled = EXCLUDED.telegram_enabled,
             telegram_chat_id = EXCLUDED.telegram_chat_id,
             telegram_bot_token = EXCLUDED.telegram_bot_token,
             whatsapp_enabled = EXCLUDED.whatsapp_enabled,
             whatsapp_phone = EXCLUDED.whatsapp_phone,
             whatsapp_apikey = EXCLUDED.whatsapp_apikey,
             updated_at = NOW()`,
        [email, telegram_enabled || false, telegram_chat_id || '', telegram_bot_token || '', whatsapp_enabled || false, whatsapp_phone || '', whatsapp_apikey || '']
      );
    } else {
      simulatedSettings.telegram_enabled = !!telegram_enabled;
      simulatedSettings.telegram_chat_id = telegram_chat_id || '';
      simulatedSettings.telegram_bot_token = telegram_bot_token || '';
      simulatedSettings.whatsapp_enabled = !!whatsapp_enabled;
      simulatedSettings.whatsapp_phone = whatsapp_phone || '';
      simulatedSettings.whatsapp_apikey = whatsapp_apikey || '';
    }

    const updatedSettings = {
      telegram_enabled: telegram_enabled || false,
      telegram_chat_id: telegram_chat_id || '',
      telegram_bot_token: telegram_bot_token || '',
      whatsapp_enabled: whatsapp_enabled || false,
      whatsapp_phone: whatsapp_phone || '',
      whatsapp_apikey: whatsapp_apikey || ''
    };

    sendWelcomeActiveRecommendationsAlert(updatedSettings).catch(e => console.error("Error sending welcome alert:", e));

    res.json({
      status: 'success',
      settings: {
        email,
        ...updatedSettings
      }
    });
  } catch (err) {
    console.error('Failed to save user settings:', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Route: Send simulated webhook test signal
app.post('/api/test-signal', authMiddleware, async (req, res) => {
  const { symbol, telegram_chat_id, whatsapp_phone, telegram_bot_token, whatsapp_apikey } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

  try {
    const quote = await scraper.fetchQuote(symbol);
    const price = quote?.price || 150.00;
    const isUS = !symbol.endsWith('.NS') && !symbol.endsWith('.BO');
    const cSym = isUS ? '$' : '₹';

    const payload = {
      event: 'SWING_TRADE_SIGNAL',
      timestamp: new Date().toISOString(),
      recipient_telegram: telegram_chat_id || 'Not configured',
      recipient_whatsapp: whatsapp_phone || 'Not configured',
      data: {
        symbol: symbol.toUpperCase(),
        action: 'BUY / ACCUMULATE',
        price: cSym + price.toFixed(2),
        stop_loss: cSym + (price * 0.95).toFixed(2),
        target_1: cSym + (price * 1.05).toFixed(2),
        target_2: cSym + (price * 1.10).toFixed(2),
        timeframe: 'Daily / Weekly Swing',
        rationale: 'Confluence detected: Price near support S1, RSI oversold recovery, Volume spike > 1.3x average.'
      }
    };

    const alertMsg = `📈 *SWING TRADE SIGNAL* 📈\n` +
      `*Stock:* ${symbol.toUpperCase()}\n` +
      `*Action:* BUY / ACCUMULATE\n` +
      `*Price:* ${cSym}${price.toFixed(2)}\n` +
      `*Stop Loss:* ${cSym}${(price * 0.95).toFixed(2)}\n` +
      `*Targets:* T1: ${cSym}${(price * 1.05).toFixed(2)} | T2: ${cSym}${(price * 1.10).toFixed(2)}\n` +
      `*Timeframe:* Daily / Weekly Swing\n` +
      `*Rationale:* Confluence detected: Price near support S1, RSI oversold recovery, Volume spike > 1.3x average.`;

    // 1. Dispatch real Telegram message if bot token is provided
    if (telegram_chat_id && telegram_bot_token) {
      try {
        const tgUrl = `https://api.telegram.org/bot${telegram_bot_token}/sendMessage`;
        console.log(`Sending real Telegram test signal to ${telegram_chat_id}...`);
        await axios.post(tgUrl, {
          chat_id: telegram_chat_id,
          text: alertMsg,
          parse_mode: 'Markdown'
        }, { timeout: 8000 });
      } catch (tgErr) {
        console.warn(`Failed to dispatch real Telegram test signal:`, tgErr.message);
      }
    }

    // 2. Dispatch real WhatsApp message via CallMeBot if API key is provided
    if (whatsapp_phone && whatsapp_apikey) {
      try {
        const cleanPhone = whatsapp_phone.replace(/\+/g, '').trim();
        const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(cleanPhone)}&text=${encodeURIComponent(alertMsg)}&apikey=${encodeURIComponent(whatsapp_apikey)}`;
        console.log(`Sending real WhatsApp test signal to ${cleanPhone}...`);
        await axios.get(waUrl, { timeout: 8000 });
      } catch (waErr) {
        console.warn(`Failed to dispatch real WhatsApp test signal:`, waErr.message);
      }
    }

    res.json({
      status: 'success',
      message: 'Webhook signal dispatched successfully.',
      payload: payload
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test signal', details: err.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

module.exports = app;
