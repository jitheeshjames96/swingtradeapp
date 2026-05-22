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
    // 1. Fetch Quote
    const quote = await scraper.fetchQuote(resolvedSymbol);


    // 2. Fetch Fundamentals & Earnings (Screener.in for Indian, Yahoo for US)
    let fundamentals = {};
    let earnings = { quarterly: [], annual: [] };
    let shareholding = null;

    const isIndian = resolvedSymbol.endsWith('.NS') || resolvedSymbol.endsWith('.BO');
    if (isIndian) {
      const screener = await scraper.fetchScreenerData(resolvedSymbol);
      if (screener) {
        fundamentals = { ...screener.fundamentals };
        earnings = { ...screener.earnings };
        shareholding = screener.shareholding || null;
        
        // Dynamically calculate P/B ratio from quote price and scraped book value
        if (fundamentals.bookValue && quote.price) {
          fundamentals.pb = parseFloat((quote.price / fundamentals.bookValue).toFixed(2));
        } else {
          fundamentals.pb = null;
        }
      } else {
        const yahoo = await scraper.fetchYahooFundamentals(resolvedSymbol);
        fundamentals = yahoo;
        shareholding = yahoo.shareholding || null;
      }
    } else {
      const yahoo = await scraper.fetchYahooFundamentals(resolvedSymbol);
      fundamentals = yahoo;
      shareholding = yahoo.shareholding || null;
    }

    // 3. Fetch Historical Data (from Yahoo Finance - standard)
    let historical = [];
    try {
      const histUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${resolvedSymbol}?interval=1d&range=1y`;
      const response = await axios.get(histUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const chartResult = response.data.chart.result[0];
      const timestamps = chartResult.timestamp || [];
      const quotes = chartResult.indicators.quote[0] || {};
      historical = timestamps.map((t, i) => ({
        date: new Date(t * 1000).toISOString(),
        open: quotes.open?.[i] || 0,
        high: quotes.high?.[i] || 0,
        low: quotes.low?.[i] || 0,
        close: quotes.close?.[i] || 0,
        volume: quotes.volume?.[i] || 0,
      })).filter(d => d.close > 0);
    } catch (e) {
      console.warn(`Historical data fetch failed for ${resolvedSymbol}, returning empty array: ${e.message}`);
    }

    const payload = {
      symbol: resolvedSymbol,
      originalSymbol: cleanSymbol !== resolvedSymbol ? cleanSymbol : undefined,
      quote,
      fundamentals,
      earnings,
      shareholding,
      historical,
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

// Route: Market indices & Fear/Greed Index
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
    // Fetch indices (Nifty, Sensex, S&P 500, Nasdaq) from Yahoo chart endpoints
    const indicesSymbols = ['^NSEI', '^BSESN', '^GSPC', '^IXIC'];
    const indicesPromises = indicesSymbols.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const meta = res.data.chart.result[0].meta;
        const price = meta.regularMarketPrice || 0;
        const prev = meta.chartPreviousClose || meta.previousClose || price;
        const change = price - prev;
        const changePct = prev ? (change / prev * 100) : 0;
        return {
          symbol: sym,
          name: sym === '^NSEI' ? 'NIFTY 50' : sym === '^BSESN' ? 'SENSEX' : sym === '^GSPC' ? 'S&P 500' : 'NASDAQ',
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
    const symbolText = symbol ? ` regarding ${symbol}` : '';
    const fallbackResponse = `I am **Invy**, your Swing Trading Assistant. 

Currently, the server is running in *Free Mode* without a Gemini API Key. Here is my professional assessment based on general trading principles${symbolText}:

1. **Risk Management First**: Never enter a swing trade without setting a hard Stop Loss. Typically, place it just below the recent swing low or 1.5x to 2.0x the ATR.
2. **Trend Alignment**: Only take long positions if the price is above the 50-day and 200-day Simple Moving Averages.
3. **Momentum Check**: Look for an RSI value between 45 and 65 that is rising, supported by above-average volume.

*Note: If you have a Gemini API Key, please save it in the settings panel (top-right gear icon) to unlock real-time custom AI chat.*`;
    return res.json({ response: fallbackResponse });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const systemInstructionText = `You are "Invy", a veteran swing trader and investment strategist with 25 years of experience.
Your goal is to guide users to pick stocks at the perfect price using a combination of fundamentals, technical setup, momentum, sentiment & flows, and disciplined risk management.
Always adhere strictly to these rules:
1. Be professional, highly concise, and direct. Keep responses under 120 words.
2. Use bullet points or short paragraphs. Avoid wordy explanations to minimize API usage/quota.
3. Provide realistic setups with clear entry, target price, stop-loss, and risk-to-reward ratio.
4. When talking about a stock, use the provided context to justify your decisions, including win probabilities, risks, and scores.
5. If the user asks for trading advice without a specific stock, guide them using general trading concepts or swing trading principles.`;

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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

module.exports = app;
