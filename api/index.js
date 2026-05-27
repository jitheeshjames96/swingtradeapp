const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const axios = require('axios');
const { Pool } = require('pg');
const scraper = require('../server/src/scraper');
const cryptoHelper = require('../server/src/brokers/cryptoHelper');
const BrokerFactory = require('../server/src/brokers/BrokerFactory');


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
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.split(' ')[1];
    
    if (idToken === 'DEMO_BYPASS') {
      req.user = { email: 'demo@guest.com' };
      return next();
    }
    
    // Try native JWT first
    const nativePayload = cryptoHelper.verifyToken(idToken);
    if (nativePayload && nativePayload.email) {
      req.user = { email: nativePayload.email };
      return next();
    }

    // Try Google SSO second
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId) {
      try {
        const payload = await verifyGoogleToken(idToken);
        if (payload) {
          if (payload.aud !== clientId) {
            return res.status(401).json({ error: 'Unauthorized: Client ID mismatch' });
          }
          
          const email = payload.email;
          const authorizedEmails = (process.env.AUTHORIZED_EMAIL || '')
            .split(',')
            .map(e => e.trim().toLowerCase())
            .filter(Boolean);

          if (authorizedEmails.length > 0 && !authorizedEmails.includes(email.toLowerCase())) {
            return res.status(403).json({ error: `Forbidden: Email ${email} is not authorized` });
          }

          req.user = { email };
          return next();
        }
      } catch (err) {
        console.error('Google auth check failed:', err.message);
      }
    }
    
    return res.status(401).json({ error: 'Unauthorized: Invalid ID or Session token' });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    // SSO not configured and no token supplied, bypass authentication for dev
    req.user = { email: 'dev@local.com' };
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
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

// Custom Email/Password Registration Endpoint
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const cleanEmail = email.trim().toLowerCase();
  
  if (!dbPool) {
    return res.status(500).json({ error: 'Database connection not available' });
  }

  try {
    const checkRes = await dbPool.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (checkRes.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashed = cryptoHelper.hashPassword(password);
    
    await dbPool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2)',
      [cleanEmail, hashed]
    );

    const token = cryptoHelper.generateToken(cleanEmail);
    await logToDatabase(cleanEmail, 'register', null, 'User registered successfully via email/password');
    res.json({ status: 'success', token, email: cleanEmail });
  } catch (err) {
    console.error('Registration failed:', err.message);
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

// Custom Email/Password Login Endpoint
app.post('/api/auth/email-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const cleanEmail = email.trim().toLowerCase();
  
  if (!dbPool) {
    return res.status(500).json({ error: 'Database connection not available' });
  }

  try {
    const userRes = await dbPool.query('SELECT id, password_hash FROM users WHERE email = $1', [cleanEmail]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = userRes.rows[0];
    const isMatch = cryptoHelper.verifyPassword(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = cryptoHelper.generateToken(cleanEmail);
    await logToDatabase(cleanEmail, 'email_login', null, 'User logged in successfully via email/password');
    res.json({ status: 'success', token, email: cleanEmail });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// Connect Broker Endpoint
app.post('/api/portfolio/connect', authMiddleware, async (req, res) => {
  const { brokerName, apiKey, accessToken } = req.body;
  if (!brokerName || !accessToken) {
    return res.status(400).json({ error: 'Broker name and access token are required' });
  }

  const email = req.user?.email;
  if (!email) {
    return res.status(401).json({ error: 'Unauthorized: No email associated with token' });
  }

  if (!dbPool) {
    return res.status(500).json({ error: 'Database connection not available' });
  }

  try {
    let userId;
    const userRes = await dbPool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userRes.rows.length > 0) {
      userId = userRes.rows[0].id;
    } else {
      const insertRes = await dbPool.query(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
        [email, 'SSO_AUTO_CREATED']
      );
      userId = insertRes.rows[0].id;
    }

    const encryptedTokenObj = cryptoHelper.encrypt(accessToken);
    const encryptedApiKey = apiKey ? cryptoHelper.encryptWithHeader(apiKey) : null;

    await dbPool.query(
      `INSERT INTO user_broker_connections (user_id, broker_name, encrypted_access_token, encrypted_api_key, iv, auth_tag, token_expiry)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '30 days')
       ON CONFLICT (user_id, broker_name) 
       DO UPDATE SET 
         encrypted_access_token = EXCLUDED.encrypted_access_token,
         encrypted_api_key = EXCLUDED.encrypted_api_key,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         token_expiry = EXCLUDED.token_expiry,
         updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        brokerName.toUpperCase(),
        encryptedTokenObj.encryptedText,
        encryptedApiKey,
        encryptedTokenObj.iv,
        encryptedTokenObj.authTag
      ]
    );

    await logToDatabase(email, 'portfolio_connect', null, `Connected to broker ${brokerName}`);
    res.json({ status: 'success', message: `Successfully connected to ${brokerName}` });
  } catch (err) {
    console.error('Failed to connect broker:', err.message);
    res.status(500).json({ error: 'Failed to connect broker: ' + err.message });
  }
});

// Disconnect Broker Endpoint
app.post('/api/portfolio/disconnect', authMiddleware, async (req, res) => {
  const { brokerName } = req.body;
  const email = req.user?.email;
  if (!email) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!dbPool) {
    return res.status(500).json({ error: 'Database connection not available' });
  }
  try {
    const userRes = await dbPool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      return res.json({ status: 'success', message: 'No connection found to disconnect' });
    }
    const userId = userRes.rows[0].id;
    await dbPool.query('DELETE FROM user_broker_connections WHERE user_id = $1 AND broker_name = $2', [userId, (brokerName || '').toUpperCase()]);
    await dbPool.query('DELETE FROM user_holdings WHERE user_id = $1', [userId]);
    await logToDatabase(email, 'portfolio_disconnect', null, `Disconnected from broker ${brokerName}`);
    res.json({ status: 'success', message: `Disconnected from ${brokerName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live Portfolio Sync & AI Robo-Advisor Analysis Endpoint
app.get('/api/portfolio/analyze', authMiddleware, async (req, res) => {
  const email = req.user?.email;
  if (!email) {
    return res.status(401).json({ error: 'Unauthorized: No email associated with token' });
  }

  if (!dbPool) {
    return res.status(500).json({ error: 'Database connection not available' });
  }

  try {
    const userRes = await dbPool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      return res.json({ connected: false, message: 'No broker connected.', holdings: [] });
    }
    const userId = userRes.rows[0].id;

    const connRes = await dbPool.query('SELECT * FROM user_broker_connections WHERE user_id = $1', [userId]);
    if (connRes.rows.length === 0) {
      return res.json({ connected: false, message: 'No broker connected.', holdings: [] });
    }

    const connection = connRes.rows[0];
    const brokerName = connection.broker_name;
    const decryptedToken = cryptoHelper.decrypt(connection.encrypted_access_token, connection.iv, connection.auth_tag);
    const decryptedApiKey = connection.encrypted_api_key ? cryptoHelper.decryptWithHeader(connection.encrypted_api_key) : null;

    const adapter = BrokerFactory.getAdapter(brokerName, { apiKey: decryptedApiKey, accessToken: decryptedToken });
    const rawHoldings = await adapter.getHoldings();

    await dbPool.query('DELETE FROM user_holdings WHERE user_id = $1', [userId]);
    for (const h of rawHoldings) {
      await dbPool.query(
        `INSERT INTO user_holdings (user_id, symbol, average_buy_price, quantity)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, symbol) 
         DO UPDATE SET average_buy_price = EXCLUDED.average_buy_price, quantity = EXCLUDED.quantity, last_synced_at = NOW()`,
        [userId, h.symbol, h.averagePrice, h.quantity]
      );
    }

    const analyzedHoldings = [];
    let totalCost = 0;
    let totalValue = 0;
    let exitAlertCount = 0;
    let totalWeightedScore = 0;
    let scoredHoldingsCount = 0;

    for (const h of rawHoldings) {
      const quantity = h.quantity;
      const averageBuyPrice = h.averagePrice;
      const cost = quantity * averageBuyPrice;
      totalCost += cost;

      let ltp = averageBuyPrice;
      let score = 60;
      let verdict = 'HOLD';
      let verdictDetails = 'Analyzing setup...';
      let stopLossPrice = parseFloat((averageBuyPrice * 0.95).toFixed(2));

      try {
        const details = await getStockDetails(h.symbol);
        if (details && details.quote?.price) {
          ltp = details.quote.price;
        }

        if (details && details.historical && details.historical.length >= 30) {
          const hist = details.historical;
          const closes = hist.map(x => x.close);
          const highs = hist.map(x => x.high);
          const lows = hist.map(x => x.low);

          const techSetup = scoreTechnicalSetupBackend(
            closes,
            highs,
            lows,
            hist[hist.length - 1]?.volume,
            hist[hist.length - 2]
          );
          const momSetup = scoreMomentumBackend(
            closes,
            hist.map(x => x.volume)
          );

          let fundScore = 15;
          if (details.fundamentals?.pe) {
            fundScore = details.fundamentals.pe > 0 && details.fundamentals.pe < 20 ? 20 : 15;
          }

          score = compositeScoreBackend(
            fundScore,
            techSetup.score,
            momSetup.score,
            5,
            5,
            ltp,
            techSetup.sma200,
            null,
            'bull'
          );

          const tr = closes.map((c, i) => {
            if (i === 0) return highs[i] - lows[i];
            return Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
          });
          let atr = tr[0];
          const k = 2 / 15;
          for (let i = 1; i < tr.length; i++) {
            atr = tr[i] * k + atr * (1 - k);
          }

          stopLossPrice = parseFloat((averageBuyPrice - 1.5 * atr).toFixed(2));
        }

        if (ltp <= stopLossPrice) {
          verdict = 'EXIT (STOP-LOSS)';
          verdictDetails = `Stop-loss breached at ${stopLossPrice.toFixed(2)}. Sell to protect capital.`;
          exitAlertCount++;
        } else if (score >= 75) {
          verdict = 'ADD / BUY';
          verdictDetails = `Bullish configuration (Score: ${score}). Position is robust.`;
        } else if (score >= 50) {
          verdict = 'HOLD';
          verdictDetails = `Neutral-positive configuration (Score: ${score}). Stay in trade, monitor stop-loss at ${stopLossPrice.toFixed(2)}.`;
        } else {
          verdict = 'EXIT / TRIM';
          verdictDetails = `Weak structure (Score: ${score}). Consider trimming to lower risk.`;
          exitAlertCount++;
        }

        if (score > 0) {
          totalWeightedScore += score * cost;
          scoredHoldingsCount += cost;
        }

      } catch (err) {
        console.warn(`[RoboAdvisor] Details fetch failed for ${h.symbol}:`, err.message);
        verdictDetails = `Feeds unavailable. Static stop-loss at ${stopLossPrice.toFixed(2)}.`;
        if (ltp <= stopLossPrice) {
          verdict = 'EXIT (STOP-LOSS)';
          exitAlertCount++;
        }
      }

      const val = quantity * ltp;
      totalValue += val;
      const pnl = val - cost;
      const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;

      analyzedHoldings.push({
        symbol: h.symbol,
        quantity,
        averageBuyPrice,
        currentPrice: ltp,
        cost,
        value: val,
        pnl,
        pnlPercent,
        score,
        verdict,
        verdictDetails,
        stopLossPrice
      });
    }

    const portfolioScore = scoredHoldingsCount > 0 ? Math.round(totalWeightedScore / scoredHoldingsCount) : 60;
    const totalPnl = totalValue - totalCost;
    const totalPnlPercent = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

    await logToDatabase(email, 'portfolio_analyze', null, `Sync & Analyzed ${rawHoldings.length} holdings. Value: ${totalValue.toFixed(2)}`);

    res.json({
      connected: true,
      brokerName,
      holdings: analyzedHoldings,
      summary: {
        totalCost,
        totalValue,
        totalPnl,
        totalPnlPercent,
        portfolioScore,
        exitAlertCount,
        holdingsCount: rawHoldings.length
      }
    });

  } catch (err) {
    console.error('Portfolio analysis failed:', err.message);
    res.status(500).json({ error: 'Portfolio analysis failed: ' + err.message });
  }
});

// Health check

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Route: Get live stock quote
app.get('/api/quote', authMiddleware, async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }
  try {
    const quote = await scraper.fetchQuote(symbol);
    res.json(quote);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quote', details: err.message });
  }
});

// Route: Get cached or live historical prices
app.get('/api/historical', authMiddleware, async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }
  try {
    const historical = await getCachedHistoricalPrices(symbol);
    res.json(historical);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch historical data', details: err.message });
  }
});

// Route: Get fundamentals (Screener + Yahoo merged)
app.get('/api/fundamentals', authMiddleware, async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }
  const cleanSymbol = symbol.trim().toUpperCase();
  const isIndian = cleanSymbol.endsWith('.NS') || cleanSymbol.endsWith('.BO');
  try {
    let fundamentals = {};
    if (isIndian) {
      const screener = await scraper.fetchScreenerData(cleanSymbol).catch(() => null);
      const yahooFund = await scraper.fetchYahooFundamentals(cleanSymbol).catch(() => null);
      if (screener) {
        fundamentals = {
          ...yahooFund,
          ...screener.fundamentals
        };
        try {
          const quote = await scraper.fetchQuote(cleanSymbol).catch(() => null);
          if (screener.fundamentals.bookValue && quote && quote.price) {
            fundamentals.pb = parseFloat((quote.price / screener.fundamentals.bookValue).toFixed(2));
          } else if (!fundamentals.pb && yahooFund?.pb) {
            fundamentals.pb = yahooFund.pb;
          }
        } catch (e) {}
        fundamentals.shareholding = screener.shareholding || yahooFund?.shareholding || null;
      } else if (yahooFund) {
        fundamentals = yahooFund;
      }
    } else {
      fundamentals = await scraper.fetchYahooFundamentals(cleanSymbol).catch(() => null);
    }
    res.json(fundamentals || {});
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch fundamentals', details: err.message });
  }
});

// Route: Get quarterly and annual earnings
app.get('/api/earnings', authMiddleware, async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }
  const cleanSymbol = symbol.trim().toUpperCase();
  const isIndian = cleanSymbol.endsWith('.NS') || cleanSymbol.endsWith('.BO');
  try {
    let earnings = { quarterly: [], annual: [] };
    if (isIndian) {
      const screener = await scraper.fetchScreenerData(cleanSymbol).catch(() => null);
      if (screener && screener.earnings) {
        earnings = screener.earnings;
      }
    } else {
      try {
        const auth = await scraper.getYahooAuth();
        const { cookie, crumb } = auth;
        const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(cleanSymbol)}?modules=earningsHistory,incomeStatementHistoryQuarterly,incomeStatementHistory&crumb=${encodeURIComponent(crumb)}`;
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Cookie': cookie
          },
          timeout: 5000
        });
        const result = response.data.quoteSummary.result[0];
        const quarterly = result.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
        const annual = result.incomeStatementHistory?.incomeStatementHistory || [];

        const parseQuarterly = quarterly.slice(0, 12).map(q => ({
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
        earnings = { quarterly: parseQuarterly, annual: parseAnnual };
      } catch (err) {
        console.warn(`Yahoo earnings summary failed for ${cleanSymbol}:`, err.message);
      }
    }
    res.json(earnings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch earnings', details: err.message });
  }
});


// Helper: Get cached historical prices with DB and Yahoo fallback
async function getCachedHistoricalPrices(symbol) {
  const cacheKey = `hist_prices_${symbol}`;
  const memoryCached = appCache.get(cacheKey);
  if (memoryCached) return memoryCached;

  if (dbPool) {
    try {
      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS historical_prices (
          symbol VARCHAR(20),
          date VARCHAR(30),
          open NUMERIC,
          high NUMERIC,
          low NUMERIC,
          close NUMERIC,
          volume BIGINT,
          PRIMARY KEY (symbol, date)
        );
      `);

      const res = await dbPool.query(
        'SELECT date, open, high, low, close, volume FROM historical_prices WHERE symbol = $1 ORDER BY date ASC',
        [symbol]
      );

      if (res.rows.length > 30) {
        const data = res.rows.map(r => ({
          date: r.date,
          open: parseFloat(r.open),
          high: parseFloat(r.high),
          low: parseFloat(r.low),
          close: parseFloat(r.close),
          volume: parseInt(r.volume || 0)
        }));
        appCache.set(cacheKey, data, 3600);
        return data;
      }
    } catch (err) {
      console.error(`PostgreSQL historical query failed for ${symbol}:`, err.message);
    }
  }

  // Yahoo Finance fallback
  try {
    const histUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
    const response = await axios.get(histUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 6000
    });
    const chartResult = response.data.chart.result[0];
    const timestamps = chartResult.timestamp || [];
    const quotes = chartResult.indicators.quote[0] || {};
    const data = timestamps.map((t, i) => ({
      date: new Date(t * 1000).toISOString(),
      open: quotes.open?.[i] || quotes.close?.[i] || 0,
      high: quotes.high?.[i] || quotes.close?.[i] || 0,
      low: quotes.low?.[i] || quotes.close?.[i] || 0,
      close: quotes.close?.[i] || 0,
      volume: quotes.volume?.[i] || 0,
    })).filter(d => d.close > 0);

    if (dbPool && data.length > 0) {
      // Save in background
      (async () => {
        try {
          await dbPool.query('DELETE FROM historical_prices WHERE symbol = $1', [symbol]);
          const chunkSize = 50;
          for (let offset = 0; offset < data.length; offset += chunkSize) {
            const chunk = data.slice(offset, offset + chunkSize);
            const values = [];
            const placeholders = [];
            let paramIdx = 1;
            
            for (const d of chunk) {
              placeholders.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6})`);
              values.push(symbol, d.date, d.open, d.high, d.low, d.close, d.volume);
              paramIdx += 7;
            }
            
            const query = `
              INSERT INTO historical_prices (symbol, date, open, high, low, close, volume)
              VALUES ${placeholders.join(', ')}
              ON CONFLICT (symbol, date) DO NOTHING
            `;
            await dbPool.query(query, values);
          }
          console.log(`Saved ${data.length} historical price rows to DB for ${symbol}`);
        } catch (dbErr) {
          console.error(`Failed to save historical prices to DB for ${symbol}:`, dbErr.message);
        }
      })();
    }

    appCache.set(cacheKey, data, 3600);
    return data;
  } catch (e) {
    console.warn(`Historical data fetch failed for ${symbol}: ${e.message}`);
    return [];
  }
}

// Helper: Get full stock details (quote, news, fundamentals, fear/greed)
async function getStockDetails(symbol) {
  const cleanSymbol = symbol.trim().toUpperCase();
  const cacheKey = `analyze_${cleanSymbol}`;
  const cachedData = appCache.get(cacheKey);
  if (cachedData) {
    return cachedData;
  }

  const isIndian = cleanSymbol.endsWith('.NS') || cleanSymbol.endsWith('.BO');
  
  const quotePromise = scraper.fetchQuote(cleanSymbol);
  
  const fundamentalsPromise = isIndian 
    ? Promise.all([
        scraper.fetchScreenerData(cleanSymbol).catch(e => { console.warn(`Screener failed for ${cleanSymbol}: ${e.message}`); return null; }),
        scraper.fetchYahooFundamentals(cleanSymbol).catch(e => { console.warn(`Yahoo fundamentals failed for ${cleanSymbol}: ${e.message}`); return null; })
      ]).then(([screener, yahooFund]) => ({ screener, yahooFund }))
    : scraper.fetchYahooFundamentals(cleanSymbol)
        .catch(e => { console.warn(`Yahoo fundamentals failed for ${cleanSymbol}: ${e.message}`); return null; })
        .then(yahoo => ({ screener: null, yahooFund: yahoo }));
    
  const historicalPromise = getCachedHistoricalPrices(cleanSymbol);

  const newsPromise = (async () => {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(cleanSymbol)}&newsCount=20`;
      const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 });
      const data = response.data;
      const news = [];
      if (data && data.news) {
        const cleanedSym = cleanSymbol.split('.')[0].toUpperCase();
        const filteredNews = data.news.filter(n => {
          const relatedTickers = Array.isArray(n.relatedTickers) ? n.relatedTickers.map(t => t.toUpperCase()) : [];
          const titleUpper = (n.title || '').toUpperCase();
          return (
            relatedTickers.includes(cleanedSym) ||
            relatedTickers.includes(cleanSymbol) ||
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
      console.warn(`News fetch failed in analyze for ${cleanSymbol}:`, error.message);
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
    symbol: cleanSymbol,
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

  appCache.set(cacheKey, payload);
  return payload;
}

// Route: Analyze Stock
app.get('/api/analyze', authMiddleware, async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }

  const cleanSymbol = symbol.trim().toUpperCase();

  const BROKEN_TICKERS = new Set([
    'TATAMOTORS.NS', 'TATAMOTORS.BO',
  ]);
  const TICKER_ALIASES = {
    'ZOMATO.NS': 'ETERNAL.NS',
  };

  if (BROKEN_TICKERS.has(cleanSymbol)) {
    return res.status(404).json({
      error: `${cleanSymbol} is not available on Yahoo Finance due to a corporate restructuring/demerger. Please use an alternative ticker or check NSE India for the latest symbol.`,
      details: 'Ticker unavailable on Yahoo Finance'
    });
  }

  const resolvedSymbol = TICKER_ALIASES[cleanSymbol] || cleanSymbol;

  const email = req.user?.email || 'unknown';
  await logToDatabase(email, 'analyze', resolvedSymbol, `Stock analysis requested (original: ${cleanSymbol})`);

  try {
    const payload = await getStockDetails(resolvedSymbol);

    // Background check: calculate composite score and check for Strong Buy signal
    if (payload && payload.historical && payload.historical.length >= 30) {
      try {
        const hist = payload.historical;
        const techSetup = scoreTechnicalSetupBackend(
          hist.map(h => h.close),
          hist.map(h => h.high),
          hist.map(h => h.low),
          hist[hist.length - 1]?.volume,
          hist[hist.length - 2]
        );
        const momSetup = scoreMomentumBackend(
          hist.map(h => h.close),
          hist.map(h => h.volume)
        );
        
        let fundScore = 15;
        if (payload.fundamentals?.pe) {
          fundScore = payload.fundamentals.pe > 0 && payload.fundamentals.pe < 20 ? 20 : 15;
        }
        const sentScore = 5;
        const instScore = 5;

        // Custom weights / active regime parsing (optional query parameters)
        let customWeights = null;
        if (req.query.weights) {
          try {
            customWeights = JSON.parse(req.query.weights);
          } catch (e) {}
        }
        const activeRegime = req.query.regime || 'bull';

        const score = compositeScoreBackend(
          fundScore,
          techSetup.score,
          momSetup.score,
          sentScore,
          instScore,
          payload.quote?.price || 0,
          techSetup.sma200,
          customWeights,
          activeRegime
        );

        if (score >= 80 && payload.quote?.price > 0) {
          checkAndInsertSignal(resolvedSymbol, payload.quote.price, score).catch(err => {
            console.error(`Error checking/inserting signal from analyze endpoint:`, err.message);
          });
        }
      } catch (calcErr) {
        console.warn(`Failed to calculate background score for ${resolvedSymbol}:`, calcErr.message);
      }
    }

    res.json(payload);
  } catch (error) {
    console.error(`Analysis failed for ${resolvedSymbol}:`, error.message);
    res.status(500).json({ error: 'Failed to analyze stock', details: error.message });
  }
});

// Technical indicator math functions for backend
function calcSMA(prices, period) {
  const sma = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      sma.push(null);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += prices[i - j];
      }
      sma.push(sum / period);
    }
  }
  return sma;
}

function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [];
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) {
      ema.push(prices[0]);
    } else {
      ema.push(prices[i] * k + ema[i - 1] * (1 - k));
    }
  }
  return ema;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return Array(prices.length).fill(50);
  const rsi = [];
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  const padding = Array(prices.length - rsi.length).fill(null);
  return [...padding, ...rsi];
}

function calcBollingerBands(prices, period = 20, stdDev = 2) {
  const sma = calcSMA(prices, period);
  const bb = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      bb.push({ upper: null, mid: null, lower: null });
    } else {
      const mean = sma[i];
      let sumSq = 0;
      for (let j = 0; j < period; j++) {
        sumSq += Math.pow(prices[i - j] - mean, 2);
      }
      const std = Math.sqrt(sumSq / period);
      bb.push({ upper: mean + stdDev * std, mid: mean, lower: mean - stdDev * std });
    }
  }
  return bb;
}

function calcMACD(prices, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(prices, fast);
  const emaSlow = calcEMA(prices, slow);
  const macdLine = prices.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = calcEMA(macdLine.slice(slow - 1), signal);
  const fullSignal = [...Array(slow - 1).fill(null), ...signalLine];
  const histogram = macdLine.map((m, i) => {
    if (i < slow - 1 || fullSignal[i] === null) return null;
    return m - fullSignal[i];
  });
  return { macd: macdLine, signal: fullSignal, histogram };
}

function scoreTechnicalSetupBackend(prices, highs, lows, lastVolume, prevBar) {
  if (prices.length < 30) return { score: 10, sma200: null };

  const currentPrice = prices[prices.length - 1];
  const sma20 = calcSMA(prices, 20);
  const sma50 = calcSMA(prices, 50);
  const sma200 = calcSMA(prices, 200);

  const lastSma20 = sma20[sma20.length - 1] || 0;
  const lastSma50 = sma50[sma50.length - 1] || 0;
  const lastSma200 = sma200[sma200.length - 1] || 0;

  let smaPassed = false;
  if (currentPrice > lastSma20 && lastSma20 > lastSma50) {
    smaPassed = true;
  }
  const smaScore = smaPassed ? (lastSma50 > lastSma200 ? 8 : 6) : 2;

  let supportPassed = false;
  let r1 = 0, s1 = 0, s2 = 0;
  if (prevBar) {
    const pivot = (prevBar.high + prevBar.low + prevBar.close) / 3;
    r1 = 2 * pivot - prevBar.low;
    s1 = 2 * pivot - prevBar.high;
    s2 = pivot - (prevBar.high - prevBar.low);
  }
  const distS1 = s1 ? Math.abs(currentPrice - s1) / currentPrice : 99;
  const distS2 = s2 ? Math.abs(currentPrice - s2) / currentPrice : 99;
  const distSma200 = lastSma200 ? Math.abs(currentPrice - lastSma200) / currentPrice : 99;

  if (distS1 < 0.03 || distS2 < 0.03 || distSma200 < 0.03) {
    supportPassed = true;
  }
  const supportScore = supportPassed ? 6 : 2;

  const bb = calcBollingerBands(prices, 20, 2);
  const lastBB = bb[bb.length - 1] || {};
  let bbPassed = false;
  const bbBandwidth = lastBB.mid ? (lastBB.upper - lastBB.lower) / lastBB.mid : 99;
  if (bbBandwidth < 0.12 || currentPrice >= lastBB.upper) {
    bbPassed = true;
  }
  const bbScore = bbPassed ? 6 : 3;

  return {
    score: smaScore + supportScore + bbScore,
    sma200: lastSma200
  };
}

function scoreMomentumBackend(prices, volumes) {
  if (prices.length < 30) return { score: 10 };

  const currentPrice = prices[prices.length - 1];
  const rsi = calcRSI(prices, 14);
  const lastRSI = rsi[rsi.length - 1] || 50;

  let rsiScore = 4;
  if (lastRSI < 30 || lastRSI > 70) rsiScore = 2;
  else if (lastRSI >= 45 && lastRSI <= 65) rsiScore = 8;

  const macdData = calcMACD(prices, 12, 26, 9);
  const lastMACD = macdData.macd[macdData.macd.length - 1] || 0;
  const lastSignal = macdData.signal[macdData.signal.length - 1] || 0;
  const macdScore = lastMACD > lastSignal ? 6 : 2;

  let volScore = 2;
  if (volumes.length >= 20) {
    const latestVol = volumes[volumes.length - 1];
    const prev20Vol = volumes.slice(-20);
    const avgVol = prev20Vol.reduce((a, b) => a + b, 0) / 20;
    const volRatio = avgVol ? latestVol / avgVol : 1;
    if (volRatio >= 2.0) volScore = 6;
    else if (volRatio >= 1.3) volScore = 4;
  }
  
  return {
    score: rsiScore + macdScore + volScore
  };
}

function compositeScoreBackend(fundScore, setupScore, momScore, sentScore, instScore, price, sma200, customWeights, activeRegime) {
  const weights = customWeights || {
    fundamental: 25,
    technical: 30,
    momentum: 20,
    sentiment: 10,
    institutional: 15
  };

  const reg = activeRegime || 'bull';

  let adjFundWeight = weights.fundamental;
  let adjTechWeight = weights.technical;
  let adjMomWeight = weights.momentum;
  let adjSentWeight = weights.sentiment;
  let adjInstWeight = weights.institutional;

  if (reg === 'bear') {
    adjTechWeight *= 0.7;
    adjMomWeight *= 0.7;
    adjFundWeight *= 1.3;
  }

  const sumWeights = adjFundWeight + adjTechWeight + adjMomWeight + adjSentWeight + adjInstWeight;

  const normFund = (fundScore / 25) * 100;
  const normTech = (setupScore / 20) * 100;
  const normMom = (momScore / 20) * 100;
  const normSent = (sentScore / 10) * 100;
  const normInst = (instScore / 15) * 100;

  const weightedSum = 
    (normFund * adjFundWeight) +
    (normTech * adjTechWeight) +
    (normMom * adjMomWeight) +
    (normSent * adjSentWeight) +
    (normInst * adjInstWeight);

  const totalScore = sumWeights > 0 ? (weightedSum / sumWeights) : 50;

  return Math.round(totalScore);
}

function simulateTrades(historicalData, fundScore, sentScore, instScore, threshold, holdingPeriod, weights, activeRegime) {
  const trades = [];
  const closes = historicalData.map(d => d.close);
  const highs = historicalData.map(d => d.high);
  const lows = historicalData.map(d => d.low);
  const volumes = historicalData.map(d => d.volume);

  let inTrade = false;
  let entryIndex = -1;
  let entryPrice = 0;
  let entryDate = null;
  let holdDays = 0;

  for (let i = 30; i < historicalData.length; i++) {
    const subCloses = closes.slice(0, i + 1);
    const subHighs = highs.slice(0, i + 1);
    const subLows = lows.slice(0, i + 1);
    const subVolumes = volumes.slice(0, i + 1);

    const prevBar = historicalData[i - 1];
    const techSetup = scoreTechnicalSetupBackend(subCloses, subHighs, subLows, volumes[i], prevBar);
    const momSetup = scoreMomentumBackend(subCloses, subVolumes);

    const score = compositeScoreBackend(
      fundScore,
      techSetup.score,
      momSetup.score,
      sentScore,
      instScore,
      closes[i],
      techSetup.sma200,
      weights,
      activeRegime
    );

    if (!inTrade) {
      if (score >= threshold) {
        inTrade = true;
        entryIndex = i;
        const nextBar = historicalData[i + 1];
        entryPrice = nextBar ? nextBar.open : closes[i];
        entryDate = nextBar ? nextBar.date : historicalData[i].date;
        holdDays = 0;
      }
    } else {
      holdDays++;
      const currentDate = new Date(historicalData[i].date);
      const entryDateObj = new Date(entryDate);
      const diffTime = Math.abs(currentDate - entryDateObj);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays >= holdingPeriod || i === historicalData.length - 1) {
        const exitPrice = historicalData[i].close;
        const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        trades.push({
          entryDate: entryDate,
          entryPrice: entryPrice,
          exitDate: historicalData[i].date,
          exitPrice: exitPrice,
          holdDays: diffDays,
          returnPct: returnPct
        });
        inTrade = false;
        i += 1;
      }
    }
  }

  const totalTrades = trades.length;
  const profitableTrades = trades.filter(t => t.returnPct > 0).length;
  const winRate = totalTrades > 0 ? (profitableTrades / totalTrades) * 100 : 0;
  const avgReturn = totalTrades > 0 ? trades.reduce((sum, t) => sum + t.returnPct, 0) / totalTrades : 0;

  return {
    trades,
    winRate,
    avgReturn,
    totalTrades
  };
}

async function getIndexReturn(indexSymbol, startDate, endDate) {
  try {
    const historical = await getCachedHistoricalPrices(indexSymbol);
    if (historical && historical.length > 0) {
      const startMs = new Date(startDate).getTime();
      const endMs = new Date(endDate).getTime();

      let startBar = historical[0];
      let endBar = historical[historical.length - 1];

      for (const bar of historical) {
        const barMs = new Date(bar.date).getTime();
        if (barMs >= startMs) {
          startBar = bar;
          break;
        }
      }

      for (let i = historical.length - 1; i >= 0; i--) {
        const bar = historical[i];
        const barMs = new Date(bar.date).getTime();
        if (barMs <= endMs) {
          endBar = bar;
          break;
        }
      }

      if (startBar && endBar && startBar.close > 0) {
        return ((endBar.close - startBar.close) / startBar.close) * 100;
      }
    }
  } catch (err) {
    console.error(`Failed to calculate index return for ${indexSymbol}:`, err.message);
  }
  return 0;
}

// Route: Run trade backtest simulation
app.post('/api/backtest', authMiddleware, async (req, res) => {
  const { symbol, threshold = 80, holdingPeriod = 30, lookback = 365, weights, activeRegime } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

  try {
    const detail = await getStockDetails(symbol);
    if (!detail) return res.status(404).json({ error: 'Stock details not found' });

    let fundScore = 15;
    let sentScore = 5;
    let instScore = 5;

    if (detail.fundamentals?.pe) {
      fundScore = detail.fundamentals.pe > 0 && detail.fundamentals.pe < 20 ? 20 : 15;
    }
    
    let historicalData = detail.historical || [];
    if (historicalData.length === 0) {
      historicalData = await getCachedHistoricalPrices(symbol);
    }

    if (historicalData.length < 35) {
      return res.status(400).json({ error: 'Insufficient historical data for backtesting' });
    }

    let filteredHistory = historicalData;
    if (lookback && lookback < 365) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - parseInt(lookback));
      filteredHistory = historicalData.filter(d => new Date(d.date) >= cutoffDate);
    }

    if (filteredHistory.length < 35) {
      filteredHistory = historicalData;
    }

    const sim = simulateTrades(filteredHistory, fundScore, sentScore, instScore, threshold, holdingPeriod, weights, activeRegime);

    const indexSymbol = symbol.endsWith('.NS') || symbol.endsWith('.BO') ? '^NSEI' : '^GSPC';
    const startDate = filteredHistory[0].date;
    const endDate = filteredHistory[filteredHistory.length - 1].date;
    const indexRet = await getIndexReturn(indexSymbol, startDate, endDate);

    const totalReturn = sim.trades.reduce((a, b) => a + b.returnPct, 0);
    const alpha = totalReturn - indexRet;

    res.json({
      symbol,
      winRate: sim.winRate,
      avgReturn: sim.avgReturn,
      totalTrades: sim.totalTrades,
      alpha: alpha,
      trades: sim.trades,
      benchmarkReturn: indexRet
    });

  } catch (err) {
    console.error(`Backtest failed for ${symbol}:`, err.message);
    res.status(500).json({ error: 'Failed to run backtest simulation', details: err.message });
  }
});

function matchFilter(value, operator, targetValue) {
  if (value === undefined || value === null || isNaN(value)) return false;
  const val = parseFloat(value);
  const target = parseFloat(targetValue);
  if (operator === '>') return val > target;
  if (operator === '<') return val < target;
  if (operator === '=') return Math.abs(val - target) < 0.001;
  return false;
}

// Route: Dynamic Custom Screener Query
app.post('/api/screener/query', authMiddleware, async (req, res) => {
  const { filters, weights, activeRegime, market = 'IN' } = req.body;
  
  try {
    const catalog = market === 'US' ? STOCK_CATALOG_US : STOCK_CATALOG;
    const symbols = catalog.map(s => s.symbol);

    const quotes = await scraper.fetchQuotes(symbols);
    
    let candidates = quotes.map(q => {
      const catItem = catalog.find(s => s.symbol === q.symbol);
      return {
        symbol: q.symbol,
        name: catItem ? catItem.name : q.longName || q.symbol,
        sector: catItem ? catItem.sector : '',
        cap: catItem ? catItem.cap : 'mid',
        price: q.price,
        changePct: q.changePct,
        marketCapCr: q.currency === 'INR' ? (q.marketCap / 1e7) : (q.marketCap / 1e6),
        pe: q.peRatio || null
      };
    });

    const quoteMetrics = ['price', 'changePct', 'marketCap', 'pe'];
    const quoteFilters = [];
    const detailFilters = [];

    if (Array.isArray(filters)) {
      for (const f of filters) {
        if (quoteMetrics.includes(f.metric)) {
          quoteFilters.push(f);
        } else {
          detailFilters.push(f);
        }
      }
    }

    for (const f of quoteFilters) {
      candidates = candidates.filter(c => {
        let val = null;
        if (f.metric === 'price') val = c.price;
        else if (f.metric === 'changePct') val = c.changePct;
        else if (f.metric === 'marketCap') val = c.marketCapCr;
        else if (f.metric === 'pe') val = c.pe;
        return matchFilter(val, f.operator, f.value);
      });
    }

    const limit = 40;
    if (detailFilters.length > 0 || filters.length === 0) {
      const enrichedCandidates = [];
      const symbolsToEnrich = candidates.slice(0, limit).map(c => c.symbol);

      for (const sym of symbolsToEnrich) {
        try {
          const detail = await getStockDetails(sym);
          const cand = candidates.find(c => c.symbol === sym);
          if (detail && cand) {
            const hist = detail.historical || [];
            let rsiVal = 50;
            let volRatio = 1.0;
            let roeVal = detail.fundamentals?.roe || null;
            let pbVal = detail.fundamentals?.pb || null;

            if (hist.length >= 30) {
              const subCloses = hist.map(h => h.close);
              const rsiSeries = calcRSI(subCloses, 14);
              rsiVal = rsiSeries[rsiSeries.length - 1] || 50;

              const latestVol = hist[hist.length - 1].volume || 0;
              const prev20Vol = hist.slice(-20).map(h => h.volume);
              const avgVol = prev20Vol.reduce((a, b) => a + b, 0) / 20;
              volRatio = avgVol ? latestVol / avgVol : 1;
            }

            const techSetup = scoreTechnicalSetupBackend(hist.map(h => h.close), hist.map(h => h.high), hist.map(h => h.low), hist[hist.length-1]?.volume, hist[hist.length-2]);
            const momSetup = scoreMomentumBackend(hist.map(h => h.close), hist.map(h => h.volume));
            
            let fundScore = 15;
            if (detail.fundamentals?.pe) {
              fundScore = detail.fundamentals.pe > 0 && detail.fundamentals.pe < 20 ? 20 : 15;
            }
            const sentScore = 5;
            const instScore = 5;

            const composite = compositeScoreBackend(
              fundScore,
              techSetup.score,
              momSetup.score,
              sentScore,
              instScore,
              cand.price,
              techSetup.sma200,
              weights,
              activeRegime
            );

            if (composite >= 80 && cand.price > 0) {
              checkAndInsertSignal(cand.symbol, cand.price, composite).catch(err => {
                console.error(`Error in background signal check/insert for ${cand.symbol}:`, err.message);
              });
            }

            enrichedCandidates.push({
              ...cand,
              rsi: rsiVal,
              volumeRatio: volRatio,
              roe: roeVal,
              pb: pbVal,
              score: composite
            });
          }
        } catch (err) {
          console.warn(`Failed to enrich candidate ${sym}:`, err.message);
        }
      }

      let finalResults = enrichedCandidates;
      for (const f of detailFilters) {
        finalResults = finalResults.filter(c => {
          let val = null;
          if (f.metric === 'rsi') val = c.rsi;
          else if (f.metric === 'volumeRatio') val = c.volumeRatio;
          else if (f.metric === 'roe') val = c.roe;
          else if (f.metric === 'pb') val = c.pb;
          else if (f.metric === 'score') val = c.score;
          return matchFilter(val, f.operator, f.value);
        });
      }

      return res.json(finalResults);
    } else {
      return res.json(candidates.slice(0, 40));
    }

  } catch (err) {
    console.error('Screener query failed:', err.message);
    res.status(500).json({ error: 'Failed to run screener query', details: err.message });
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
  { symbol: 'DMART.NS',      name: 'Avenue Supermarts',         sector: 'Consumer', cap: 'large' },
  { symbol: 'IOC.NS',        name: 'Indian Oil Corp',           sector: 'Energy', cap: 'large' },
  { symbol: 'GAIL.NS',       name: 'GAIL (India) Ltd',          sector: 'Energy', cap: 'large' },
  { symbol: 'TVSMOTOR.NS',   name: 'TVS Motor Company',         sector: 'Auto', cap: 'large' },
  { symbol: 'LICI.NS',       name: 'Life Insurance Corp',       sector: 'Financials', cap: 'large' },
  { symbol: 'SRF.NS',        name: 'SRF Limited',               sector: 'Materials', cap: 'large' },
  { symbol: 'SHREECEM.NS',   name: 'Shree Cement',              sector: 'Cement', cap: 'large' },
  { symbol: 'ICICIPRULI.NS', name: 'ICICI Prudential Life',     sector: 'Financials', cap: 'large' },
  { symbol: 'ICICIGI.NS',    name: 'ICICI Lombard Gen Insurance', sector: 'Financials', cap: 'large' },
  { symbol: 'INDHOTEL.NS',   name: 'Indian Hotels Company',     sector: 'Consumer', cap: 'large' },

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
  { symbol: 'KPITTECH.NS',   name: 'KPIT Technologies',         sector: 'IT', cap: 'mid' },
  { symbol: 'COFORGE.NS',    name: 'Coforge Ltd',               sector: 'IT', cap: 'mid' },
  { symbol: 'PERSISTENT.NS', name: 'Persistent Systems',        sector: 'IT', cap: 'mid' },
  { symbol: 'TATAELXSI.NS',  name: 'Tata Elxsi',                sector: 'IT', cap: 'mid' },
  { symbol: 'IDFCFIRSTB.NS', name: 'IDFC First Bank',           sector: 'Banking', cap: 'mid' },
  { symbol: 'FEDERALBNK.NS', name: 'Federal Bank',              sector: 'Banking', cap: 'mid' },
  { symbol: 'LICHSGFIN.NS',  name: 'LIC Housing Finance',       sector: 'NBFC', cap: 'mid' },
  { symbol: 'MUTHOOTFIN.NS', name: 'Muthoot Finance',           sector: 'NBFC', cap: 'mid' },
  { symbol: 'CHOLAFIN.NS',   name: 'Cholamandalam Inv',         sector: 'NBFC', cap: 'mid' },
  { symbol: 'COLPAL.NS',     name: 'Colgate-Palmolive India',   sector: 'FMCG', cap: 'mid' },
  { symbol: 'DABUR.NS',      name: 'Dabur India',               sector: 'FMCG', cap: 'mid' },
  { symbol: 'MARICO.NS',     name: 'Marico Ltd',                sector: 'FMCG', cap: 'mid' },
  { symbol: 'GODREJCP.NS',   name: 'Godrej Consumer Products',  sector: 'FMCG', cap: 'mid' },
  { symbol: 'BATAINDIA.NS',  name: 'Bata India',                sector: 'Consumer', cap: 'mid' },
  { symbol: 'KALYANKJIL.NS', name: 'Kalyan Jewellers',          sector: 'Consumer', cap: 'mid' },
  { symbol: 'ADANIPOWER.NS', name: 'Adani Power',               sector: 'Utilities', cap: 'mid' },
  { symbol: 'ADANIGREEN.NS', name: 'Adani Green Energy',        sector: 'Renewables', cap: 'mid' },
  { symbol: 'JSWENERGY.NS',  name: 'JSW Energy',                sector: 'Utilities', cap: 'mid' },
  { symbol: 'BHEL.NS',       name: 'Bharat Heavy Electricals',  sector: 'Engineering', cap: 'mid' },
  { symbol: 'GMRINFRA.NS',   name: 'GMR Airports Infra',        sector: 'Infrastructure', cap: 'mid' },
  { symbol: 'LUPIN.NS',      name: 'Lupin Ltd',                 sector: 'Pharma', cap: 'mid' },
  { symbol: 'AUROPHARMA.NS', name: 'Aurobindo Pharma',          sector: 'Pharma', cap: 'mid' },
  { symbol: 'MAXHEALTH.NS',  name: 'Max Healthcare',            sector: 'Healthcare', cap: 'mid' },
  { symbol: 'JINDALSTEL.NS', name: 'Jindal Steel & Power',      sector: 'Metals', cap: 'mid' },
  { symbol: 'NMDC.NS',       name: 'NMDC Ltd',                  sector: 'Metals', cap: 'mid' },
  { symbol: 'AMBUJACEM.NS',  name: 'Ambuja Cements',            sector: 'Cement', cap: 'mid' },
  { symbol: 'GODREJPROP.NS', name: 'Godrej Properties',         sector: 'Real Estate', cap: 'mid' },
  { symbol: 'LODHA.NS',      name: 'Macrotech Developers',      sector: 'Real Estate', cap: 'mid' },
  { symbol: 'TATACOMM.NS',   name: 'Tata Communications',       sector: 'Telecom', cap: 'mid' },
  { symbol: 'TATACHEM.NS',   name: 'Tata Chemicals',            sector: 'Materials', cap: 'mid' },
  { symbol: 'ASHOKLEY.NS',   name: 'Ashok Leyland',             sector: 'Auto', cap: 'mid' },
  { symbol: 'MRF.NS',        name: 'MRF Ltd',                   sector: 'Auto', cap: 'mid' },
  { symbol: 'BALKRISIND.NS', name: 'Balkrishna Industries',     sector: 'Auto', cap: 'mid' },
  { symbol: 'COROMANDEL.NS', name: 'Coromandel International',  sector: 'Materials', cap: 'mid' },
  { symbol: 'DEEPAKNTR.NS',  name: 'Deepak Nitrite',            sector: 'Materials', cap: 'mid' },
  { symbol: 'AARTIIND.NS',   name: 'Aarti Industries',          sector: 'Materials', cap: 'mid' },
  { symbol: 'ABFRL.NS',      name: 'Aditya Birla Fashion',      sector: 'Consumer', cap: 'mid' },
  { symbol: 'APLLTD.NS',     name: 'Alembic Pharma',            sector: 'Pharma', cap: 'mid' },
  { symbol: 'BALRAMCHIN.NS', name: 'Balrampur Chini',           sector: 'Consumer', cap: 'mid' },
  { symbol: 'BANDHANBNK.NS', name: 'Bandhan Bank',              sector: 'Banking', cap: 'mid' },
  { symbol: 'BERGEPAINT.NS', name: 'Berger Paints',             sector: 'Materials', cap: 'mid' },
  { symbol: 'BHARATFORG.NS', name: 'Bharat Forge',              sector: 'Engineering', cap: 'mid' },
  { symbol: 'CESC.NS',       name: 'CESC Limited',              sector: 'Utilities', cap: 'mid' },
  { symbol: 'CGPOWER.NS',    name: 'CG Power & Industrial',     sector: 'Engineering', cap: 'mid' },
  { symbol: 'CHAMBLSHR.NS',  name: 'Chambal Fertilisers',       sector: 'Materials', cap: 'mid' },
  { symbol: 'CONCOR.NS',     name: 'Container Corp of India',   sector: 'Infrastructure', cap: 'mid' },
  { symbol: 'CUMMINSIND.NS', name: 'Cummins India',             sector: 'Engineering', cap: 'mid' },
  { symbol: 'DELHIVERY.NS',  name: 'Delhivery Limited',         sector: 'Infrastructure', cap: 'mid' },
  { symbol: 'EXIDEIND.NS',   name: 'Exide Industries',          sector: 'Engineering', cap: 'mid' },
  { symbol: 'GLENMARK.NS',   name: 'Glenmark Pharma',           sector: 'Pharma', cap: 'mid' },
  { symbol: 'GUJGASLTD.NS',  name: 'Gujarat Gas',               sector: 'Energy', cap: 'mid' },
  { symbol: 'HUDCO.NS',      name: 'HUDCO',                     sector: 'Financials', cap: 'mid' },
  { symbol: 'IPCALAB.NS',    name: 'Ipca Laboratories',         sector: 'Pharma', cap: 'mid' },
  { symbol: 'JUBLFOOD.NS',   name: 'Jubilant FoodWorks',        sector: 'Consumer', cap: 'mid' },
  { symbol: 'LTTS.NS',       name: 'L&T Technology Services',   sector: 'IT', cap: 'mid' },
  { symbol: 'MANAPPURAM.NS', name: 'Manappuram Finance',        sector: 'NBFC', cap: 'mid' },
  { symbol: 'MGL.NS',        name: 'Mahanagar Gas',             sector: 'Energy', cap: 'mid' },
  { symbol: 'OFSS.NS',       name: 'Oracle Financial Services', sector: 'IT', cap: 'mid' },
  { symbol: 'OIL.NS',        name: 'Oil India Limited',         sector: 'Energy', cap: 'mid' },
  { symbol: 'PAGEIND.NS',    name: 'Page Industries',           sector: 'Consumer', cap: 'mid' },
  { symbol: 'PEL.NS',        name: 'Piramal Enterprises',       sector: 'NBFC', cap: 'mid' },
  { symbol: 'PETRONET.NS',   name: 'Petronet LNG',              sector: 'Energy', cap: 'mid' },
  { symbol: 'POLYCAB.NS',    name: 'Polycab India',             sector: 'Engineering', cap: 'mid' },
  { symbol: 'RAMCOMCEM.NS',  name: 'Ramco Cements',             sector: 'Cement', cap: 'mid' },
  { symbol: 'RBLBANK.NS',    name: 'RBL Bank',                  sector: 'Banking', cap: 'mid' },
  { symbol: 'SYNGENE.NS',    name: 'Syngene International',     sector: 'Pharma', cap: 'mid' },
  { symbol: 'TORNTPOWER.NS', name: 'Torrent Power',             sector: 'Utilities', cap: 'mid' },
  { symbol: 'UBL.NS',        name: 'United Breweries',          sector: 'Consumer', cap: 'mid' },
  { symbol: 'WHIRLPOOL.NS',  name: 'Whirlpool of India',        sector: 'Consumer', cap: 'mid' },
  { symbol: 'SONACOMS.NS',   name: 'Sona BLW Precision',        sector: 'Auto', cap: 'mid' },
  { symbol: 'DEVYANI.NS',    name: 'Devyani International',     sector: 'Consumer', cap: 'mid' },
  { symbol: 'POONAWALLA.NS', name: 'Poonawalla Fincorp',        sector: 'NBFC', cap: 'mid' },
  { symbol: 'ESCORT.NS',     name: 'Escorts Kubota',            sector: 'Auto', cap: 'mid' },
  { symbol: 'RAYMOND.NS',    name: 'Raymond Limited',           sector: 'Materials', cap: 'mid' },
  { symbol: 'KIMS.NS',       name: 'Krishna Institute of Med',  sector: 'Healthcare', cap: 'mid' },
  { symbol: 'MEDANTA.NS',    name: 'Global Health',             sector: 'Healthcare', cap: 'mid' },
  { symbol: 'NATCOPHARM.NS', name: 'Natco Pharma',              sector: 'Pharma', cap: 'mid' },
  { symbol: 'JBCHEPHARM.NS', name: 'J.B. Chemicals',            sector: 'Pharma', cap: 'mid' },
  { symbol: 'GLAXO.NS',      name: 'GlaxoSmithKline Pharma',    sector: 'Pharma', cap: 'mid' },
  { symbol: 'PFIZER.NS',     name: 'Pfizer Limited',            sector: 'Pharma', cap: 'mid' },
  { symbol: 'SANOFI.NS',     name: 'Sanofi India',              sector: 'Pharma', cap: 'mid' },

  // ── Small Cap ──
  { symbol: 'RPOWER.NS',     name: 'Reliance Power',            sector: 'Utilities', cap: 'small' },
  { symbol: 'ARVIND.NS',     name: 'Arvind Limited',            sector: 'Materials', cap: 'small' },
  { symbol: 'PCJEWELLER.NS', name: 'PC Jeweller',               sector: 'Consumer', cap: 'small' },
  { symbol: 'GTLINFRA.NS',   name: 'GTL Infrastructure',        sector: 'Telecom', cap: 'small' },
  { symbol: 'MOREPENLAB.NS', name: 'Morepen Laboratories',      sector: 'Healthcare', cap: 'small' },
  { symbol: 'SUVENPHAR.NS',  name: 'Suven Pharmaceuticals',     sector: 'Healthcare', cap: 'small' },
  { symbol: 'IRCON.NS',      name: 'Ircon International',       sector: 'Infrastructure', cap: 'small' },
  { symbol: 'PAYTM.NS',      name: 'One97 Communications',      sector: 'Consumer Tech', cap: 'small' },
  { symbol: 'NYKAA.NS',      name: 'FSN E-Commerce',            sector: 'Consumer Tech', cap: 'small' },
  { symbol: 'IDEA.NS',       name: 'Vodafone Idea',             sector: 'Telecom', cap: 'small' },
  { symbol: 'YESBANK.NS',    name: 'Yes Bank',                  sector: 'Banking', cap: 'small' },
  { symbol: 'TATAINVEST.NS', name: 'Tata Investment Corp',      sector: 'Financials', cap: 'small' },
  { symbol: 'ALOKINDS.NS',   name: 'Alok Industries',           sector: 'Materials', cap: 'small' },
  { symbol: 'ANGELONE.NS',   name: 'Angel One',                 sector: 'Financials', cap: 'small' },
  { symbol: 'AVANTIFEED.NS', name: 'Avanti Feeds',              sector: 'FMCG', cap: 'small' },
  { symbol: 'NETWORK18.NS',  name: 'Network18 Media',           sector: 'Consumer', cap: 'small' },
  { symbol: 'BIRLACORPN.NS', name: 'Birla Corporation',         sector: 'Cement', cap: 'small' },
  { symbol: 'CAMPUS.NS',     name: 'Campus Activewear',         sector: 'Consumer', cap: 'small' },
  { symbol: 'CERA.NS',       name: 'Cera Sanitaryware',         sector: 'Materials', cap: 'small' },
  { symbol: 'CSBBANK.NS',    name: 'CSB Bank',                  sector: 'Banking', cap: 'small' },
  { symbol: 'DATAPATTERNS.NS', name: 'Data Patterns India',     sector: 'Engineering', cap: 'small' },
  { symbol: 'EASEMYTRIP.NS', name: 'Easy Trip Planners',        sector: 'Consumer', cap: 'small' },
  { symbol: 'EIDPARRY.NS',   name: 'E.I.D. Parry India',        sector: 'FMCG', cap: 'small' },
  { symbol: 'ELGIEQUIP.NS',  name: 'Elgi Equipments',           sector: 'Engineering', cap: 'small' },
  { symbol: 'FILATEX.NS',    name: 'Filatex India',             sector: 'Materials', cap: 'small' },
  { symbol: 'FINPIPE.NS',    name: 'Finolex Industries',        sector: 'Materials', cap: 'small' },
  { symbol: 'GODREJIND.NS',  name: 'Godrej Industries',         sector: 'Conglomerate', cap: 'small' },
  { symbol: 'GPIL.NS',       name: 'Godawari Power',            sector: 'Metals', cap: 'small' },
  { symbol: 'GREAVESCOT.NS', name: 'Greaves Cotton',            sector: 'Engineering', cap: 'small' },
  { symbol: 'HFCL.NS',       name: 'HFCL Limited',              sector: 'Telecom', cap: 'small' },
  { symbol: 'HGS.NS',        name: 'Hinduja Global Solutions',  sector: 'IT', cap: 'small' },
  { symbol: 'INDIACEM.NS',   name: 'The India Cements',         sector: 'Cement', cap: 'small' },
  { symbol: 'INFIBEAM.NS',   name: 'Infibeam Avenues',          sector: 'Consumer Tech', cap: 'small' },
  { symbol: 'IONEXCHANG.NS', name: 'Ion Exchange India',        sector: 'Engineering', cap: 'small' },
  { symbol: 'J&KBANK.NS',    name: 'Jammu & Kashmir Bank',      sector: 'Banking', cap: 'small' },
  { symbol: 'JKTYRE.NS',     name: 'JK Tyre & Industries',      sector: 'Auto', cap: 'small' },
  { symbol: 'KSCL.NS',       name: 'Kaveri Seed Company',       sector: 'FMCG', cap: 'small' },
  { symbol: 'KRBL.NS',       name: 'KRBL Limited',              sector: 'FMCG', cap: 'small' },
  { symbol: 'MARKSANS.NS',   name: 'Marksans Pharma',           sector: 'Pharma', cap: 'small' },
  { symbol: 'MASTEK.NS',     name: 'Mastek Limited',            sector: 'IT', cap: 'small' },
  { symbol: 'NBCC.NS',       name: 'NBCC India',                sector: 'Infrastructure', cap: 'small' },
  { symbol: 'NCC.NS',        name: 'NCC Limited',               sector: 'Infrastructure', cap: 'small' },
  { symbol: 'NOCIL.NS',      name: 'NOCIL Limited',             sector: 'Materials', cap: 'small' },
  { symbol: 'PPLPHARMA.NS',  name: 'Piramal Pharma',            sector: 'Pharma', cap: 'small' },
  { symbol: 'RAILTEL.NS',    name: 'RailTel Corporation',       sector: 'Telecom', cap: 'small' },
  { symbol: 'RENUKA.NS',     name: 'Shree Renuka Sugars',       sector: 'FMCG', cap: 'small' },
  { symbol: 'SANSERA.NS',    name: 'Sansera Engineering',       sector: 'Engineering', cap: 'small' },
  { symbol: 'SHOPERSTOP.NS', name: 'Shoppers Stop',             sector: 'Consumer', cap: 'small' },
  { symbol: 'SPARC.NS',      name: 'Sun Pharma Advanced Res',   sector: 'Pharma', cap: 'small' },
  { symbol: 'SUBEXLTD.NS',   name: 'Subex Limited',             sector: 'IT', cap: 'small' },
  { symbol: 'SURYAROSNI.NS', name: 'Surya Roshni',              sector: 'Engineering', cap: 'small' },
  { symbol: 'TEJASNET.NS',   name: 'Tejas Networks',            sector: 'Telecom', cap: 'small' },
  { symbol: 'TRIDENT.NS',    name: 'Trident Limited',           sector: 'Materials', cap: 'small' },
  { symbol: 'TV18BRDCAST.NS', name: 'TV18 Broadcast',           sector: 'Consumer', cap: 'small' },
  { symbol: 'UCOBANK.NS',    name: 'UCO Bank',                  sector: 'Banking', cap: 'small' },
  { symbol: 'VIPIND.NS',     name: 'VIP Industries',            sector: 'Consumer', cap: 'small' },
  { symbol: 'WELSPUNLIV.NS', name: 'Welspun Living',            sector: 'Materials', cap: 'small' },
  { symbol: 'ZEEL.NS',       name: 'Zee Entertainment',         sector: 'Consumer', cap: 'small' }
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
  { symbol: 'CLOV',  name: 'Clover Health',            sector: 'Healthcare', cap: 'small' },
  { symbol: 'BRK-B', name: 'Berkshire Hathaway Inc.',   sector: 'Financials', cap: 'large' },
  { symbol: 'LLY',   name: 'Eli Lilly & Co.',          sector: 'Healthcare', cap: 'large' },
  { symbol: 'UNH',   name: 'UnitedHealth Group Inc.',  sector: 'Healthcare', cap: 'large' },
  { symbol: 'XOM',   name: 'Exxon Mobil Corp.',        sector: 'Energy', cap: 'large' },
  { symbol: 'CVX',   name: 'Chevron Corp.',            sector: 'Energy', cap: 'large' },
  { symbol: 'JNJ',   name: 'Johnson & Johnson',        sector: 'Healthcare', cap: 'large' },
  { symbol: 'MRK',   name: 'Merck & Co. Inc.',         sector: 'Healthcare', cap: 'large' },
  { symbol: 'COST',  name: 'Costco Wholesale Corp.',   sector: 'Consumer', cap: 'large' },
  { symbol: 'PEP',   name: 'PepsiCo Inc.',             sector: 'Consumer', cap: 'large' },
  { symbol: 'KO',    name: 'The Coca-Cola Co.',        sector: 'Consumer', cap: 'large' },
  { symbol: 'ADBE',  name: 'Adobe Inc.',               sector: 'Technology', cap: 'large' },
  { symbol: 'CRM',   name: 'Salesforce Inc.',          sector: 'Technology', cap: 'large' },
  { symbol: 'AVGO',  name: 'Broadcom Inc.',            sector: 'Technology', cap: 'large' },
  { symbol: 'QCOM',  name: 'Qualcomm Inc.',            sector: 'Technology', cap: 'large' },
  { symbol: 'TXN',   name: 'Texas Instruments Inc.',   sector: 'Technology', cap: 'large' },
  { symbol: 'INTC',  name: 'Intel Corp.',              sector: 'Technology', cap: 'large' },
  { symbol: 'CSCO',  name: 'Cisco Systems Inc.',       sector: 'Technology', cap: 'large' },
  { symbol: 'BAC',   name: 'Bank of America Corp.',    sector: 'Financials', cap: 'large' },
  { symbol: 'MS',    name: 'Morgan Stanley',           sector: 'Financials', cap: 'large' },
  { symbol: 'GS',    name: 'The Goldman Sachs Group',  sector: 'Financials', cap: 'large' },
  { symbol: 'NKE',   name: 'Nike Inc.',                sector: 'Consumer', cap: 'large' },
  { symbol: 'SBUX',  name: 'Starbucks Corp.',          sector: 'Consumer', cap: 'large' },
  { symbol: 'MCD',   name: "McDonald's Corp.",         sector: 'Consumer', cap: 'large' },
  { symbol: 'CAT',   name: 'Caterpillar Inc.',         sector: 'Industrials', cap: 'large' },
  { symbol: 'GE',    name: 'General Electric Co.',     sector: 'Industrials', cap: 'large' },
  { symbol: 'HON',   name: 'Honeywell International',  sector: 'Industrials', cap: 'large' },
  { symbol: 'UPS',   name: 'United Parcel Service',    sector: 'Industrials', cap: 'large' },
  { symbol: 'T',     name: 'AT&T Inc.',                sector: 'Telecom', cap: 'large' },
  { symbol: 'VZ',    name: 'Verizon Communications',   sector: 'Telecom', cap: 'large' },
  { symbol: 'TMUS',  name: 'T-Mobile US Inc.',         sector: 'Telecom', cap: 'large' },
  { symbol: 'AMT',   name: 'American Tower Corp.',     sector: 'Real Estate', cap: 'large' },
  { symbol: 'PLD',   name: 'Prologis Inc.',            sector: 'Real Estate', cap: 'large' },
  { symbol: 'NEE',   name: 'NextEra Energy Inc.',      sector: 'Utilities', cap: 'large' },
  { symbol: 'DUK',   name: 'Duke Energy Corp.',        sector: 'Utilities', cap: 'large' },
  { symbol: 'SO',    name: 'Southern Co.',             sector: 'Utilities', cap: 'large' },
  { symbol: 'BABA',  name: 'Alibaba Group Holding',    sector: 'Consumer', cap: 'large' },
  { symbol: 'PDD',   name: 'PDD Holdings Inc.',        sector: 'Consumer', cap: 'large' },
  { symbol: 'JD',    name: 'JD.com Inc.',              sector: 'Consumer', cap: 'large' },
  { symbol: 'COIN',  name: 'Coinbase Global Inc.',     sector: 'Financials', cap: 'mid' },
  { symbol: 'SQ',    name: 'Block Inc.',               sector: 'Financials', cap: 'mid' },
  { symbol: 'PYPL',  name: 'PayPal Holdings Inc.',     sector: 'Financials', cap: 'mid' },
  { symbol: 'UBER',  name: 'Uber Technologies Inc.',   sector: 'Consumer', cap: 'mid' },
  { symbol: 'LYFT',  name: 'Lyft Inc.',                sector: 'Consumer', cap: 'mid' },
  { symbol: 'ABNB',  name: 'Airbnb Inc.',              sector: 'Consumer', cap: 'mid' },
  { symbol: 'DASH',  name: 'DoorDash Inc.',            sector: 'Consumer', cap: 'mid' },
  { symbol: 'RBLX',  name: 'Roblox Corp.',             sector: 'Consumer', cap: 'mid' },
  { symbol: 'PINS',  name: 'Pinterest Inc.',           sector: 'Technology', cap: 'mid' },
  { symbol: 'ETSY',  name: 'Etsy Inc.',                sector: 'Consumer', cap: 'mid' },
  { symbol: 'NET',   name: 'Cloudflare Inc.',          sector: 'Technology', cap: 'mid' },
  { symbol: 'DDOG',  name: 'Datadog Inc.',             sector: 'Technology', cap: 'mid' },
  { symbol: 'CRWD',  name: 'CrowdStrike Holdings',     sector: 'Technology', cap: 'mid' },
  { symbol: 'OKTA',  name: 'Okta Inc.',                sector: 'Technology', cap: 'mid' },
  { symbol: 'MDB',   name: 'MongoDB Inc.',             sector: 'Technology', cap: 'mid' },
  { symbol: 'SNOW',  name: 'Snowflake Inc.',           sector: 'Technology', cap: 'mid' },
  { symbol: 'DOCU',  name: 'DocuSign Inc.',            sector: 'Technology', cap: 'mid' },
  { symbol: 'ZM',    name: 'Zoom Video Comm.',         sector: 'Technology', cap: 'mid' },
  { symbol: 'TWLO',  name: 'Twilio Inc.',              sector: 'Technology', cap: 'mid' },
  { symbol: 'U',     name: 'Unity Software Inc.',      sector: 'Technology', cap: 'mid' },
  { symbol: 'SHOP',  name: 'Shopify Inc.',             sector: 'Consumer', cap: 'mid' },
  { symbol: 'SPOT',  name: 'Spotify Technology S.A.',  sector: 'Consumer', cap: 'mid' },
  { symbol: 'DKNG',  name: 'DraftKings Inc.',          sector: 'Consumer', cap: 'mid' },
  { symbol: 'PTON',  name: 'Peloton Interactive',      sector: 'Consumer', cap: 'mid' },
  { symbol: 'AFRM',  name: 'Affirm Holdings Inc.',     sector: 'Financials', cap: 'mid' },
  { symbol: 'LCID',  name: 'Lucid Group Inc.',         sector: 'Auto', cap: 'mid' },
  { symbol: 'RIVN',  name: 'Rivian Automotive Inc.',   sector: 'Auto', cap: 'mid' },
  { symbol: 'SOFI',  name: 'SoFi Technologies',        sector: 'Financials', cap: 'small' },
  { symbol: 'CHPT',  name: 'ChargePoint Holdings',     sector: 'Industrials', cap: 'small' },
  { symbol: 'BLNK',  name: 'Blink Charging Co.',       sector: 'Industrials', cap: 'small' },
  { symbol: 'RUN',   name: 'Sunrun Inc.',              sector: 'Renewables', cap: 'small' },
  { symbol: 'SPWR',  name: 'SunPower Corp.',           sector: 'Renewables', cap: 'small' },
  { symbol: 'NIO',   name: 'NIO Inc.',                 sector: 'Auto', cap: 'small' },
  { symbol: 'WKHS',  name: 'Workhorse Group Inc.',     sector: 'Auto', cap: 'small' },
  { symbol: 'NKLA',  name: 'Nikola Corp.',             sector: 'Auto', cap: 'small' },
  { symbol: 'OPEN',  name: 'Opendoor Technologies',    sector: 'Real Estate', cap: 'small' },
  { symbol: 'RDFN',  name: 'Redfin Corp.',             sector: 'Real Estate', cap: 'small' },
  { symbol: 'JMIA',  name: 'Jumia Technologies AG',    sector: 'Consumer', cap: 'small' },
  { symbol: 'UPST',  name: 'Upstart Holdings Inc.',    sector: 'Financials', cap: 'small' },
  { symbol: 'MARA',  name: 'Marathon Digital Holdings', sector: 'Technology', cap: 'small' },
  { symbol: 'RIOT',  name: 'Riot Platforms Inc.',      sector: 'Technology', cap: 'small' },
  { symbol: 'HUT',   name: 'Hut 8 Corp.',              sector: 'Technology', cap: 'small' }
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

// Helper: Calculate 200 SMA on Index to determine Market Regime
async function getIndexRegime(symbol) {
  const cacheKey = `regime_${symbol}`;
  const cached = appCache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 4000
    });
    const result = response.data?.chart?.result?.[0];
    if (!result) throw new Error('No chart data found');

    const quotes = result.indicators?.quote?.[0] || {};
    const closes = quotes.close || [];
    const validCloses = closes.filter(c => typeof c === 'number');

    if (validCloses.length < 200) {
      throw new Error(`Insufficient historical bars (${validCloses.length}) to compute 200 SMA`);
    }

    const currentPrice = result.meta?.regularMarketPrice || validCloses[validCloses.length - 1];
    const last200 = validCloses.slice(-200);
    const sum = last200.reduce((acc, val) => acc + val, 0);
    const sma200 = sum / 200;

    const regimeObj = {
      price: currentPrice,
      sma200: sma200,
      regime: currentPrice >= sma200 ? 'bull' : 'bear'
    };

    // Cache for 12 hours (43200 seconds)
    appCache.set(cacheKey, regimeObj, 43200);
    return regimeObj;
  } catch (err) {
    console.error(`Failed to calculate market regime for ${symbol}:`, err.message);
    return { price: 0, sma200: 0, regime: 'bull' };
  }
}

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
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
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

    // Fetch index regime
    const regimeIndexSym = market === 'US' ? '^GSPC' : '^NSEI';
    const regime = await getIndexRegime(regimeIndexSym);

    const payload = { indices, fearGreed, regime, timestamp: new Date().toISOString() };
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
    const systemInstructionText = `Act as a Quantitative Hedge Fund Strategist. Your objective is to provide high-conviction, data-driven analysis for swing trading.

Rules for Interaction:
1. Data-First: When asked about a stock, prioritize technicals (RSI, Volume, EMA levels, Bollinger bands, ATR, MACD) over sentiment. Never give a 'generic' bullish/bearish answer.
2. Professional Structure: Always format stock analysis responses exactly as follows in clean markdown:

Status: [Buy/Hold/Sell/Watch]

Technical Thesis:
- [Data-backed point 1: Price action, EMAs, Support/Resistance]
- [Data-backed point 2: RSI momentum & MACD trend]
- [Data-backed point 3: Bollinger width & Volume spike activity]

Risk/Reward:
- Entry: [Price]
- Stop-Loss: [Logical Stop-Loss price level based on current chart volatility]
- Target 1 & 2: [Logical Target price levels]
- Risk/Reward Ratio: [e.g. 2.1:1]

Institutional Context:
[Brief analysis of whether smart money flows and volume accumulation indicate institutions are entering or exiting.]

Next Action:
[Clear, actionable instruction, e.g. "Await breakout above $X" or "Exit if $Y level fails".]

Source Citations:
[Always provide a direct link to the news source for any fundamental or news-based claims made (e.g. "Company news on MarketWatch [link]"). If no news is available, state "No recent news catalyst cited."]

3. Efficiency: Minimize token usage by using concise, high-density professional trading terminology. Do not explain basic concepts unless explicitly asked.
4. For general trading questions (e.g. "Explain RSI"), explain the concept concisely, in 1-2 paragraphs using professional quantitative trader terminology.`;

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
      const composite = scores.composite || { total: 0 };
      const momentum = scores.momentum?.indicators || {};
      const technicalSetup = scores.technicalSetup?.indicators || {};
      const bollinger = technicalSetup.bollinger || {};
      const pivots = technicalSetup.pivots || {};
      
      const isUS = !symbol.endsWith('.NS') && !symbol.endsWith('.BO');
      const cSym = isUS ? '$' : '₹';

      let ragContext = `[LIVE TECHNICAL RAG DATA FOR ${currentStockContext.name} (${symbol})]:
- Price: ${cSym}${(quote.price || 0).toFixed(2)} (Daily Change: ${(quote.changePct || 0).toFixed(2)}%)
- RSI-14: ${(momentum.rsi || 0).toFixed(1)} (${momentum.rsi < 30 ? 'Oversold' : momentum.rsi > 70 ? 'Overbought' : 'Neutral'})
- MACD Line: ${(momentum.macd || 0).toFixed(4)} | Signal: ${(momentum.macdSignal || 0).toFixed(4)} | Histogram: ${(momentum.macdHist || 0).toFixed(4)} (Crossed: ${momentum.macdCrossover ? 'Fresh Bullish Crossover' : 'No Crossover'})
- Moving Averages: SMA20: ${cSym}${(technicalSetup.sma20 || 0).toFixed(2)} | SMA50: ${cSym}${(technicalSetup.sma50 || 0).toFixed(2)} | SMA200: ${cSym}${(technicalSetup.sma200 || 0).toFixed(2)} (Trend: ${technicalSetup.trend || 'Sideways'})
- Bollinger Bands: Upper: ${cSym}${(bollinger.upper || 0).toFixed(2)} | Mid: ${cSym}${(bollinger.mid || 0).toFixed(2)} | Lower: ${cSym}${(bollinger.lower || 0).toFixed(2)} | Width: ${bollinger.bandwidth ? (bollinger.bandwidth * 100).toFixed(1) + '%' : 'N/A'} (Squeeze: ${bollinger.bandwidth < 0.1 ? 'Active' : 'No'})
- Volume Flow: Current Vol: ${quote.volume || 'N/A'} | 30-Day Avg Vol: ${quote.avgVolume || 'N/A'} | Ratio: ${(quote.volume / (quote.avgVolume || 1)).toFixed(2)}x (Volume Spike: ${quote.volume / (quote.avgVolume || 1) >= 1.5 ? 'Active' : 'No'})
- ATR-14 Volatility: ${(tradeSetup.atr || 0).toFixed(2)}
- Daily Pivots: Pivot Point: ${cSym}${(pivots.pivot || 0).toFixed(2)} | S1: ${cSym}${(pivots.s1 || 0).toFixed(2)} | R1: ${cSym}${(pivots.r1 || 0).toFixed(2)}
- 5-Pillar Scores: Fundamentals: ${scores.fundamental?.score || 0}/25 | Technicals: ${scores.technicalSetup?.score || 0}/20 | Momentum: ${scores.momentum?.score || 0}/20 | News & Sentiment: ${scores.sentiment?.score || 0}/15 | Institutional Flows: ${scores.institutional?.score || 0}/20 (Total Composite: ${composite.total}/100, Rating: ${composite.rating || 'N/A'})
- Logical Setup Parameters: Stop Loss: ${cSym}${tradeSetup.stopLoss || 'N/A'} | Target 1: ${cSym}${tradeSetup.target1 || 'N/A'} | Target 2: ${cSym}${tradeSetup.target2 || 'N/A'} | Risk/Reward: ${tradeSetup.riskReward || 'N/A'}:1
`;

      const news = currentStockContext.news || [];
      if (news.length > 0) {
        ragContext += `- Recent News Catalysts:\n`;
        news.slice(0, 3).forEach((n, idx) => {
          ragContext += `  * Article ${idx + 1}: "${n.title}" | Source: ${n.source || 'News'} | Link: ${n.link || 'N/A'}\n    Summary: ${n.summary || 'N/A'}\n`;
        });
      } else {
        ragContext += `- Recent News Catalysts: None available.\n`;
      }

      messageWithContext = `${summaryText}
${ragContext}
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
        maxOutputTokens: 600,
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
// NEXUS ROBO-ADVISORY — AI WEALTH MATRIX ENDPOINT
// ============================================================

app.post('/api/nexus-profile', authMiddleware, async (req, res) => {
  const { age, profession, incomeStability, dependents, netIncome, capitalAllocation, riskAppetite, behavioralStressResponse } = req.body;
  const email = req.user?.email || 'unknown';

  if (!age || !riskAppetite) {
    return res.status(400).json({ error: 'Profile data incomplete.' });
  }

  await logToDatabase(email, 'nexus_profile', null, `Nexus profile generated: ${riskAppetite}, age ${age}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AI service unavailable. GEMINI_API_KEY not configured.' });
  }

  const investmentHorizon = age < 30 ? '20+ years' : age < 45 ? '10-20 years' : age < 60 ? '5-10 years' : '1-5 years';
  const sipSuggestion = Math.round((netIncome || 0) * (riskAppetite === 'Aggressive' ? 0.30 : riskAppetite === 'Moderate' ? 0.20 : 0.10));

  const systemPrompt = `You are Nexus, an elite AI wealth advisor at a top Indian private bank. Generate a precise, data-driven wealth matrix for this client. Be direct, professional, and specific. Use Indian financial context (NSE/BSE, Indian MF categories, INR).`;

  const userPrompt = `Client Profile:
- Age: ${age} | Profession: ${profession} | Income Stability: ${incomeStability}
- Dependents: ${dependents} | Net Monthly Income: ₹${(netIncome || 0).toLocaleString('en-IN')}
- Allocated Trading Capital: ₹${(capitalAllocation || 0).toLocaleString('en-IN')}
- Risk Appetite: ${riskAppetite} | Stress Response: ${behavioralStressResponse}
- Investment Horizon: ${investmentHorizon}
- Suggested Monthly SIP: ₹${sipSuggestion.toLocaleString('en-IN')}

Generate a complete wealth matrix with these exact sections:

## Risk Profile
One sentence summary of this investor's profile and behavioral type.

## Asset Allocation
Exact % split: Large Cap Equity / Mid+Small Cap Equity / Debt (MF/FD) / Gold (SGB/ETF) / Cash Reserve. Show as bullet list.

## Equity Sector Weights
For the equity portion, give top 5 sectors with % weight. E.g. Banking & NBFC: 25%.

## Monthly SIP Plan
Recommend exact SIP amounts across 3-4 categories from the ₹${sipSuggestion.toLocaleString('en-IN')} monthly budget.

## Crash Scenario (20% Market Fall)
What happens to this portfolio in a 20% NIFTY drawdown. Specific ₹ impact on ₹${(capitalAllocation || 0).toLocaleString('en-IN')} capital. What action to take.

## 3 Trading Rules For This Profile
Specific rules based on risk appetite and behavioral stress response.

Keep each section concise. No disclaimers. No generic advice.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const response = await axios.post(url, {
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      system_instruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: 900, temperature: 0.6 }
    });

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('No content from Gemini');

    res.json({ analysis: text, profile: riskAppetite, horizon: investmentHorizon, sipSuggestion });
  } catch (err) {
    console.error('Nexus profile error:', err.message);
    res.status(500).json({ error: 'Failed to generate wealth matrix.', details: err.message });
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

  // For WhatsApp, format as: [TICKER] | [ACTION] | [ENTRY/EXIT] | [STOP LOSS] | [REASONING]
  const waMsg = `[${symbol.toUpperCase()}] | [EXIT (${status})] | [Exit Price ${cSym}${currentPrice.toFixed(2)} / Target ${cSym}${target2.toFixed(2)}] | [Stop Loss ${cSym}${stopLoss.toFixed(2)}] | [Closed via ${status === 'WIN' ? 'Target Hit' : status === 'LOSS' ? 'Stop Loss Hit' : 'Time Decay'}]`;

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
      const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(cleanPhone)}&text=${encodeURIComponent(waMsg)}&apikey=${encodeURIComponent(settings.whatsapp_apikey)}`;
      await axios.get(waUrl, { timeout: 8000 });
      console.log(`Dispatched real WhatsApp status update for ${symbol} (${status})`);
    } catch (err) {
      console.error(`Failed to send WhatsApp status update alert for ${symbol}:`, err.message);
    }
  }
}

async function sendNewSignalNotification(symbol, entryPrice, targetPrice, stopLoss, score) {
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
  const alertMsg = `📈 *NEW SWING TRADE SIGNAL* 📈\n\n` +
    `*Stock:* ${symbol.toUpperCase()}\n` +
    `*Action:* BUY / ACCUMULATE\n` +
    `*Entry Price:* ${cSym}${entryPrice.toFixed(2)}\n` +
    `*Stop Loss:* ${cSym}${stopLoss.toFixed(2)}\n` +
    `*Target:* ${cSym}${targetPrice.toFixed(2)}\n\n` +
    `*Rationale:* Quant Screen Confluence (Score: ${score}/100)`;

  // Keyless WhatsApp dispatch template format: [TICKER] | [ACTION] | [ENTRY/EXIT] | [STOP LOSS] | [REASONING]
  const waMsg = `[${symbol.toUpperCase()}] | [BUY] | [Entry ${cSym}${entryPrice.toFixed(2)} / Target ${cSym}${targetPrice.toFixed(2)}] | [Stop Loss ${cSym}${stopLoss.toFixed(2)}] | [Confluence Score ${score}/100]`;

  // Send Telegram
  if (settings.telegram_enabled && settings.telegram_chat_id && settings.telegram_bot_token) {
    try {
      const tgUrl = `https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`;
      await axios.post(tgUrl, {
        chat_id: settings.telegram_chat_id,
        text: alertMsg,
        parse_mode: 'Markdown'
      }, { timeout: 8000 });
      console.log(`Dispatched real Telegram alert for new signal: ${symbol}`);
    } catch (err) {
      console.error(`Failed to send Telegram alert for new signal:`, err.message);
    }
  }

  // Send WhatsApp via CallMeBot
  if (settings.whatsapp_enabled && settings.whatsapp_phone && settings.whatsapp_apikey) {
    try {
      const cleanPhone = settings.whatsapp_phone.replace(/\+/g, '').trim();
      const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(cleanPhone)}&text=${encodeURIComponent(waMsg)}&apikey=${encodeURIComponent(settings.whatsapp_apikey)}`;
      await axios.get(waUrl, { timeout: 8000 });
      console.log(`Dispatched real WhatsApp alert for new signal: ${symbol}`);
    } catch (err) {
      console.error(`Failed to send WhatsApp alert for new signal:`, err.message);
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

      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS trade_signals (
          id SERIAL PRIMARY KEY,
          symbol VARCHAR(20) NOT NULL,
          signal_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          entry_price DECIMAL(12, 2) NOT NULL,
          target_price DECIMAL(12, 2) NOT NULL,
          stop_loss DECIMAL(12, 2) NOT NULL,
          status VARCHAR(20) DEFAULT 'ACTIVE',
          exit_price DECIMAL(12, 2),
          exit_date TIMESTAMP,
          exit_rule VARCHAR(50),
          composite_score INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await dbPool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_signals_unique 
        ON trade_signals (symbol) 
        WHERE (status = 'ACTIVE');
      `);

      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS user_broker_connections (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          broker_name VARCHAR(50) NOT NULL,
          encrypted_access_token TEXT NOT NULL,
          encrypted_api_key TEXT,
          iv VARCHAR(32) NOT NULL,
          auth_tag VARCHAR(32) NOT NULL,
          token_expiry TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT unique_user_broker UNIQUE (user_id, broker_name)
        );
      `);

      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS user_holdings (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          symbol VARCHAR(20) NOT NULL,
          average_buy_price DECIMAL(12, 2) NOT NULL,
          quantity INTEGER NOT NULL,
          last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT unique_user_symbol UNIQUE (user_id, symbol)
        );
      `);
    } catch (err) {
      console.error('Failed to initialize database tables / indices:', err.message);
    }
  }
}


async function checkAndInsertSignal(symbol, entryPrice, score) {
  if (!dbPool) return;
  try {
    const activeCheck = await dbPool.query(
      "SELECT id FROM trade_signals WHERE symbol = $1 AND status = 'ACTIVE'",
      [symbol]
    );
    if (activeCheck.rows.length > 0) {
      console.log(`[Snapshot] Active signal already exists for ${symbol}. Skipping insertion.`);
      return;
    }

    const targetPrice = parseFloat((entryPrice * 1.15).toFixed(2)); // 15% profit target
    const stopLoss = parseFloat((entryPrice * 0.95).toFixed(2));    // 5% stop-loss
    
    await dbPool.query(
      `INSERT INTO trade_signals (symbol, entry_price, target_price, stop_loss, status, composite_score)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5)`,
      [symbol, entryPrice, targetPrice, stopLoss, score]
    );
    console.log(`[Snapshot] Generated Strong Buy signal for ${symbol} at entry price ${entryPrice} (Score: ${score})`);
    
    // Send live Telegram and WhatsApp notifications for the new signal
    sendNewSignalNotification(symbol, entryPrice, targetPrice, stopLoss, score).catch(err => {
      console.error(`Failed to send new signal notifications for ${symbol}:`, err.message);
    });
  } catch (err) {
    console.error(`[Snapshot] Failed to insert trade signal for ${symbol}:`, err.message);
  }
}

async function runDailyValidation() {
  if (!dbPool) {
    console.log("[Validation] Database pool not initialized. Cannot run validation.");
    return { status: "ignored", message: "Database not connected" };
  }

  console.log("[Validation] Starting daily trade signals validation run...");
  try {
    const res = await dbPool.query(
      "SELECT id, symbol, entry_price, target_price, stop_loss, signal_date FROM trade_signals WHERE status = 'ACTIVE'"
    );
    const activeSignals = res.rows;
    console.log(`[Validation] Found ${activeSignals.length} active trade signals to validate.`);

    let processed = 0;
    let stopLossHits = 0;
    let targetHits = 0;
    let expired = 0;

    for (const signal of activeSignals) {
      const { id, symbol, entry_price, target_price, stop_loss, signal_date } = signal;
      
      console.log(`[Validation] Processing ${symbol} (Entry: ${entry_price}, SL: ${stop_loss}, Target: ${target_price})...`);
      
      // Rate limit throttling delay
      await new Promise(resolve => setTimeout(resolve, 400));
      
      try {
        const histUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=60d`;
        const response = await axios.get(histUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 6000
        });
        const chartResult = response.data?.chart?.result?.[0];
        if (!chartResult) {
          console.warn(`[Validation] No chart data found for ${symbol}. Skipping.`);
          continue;
        }

        const timestamps = chartResult.timestamp || [];
        const quotes = chartResult.indicators.quote[0] || {};
        
        const dailyBars = timestamps.map((t, i) => ({
          date: new Date(t * 1000),
          open: quotes.open?.[i] || quotes.close?.[i] || 0,
          high: quotes.high?.[i] || quotes.close?.[i] || 0,
          low: quotes.low?.[i] || quotes.close?.[i] || 0,
          close: quotes.close?.[i] || 0,
        })).filter(d => d.close > 0);

        if (dailyBars.length === 0) {
          console.warn(`[Validation] No valid daily bars for ${symbol}. Skipping.`);
          continue;
        }

        const entryDate = new Date(signal_date);
        const latestBar = dailyBars[dailyBars.length - 1];

        // Process daily bars chronologically from the signal date onwards
        const relevantBars = dailyBars.filter(bar => bar.date >= entryDate);

        let exitStatus = null;
        let exitPrice = null;
        let exitRule = null;
        let exitDate = null;

        const sl = parseFloat(stop_loss);
        const tp = parseFloat(target_price);

        for (const bar of relevantBars) {
          const high = parseFloat(bar.high);
          const low = parseFloat(bar.low);
          
          const hitSL = low <= sl;
          const hitTP = high >= tp;

          if (hitSL && hitTP) {
            // Conflict resolution: Prioritize Stop Loss (conservative)
            exitStatus = 'STOP_LOSS_HIT';
            exitPrice = sl;
            exitRule = 'Stop Loss Hit';
            exitDate = bar.date;
            break;
          } else if (hitSL) {
            exitStatus = 'STOP_LOSS_HIT';
            exitPrice = sl;
            exitRule = 'Stop Loss Hit';
            exitDate = bar.date;
            break;
          } else if (hitTP) {
            exitStatus = 'TARGET_HIT';
            exitPrice = tp;
            exitRule = 'Target Hit';
            exitDate = bar.date;
            break;
          }
        }

        if (!exitStatus) {
          const now = new Date();
          const daysActive = (now - entryDate) / (1000 * 60 * 60 * 24);
          if (daysActive > 30) {
            exitStatus = 'EXPIRED';
            exitPrice = parseFloat(latestBar.close);
            exitRule = 'Time Decay';
            exitDate = now;
          }
        }

        if (exitStatus) {
          await dbPool.query(
            `UPDATE trade_signals 
             SET status = $1, exit_price = $2, exit_rule = $3, exit_date = $4, updated_at = NOW() 
             WHERE id = $5`,
            [exitStatus, exitPrice, exitRule, exitDate, id]
          );
          processed++;
          if (exitStatus === 'STOP_LOSS_HIT') stopLossHits++;
          else if (exitStatus === 'TARGET_HIT') targetHits++;
          else if (exitStatus === 'EXPIRED') expired++;
          
          console.log(`[Validation] Symbol ${symbol} resolved as ${exitStatus} (Rule: ${exitRule}, Price: ${exitPrice})`);

          // Send exit alert notification to Telegram / WhatsApp live
          sendAlertNotification(
            symbol,
            exitStatus === 'TARGET_HIT' ? 'WIN' : exitStatus === 'STOP_LOSS_HIT' ? 'LOSS' : 'EXPIRED',
            parseFloat(exitPrice),
            parseFloat(target_price),
            parseFloat(stop_loss)
          ).catch(err => {
            console.error(`Failed to send exit alert notification for ${symbol}:`, err.message);
          });
        } else {
          console.log(`[Validation] Symbol ${symbol} remains ACTIVE (Latest Price: ${latestBar.close})`);
        }

      } catch (err) {
        console.error(`[Validation] Failed to process ticker ${symbol}:`, err.message);
      }
    }

    console.log(`[Validation] Validation run completed. Resolved: ${processed}/${activeSignals.length} (SL Hits: ${stopLossHits}, Target Hits: ${targetHits}, Expired: ${expired})`);
    return {
      status: "success",
      total_active: activeSignals.length,
      resolved: processed,
      stop_loss_hits: stopLossHits,
      target_hits: targetHits,
      expired: expired
    };

  } catch (err) {
    console.error("[Validation] Cron job encountered an error:", err.message);
    throw err;
  }
}

function startLocalCron() {
  console.log("Scheduling local daily validation checker (runs every minute and triggers at 4:30 PM IST)...");
  setInterval(() => {
    try {
      const now = new Date();
      const options = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
      const formatter = new Intl.DateTimeFormat('en-US', options);
      const parts = formatter.formatToParts(now);
      
      const hour = parts.find(p => p.type === 'hour').value;
      const minute = parts.find(p => p.type === 'minute').value;

      if (hour === '16' && minute === '30') {
        const todayStr = now.toISOString().split('T')[0];
        if (global.lastCronRunDate !== todayStr) {
          global.lastCronRunDate = todayStr;
          console.log(`[Cron] Triggering daily validation run at 4:30 PM IST (Local Time: ${now.toISOString()})`);
          runDailyValidation().catch(err => {
            console.error("[Cron] Daily validation run failed:", err.message);
          });
        }
      }
    } catch (err) {
      console.error("[Cron] Scheduler check error:", err.message);
    }
  }, 60000);
}

async function screenNewRecommendation(symbol, name, sector, market) {
  try {
    const quote = await scraper.fetchQuote(symbol);
    if (!quote || !quote.price || quote.price === 0) return null;

    const histUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
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
          if (newRec.rating === 'STRONG BUY') {
            checkAndInsertSignal(newRec.symbol, newRec.price, 80).catch(err => {
              console.error(`Error inserting trade signal from recommendation:`, err.message);
            });
          }
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

// Route: Get performance stats for signals
app.get('/api/performance-stats', async (req, res) => {
  await initTables();
  if (!dbPool) {
    return res.json({
      active_count: 0,
      settled_count: 0,
      win_rate: 0.0,
      target_hit_count: 0,
      stop_loss_hit_count: 0,
      message: "Database not connected. Mock performance statistics returned."
    });
  }

  try {
    const activeRes = await dbPool.query(
      "SELECT COUNT(*) FROM trade_signals WHERE status = 'ACTIVE'"
    );
    const settledRes = await dbPool.query(
      "SELECT COUNT(*) FROM trade_signals WHERE status IN ('TARGET_HIT', 'STOP_LOSS_HIT', 'EXPIRED')"
    );
    const targetHitRes = await dbPool.query(
      "SELECT COUNT(*) FROM trade_signals WHERE status = 'TARGET_HIT'"
    );
    const stopLossHitRes = await dbPool.query(
      "SELECT COUNT(*) FROM trade_signals WHERE status = 'STOP_LOSS_HIT'"
    );

    const activeCount = parseInt(activeRes.rows[0].count);
    const settledCount = parseInt(settledRes.rows[0].count);
    const targetHitCount = parseInt(targetHitRes.rows[0].count);
    const stopLossHitCount = parseInt(stopLossHitRes.rows[0].count);

    const totalWinsAndLosses = targetHitCount + stopLossHitCount;
    const winRate = totalWinsAndLosses > 0 
      ? parseFloat(((targetHitCount / totalWinsAndLosses) * 100).toFixed(2))
      : 0.0;

    res.json({
      active_count: activeCount,
      settled_count: settledCount,
      win_rate: winRate,
      target_hit_count: targetHitCount,
      stop_loss_hit_count: stopLossHitCount
    });
  } catch (err) {
    console.error('Failed to query performance stats:', err.message);
    res.status(500).json({ error: 'Failed to retrieve performance statistics', details: err.message });
  }
});

// Route: Trigger manual/external cron validation
app.get('/api/cron-validate', async (req, res) => {
  await initTables();
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized: Invalid cron secret' });
    }
  } else {
    console.log('[Cron] No CRON_SECRET configured. Proceeding without auth check (for local development/debugging).');
  }

  try {
    const result = await runDailyValidation();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Cron validation failed', details: err.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

module.exports = app;
