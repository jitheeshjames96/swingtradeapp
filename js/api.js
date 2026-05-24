/* ============================================================
   API.JS — All data fetching logic
   Sources: Yahoo Finance (via CORS proxy), Fear & Greed API
   ============================================================ */

const CORS_PROXY = 'https://api.allorigins.win/get?url=';
const YAHOO_BASE = 'https://query1.finance.yahoo.com';
const YAHOO_CHART = 'https://query2.finance.yahoo.com';

// Fetch helper with AbortController timeout protection
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 6000, ...rest } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, { ...rest, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

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
    const res = await fetchWithTimeout(`${BACKEND_URL}/api/auth/config`, { timeout: 2000 });
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
      if (!res.ok) return false;
      const data = await res.json();
      return data && (data.status === 'healthy' || data.status === 'success');
    } catch (e) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1200);
        const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) return false;
        const data = await res.json();
        return data && (data.status === 'healthy' || data.status === 'success');
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
  const LS_KEY = `swing_cache_${symbol}`;
  const LS_TTL = 10 * 60 * 1000; // 10 minutes localStorage cache

  // Return cached data instantly if available (stale-while-revalidate)
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    try {
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts < LS_TTL) {
        // Data is fresh — no network call needed
        console.log(`[cache] Serving fresh localStorage data for ${symbol}`);
        return data;
      }
      // Data is stale but still usable — return it but don't block the caller
      // The caller will get this quickly, then we refresh in background
      console.log(`[cache] Serving stale localStorage data for ${symbol}, refreshing in background...`);
      fetchAndCacheAnalysis(symbol).catch(() => {}); // background refresh
      return data;
    } catch (_) { /* corrupted cache — fall through */ }
  }

  // No cache at all — do a blocking fetch
  return fetchAndCacheAnalysis(symbol);
}

async function fetchAndCacheAnalysis(symbol) {
  const LS_KEY = `swing_cache_${symbol}`;
  try {
    // 55 second timeout: Screener.in scraping from Vercel US servers takes 20-60s
    const res = await fetchWithTimeout(`${BACKEND_URL}/api/analyze?symbol=${encodeURIComponent(symbol)}`, {
      headers: getAuthHeaders(),
      timeout: 55000
    });
    // Always parse JSON so we can read error messages from backend
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
      // Return error object so analyzeStock can detect it (don't throw here)
      return { error: data.error || `HTTP ${res.status}`, details: data.details || '' };
    }
    // Cache successful results in localStorage
    try { localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), data })); } catch (_) {}
    return data;
  } catch (err) {
    return { error: 'Network timeout / error', details: err.message };
  }
}

async function fetchMarketPulseFromBackend() {
  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  const res = await fetchWithTimeout(`${BACKEND_URL}/api/market-pulse?market=${mode}`, {
    headers: getAuthHeaders(),
    timeout: 5000
  });
  if (!res.ok) throw new Error(`Backend error: ${res.status}`);
  return await res.json();
}

async function fetchMarketSummary() {
  const isBackend = await checkBackend();
  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  if (isBackend) {
    try {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/market-summary?market=${mode}`, {
        headers: getAuthHeaders(),
        timeout: 10000
      });
      if (res.ok) {
        return await res.json();
      }
      console.warn(`Backend /api/market-summary returned HTTP ${res.status}, using client fallback`);
    } catch (e) {
      console.warn('Failed to fetch market summary from backend:', e.message);
    }
  }

  // Client-side fallback: fetch core 12 representative stocks
  const coreSymbols = [
    'RELIANCE.NS', 'TCS.NS', 'INFY.NS', 'HDFCBANK.NS', 'ICICIBANK.NS',
    'SUNPHARMA.NS', 'LT.NS', 'HINDUNILVR.NS', 'POWERGRID.NS', 'SUZLON.NS',
    'BHARTIARTL.NS', 'TRENT.NS'
  ];

  console.log('Using client fallback for market summary, fetching 12 core stocks...');
  try {
    const quotes = await Promise.all(coreSymbols.map(async (symbol) => {
      try {
        const q = await fetchQuote(symbol);
        const catItem = STOCK_CATALOG.find(s => s.symbol === symbol);
        return {
          ...q,
          name: catItem ? catItem.name : symbol,
          sector: catItem ? catItem.sector : ''
        };
      } catch (err) {
        console.warn(`Client fallback quote fetch failed for ${symbol}:`, err.message);
        return null;
      }
    }));

    const validQuotes = quotes.filter(Boolean);

    // Sort for gainers & losers
    const sortedByChange = [...validQuotes]
      .filter(q => typeof q.changePct === 'number')
      .sort((a, b) => b.changePct - a.changePct);

    const gainers = sortedByChange.slice(0, 5).map(q => ({
      symbol: q.symbol,
      name: q.name,
      quote: { price: q.price, change: q.change, changePct: q.changePct }
    }));

    const losers = [...sortedByChange].reverse().slice(0, 5).map(q => ({
      symbol: q.symbol,
      name: q.name,
      quote: { price: q.price, change: q.change, changePct: q.changePct }
    }));

    const sectors = [];
    const localGetEtfSector = (stockSector) => {
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
      if (s.includes('renewable') || s.includes('wind') || s.includes('solar') || s.includes('green')) {
        return 'Renewables';
      }
      if (s.includes('energy')) {
        return 'Energy';
      }
      if (s.includes('telecom') || s.includes('telco')) {
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
    };

    for (const etf of SECTOR_MAP) {
      const sectorStocks = validQuotes.filter(q => localGetEtfSector(q.sector) === etf.name);
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

      // Compute average of sector's stocks as ETF fallback if direct quote fails
      let etfChange = 0;
      let etfPrice = 0;
      try {
        const etfQuote = await fetchQuote(etf.symbol);
        if (etfQuote && !etfQuote.isMock) {
          etfChange = etfQuote.changePct || 0;
          etfPrice = etfQuote.price || 0;
        } else if (sectorStocks.length > 0) {
          etfChange = sectorStocks.reduce((sum, q) => sum + (q.changePct || 0), 0) / sectorStocks.length;
          etfPrice = sectorStocks[0].price; // dummy placeholder
        }
      } catch (err) {
        if (sectorStocks.length > 0) {
          etfChange = sectorStocks.reduce((sum, q) => sum + (q.changePct || 0), 0) / sectorStocks.length;
          etfPrice = sectorStocks[0].price;
        }
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

    return {
      gainers,
      losers,
      sectors,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Client fallback for market summary failed completely:', error.message);
    // Return empty mock structures to prevent fatal app crash
    return {
      gainers: [],
      losers: [],
      sectors: SECTOR_MAP.map(s => ({ ...s, change: 0, price: 0, leader: null, laggard: null })),
      timestamp: new Date().toISOString()
    };
  }
}

// Predefined popular Indian and US stocks — split catalogs
const STOCK_CATALOG_IN = [
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

// De-duplicate STOCK_CATALOG_IN by symbol
(function dedupIn() {
  const seen = new Set();
  for (let i = STOCK_CATALOG_IN.length - 1; i >= 0; i--) {
    if (seen.has(STOCK_CATALOG_IN[i].symbol)) STOCK_CATALOG_IN.splice(i, 1);
    else seen.add(STOCK_CATALOG_IN[i].symbol);
  }
})();

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

  // ── Mid Cap ──
  { symbol: 'AMD',   name: 'Advanced Micro Devices',   sector: 'Technology', cap: 'mid' },
  { symbol: 'NFLX',  name: 'Netflix Inc.',             sector: 'Consumer', cap: 'mid' },
  { symbol: 'PLTR',  name: 'Palantir Technologies',    sector: 'Technology', cap: 'mid' },
  { symbol: 'SNAP',  name: 'Snap Inc.',                sector: 'Technology', cap: 'mid' },
  { symbol: 'ROKU',  name: 'Roku Inc.',                sector: 'Consumer', cap: 'mid' },
  { symbol: 'HOOD',  name: 'Robinhood Markets',        sector: 'Financials', cap: 'mid' },
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

  // ── Small Cap ──
  { symbol: 'GME',   name: 'GameStop Corp.',           sector: 'Consumer', cap: 'small' },
  { symbol: 'AMC',   name: 'AMC Entertainment',        sector: 'Consumer', cap: 'small' },
  { symbol: 'SIRI',  name: 'Sirius XM Holdings',       sector: 'Telecom', cap: 'small' },
  { symbol: 'SPCE',  name: 'Virgin Galactic',          sector: 'Industrials', cap: 'small' },
  { symbol: 'CLOV',  name: 'Clover Health',            sector: 'Healthcare', cap: 'small' },
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

const SECTOR_MAP_IN = [
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

const MARKET_INDICES_IN = [
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
  { name: 'NIFTY REALTY', symbol: '^CNXREALTY' },
];

const MARKET_INDICES_US = [
  { name: 'S&P 500',   symbol: '^GSPC' },
  { name: 'NASDAQ',    symbol: '^IXIC' },
  { name: 'DOW JONES', symbol: '^DJI' },
];

// Mutable exported references
const STOCK_CATALOG = [];
const SECTOR_MAP = [];
const MARKET_INDICES = [];

function setMarketMode(mode) {
  const currentMode = (mode || 'IN').toUpperCase();
  
  STOCK_CATALOG.length = 0;
  if (currentMode === 'US') {
    STOCK_CATALOG.push(...STOCK_CATALOG_US);
  } else {
    STOCK_CATALOG.push(...STOCK_CATALOG_IN);
  }
  
  SECTOR_MAP.length = 0;
  if (currentMode === 'US') {
    SECTOR_MAP.push(...SECTOR_MAP_US);
  } else {
    SECTOR_MAP.push(...SECTOR_MAP_IN);
  }

  MARKET_INDICES.length = 0;
  if (currentMode === 'US') {
    MARKET_INDICES.push(...MARKET_INDICES_US);
  } else {
    MARKET_INDICES.push(...MARKET_INDICES_IN);
  }
}

// Initial active market mode setup
setMarketMode(localStorage.getItem('stid_market_mode') || 'IN');

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

let proxyQueuePromise = Promise.resolve();

// ── Core fetch wrapper with CORS proxy
// Spaced out sequentially via proxyQueuePromise to prevent CORS proxy 429 rate limiting.
// Rotates/falls back from allorigins to corsproxy.io on failure.
async function proxyFetch(url, timeoutMs = 8000) {
  const cacheKey = url;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const fetchTask = async () => {
    // Wait 250ms after the previous request started to space them out
    await new Promise(resolve => setTimeout(resolve, 250));
    
    // Try allorigins first
    try {
      const res = await fetchWithTimeout(`${CORS_PROXY}${encodeURIComponent(url)}`, { timeout: timeoutMs });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const wrapper = await res.json();
      const data = JSON.parse(wrapper.contents);
      cacheSet(cacheKey, data);
      return data;
    } catch (e) {
      console.warn('allorigins proxy failed, trying fallback corsproxy.io:', e.message);
      // Fallback to corsproxy.io (direct proxy)
      try {
        const res = await fetchWithTimeout(`https://corsproxy.io/?${encodeURIComponent(url)}`, { timeout: timeoutMs });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        cacheSet(cacheKey, data);
        return data;
      } catch (fallbackErr) {
        console.error('All proxies failed for', url, fallbackErr.message);
        return null;
      }
    }
  };

  const resultPromise = proxyQueuePromise.then(fetchTask);
  proxyQueuePromise = resultPromise.then(() => {}).catch(() => {});
  return resultPromise;
}

// ── Direct fetch (for APIs that allow CORS)
async function directFetch(url, timeoutMs = 3000) {
  const cached = cacheGet(url);
  if (cached) return cached;
  try {
    const res = await fetchWithTimeout(url, { timeout: timeoutMs });
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
  // Use alternative.me directly which is free and doesn't require keys
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
  try {
    const res = await fetchWithTimeout(`${BACKEND_URL}/api/news?symbol=${symbol}`, {
      headers: { ...getAuthHeaders() },
      timeout: 4000
    });
    if (res.ok) {
      const newsData = await res.json();
      if (newsData && newsData.length > 0) return newsData;
    }
  } catch (e) {
    console.warn('Backend news fetch failed, falling back to proxy:', e.message);
  }

  const url = `${YAHOO_BASE}/v1/finance/search?q=${symbol}&newsCount=20`;
  try {
    const data = await proxyFetch(url);
    const news = [];

    if (data && data.news) {
      const cleanedSym = symbol.split('.')[0].toUpperCase();
      const filteredNews = data.news.filter(n => {
        const relatedTickers = Array.isArray(n.relatedTickers) ? n.relatedTickers.map(t => t.toUpperCase()) : [];
        const titleUpper = (n.title || '').toUpperCase();
        return (
          relatedTickers.includes(cleanedSym) ||
          relatedTickers.includes(symbol.toUpperCase()) ||
          titleUpper.includes(cleanedSym)
        );
      });

      filteredNews.slice(0, 6).forEach(n => {
        const sentiment = analyzeSentimentKeywords(n.title || '');
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

    if (news.length === 0) return generateMockNews(symbol);
    return news;
  } catch (e) {
    return generateMockNews(symbol);
  }
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
async function searchStocks(query) {
  if (!query || query.length < 1) return [];
  const q = query.trim();
  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  
  // Try querying backend search if available
  const isBackend = await checkBackend();
  if (isBackend) {
    try {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/search?q=${encodeURIComponent(q)}&market=${mode}`, {
        headers: getAuthHeaders(),
        timeout: 4000
      });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn('Backend search failed, using frontend local catalog fallback:', e.message);
    }
  }

  // Fallback to local catalog search
  const qLower = q.toLowerCase();
  return STOCK_CATALOG.filter(s =>
    s.symbol.toLowerCase().includes(qLower) ||
    s.name.toLowerCase().includes(qLower) ||
    s.sector.toLowerCase().includes(qLower)
  ).slice(0, 8);
}

// ============================================================
// MOCK DATA GENERATORS (fallback when API fails)
// ============================================================

function generateMockQuote(symbol) {
  const prices = {
    'RELIANCE.NS': 2400, 'TCS.NS': 3800, 'INFY.NS': 1400, 'HDFCBANK.NS': 1450,
    'ICICIBANK.NS': 1100, 'SBIN.NS': 800, 'KOTAKBANK.NS': 1700, 'AXISBANK.NS': 1050,
    'BAJFINANCE.NS': 6800, 'BAJAJFINSV.NS': 1600, 'INDUSINDBK.NS': 1400, 'BANKBARODA.NS': 250,
    'PNB.NS': 120, 'CANBK.NS': 110, 'WIPRO.NS': 460, 'HCLTECH.NS': 1350,
    'TECHM.NS': 1250, 'LTIM.NS': 4800, 'MPHASIS.NS': 2400, 'LT.NS': 3500,
    'SIEMENS.NS': 6500, 'ABB.NS': 7500, 'SUNPHARMA.NS': 1500, 'DRREDDY.NS': 6000,
    'CIPLA.NS': 1400, 'DIVISLAB.NS': 3700, 'APOLLOHOSP.NS': 6000, 'ZYDUSLIFE.NS': 950,
    'BIOCON.NS': 300, 'HINDUNILVR.NS': 2300, 'NESTLEIND.NS': 2500, 'BRITANNIA.NS': 5000,
    'TITAN.NS': 3300, 'TRENT.NS': 4500, 'ETERNAL.NS': 180, 'ZOMATO.NS': 180, 'IRCTC.NS': 950,
    'MARUTI.NS': 12000, 'EICHERMOT.NS': 4500, 'HEROMOTOCO.NS': 4400, 'MAHINDM.NS': 2500,
    'TATASTEEL.NS': 160, 'JSWSTEEL.NS': 850, 'HINDALCO.NS': 600, 'VEDL.NS': 450,
    'SAIL.NS': 150, 'ULTRACEMCO.NS': 9500, 'GRASIM.NS': 2200, 'ASIANPAINT.NS': 2800,
    'PIDILITIND.NS': 2700, 'ONGC.NS': 270, 'COALINDIA.NS': 450, 'BPCL.NS': 320,
    'SUZLON.NS': 54, 'ADANIENT.NS': 3000, 'ADANIPORTS.NS': 1300, 'POWERGRID.NS': 300,
    'NTPC.NS': 360, 'TATAPOWER.NS': 430, 'HAVELLS.NS': 1600, 'VOLTAS.NS': 1300,
    'BHARTIARTL.NS': 1350, 'DLF.NS': 850, 'OBEROIRLTY.NS': 1600
  };
  const basePrice = prices[symbol] || (() => {
    const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return 100 + (seed % 2000);
  })();
  const price = basePrice + (Math.random() - 0.5) * (basePrice * 0.05); // +/- 2.5% variation
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
  const quarters = [
    'Q4 FY24','Q3 FY24','Q2 FY24','Q1 FY24',
    'Q4 FY23','Q3 FY23','Q2 FY23','Q1 FY23',
    'Q4 FY22','Q3 FY22','Q2 FY22','Q1 FY22'
  ];
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
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      }),
      timeout: 5000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error('fetchGeminiAnalysis error:', error);
    return null;
  }
}

// Helper function to generate a rich markdown fallback report when Gemini key/backend is missing
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

  if (msg.includes('fundamental') || msg.includes('pe ratio') || msg.includes('p/e') || msg.includes('roe') || msg.includes('debt') || msg.includes('what is p/e') || msg.includes('book value')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Subject: Fundamental Scoring Metrics
- Target: Evaluate financial stability and growth

[ANALYSIS LOG]
- P/E Ratio: Cheap (< 15 for Indian, < 20 for US), Fair (15-35), Expensive (> 50).
- Return on Equity (ROE): Target > 15% (underlying capital efficiency).
- Debt/Equity Ratio: Target < 1.0 (excluding banking/NBFC sectors — their leverage is normal).
- Growth: Consistent > 10% YoY revenue and profit growth for a "Buy" signal.
- Price-to-Book (P/B): Cheap < 1.5x, Fair 1.5-4x, Expensive > 6x.
- Scoring weight: Max 25 points per pillar in composite model.`;
  }

  if (msg.includes('nifty') || msg.includes('sensex') || msg.includes('banknifty') || msg.includes('bank nifty') || msg.includes('index') || msg.includes('market today')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Subject: Indian Market Indices
- Data: Live via market pulse banner (top of dashboard)

[ANALYSIS LOG]
- NIFTY 50: Benchmark index of 50 large-cap NSE stocks across all sectors.
- SENSEX: BSE benchmark of 30 blue-chip companies.
- BANK NIFTY: Tracks 12 large Indian banking stocks. Key indicator for financial sector momentum.
- Rule: When NIFTY > 200 SMA → market is in primary uptrend. Favor long swing trades.
- Rule: When BANK NIFTY > NIFTY → sector rotation into financials. Watch HDFC, ICICI, SBI.`;
  }

  if (msg.includes('suzlon') || msg.includes('renewable') || msg.includes('green energy') || msg.includes('wind energy')) {
    return `[AGENT STATUS: COMPLETED]
[DECISION LOG]
- Sector: Renewable Energy / Wind Power
- Key Stock: Suzlon Energy (SUZLON.NS)

[ANALYSIS LOG]
- Suzlon is India's largest wind energy company with ~30% domestic market share.
- Strong order book recovery post FY21 debt restructuring.
- Valuation risk: Stock often trades at high P/E due to growth premium.
- Entry strategy: Look for pullbacks to 50 EMA with RSI > 45 as confirmation.
- Sector tailwind: India's renewable energy target of 500 GW by 2030.`;
  }

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
    const isUS = !symbol.endsWith('.NS') && !symbol.endsWith('.BO');
    const cSym = isUS ? '$' : '₹';
    const formatPrice = (p) => typeof p === 'number' ? cSym + p.toLocaleString(isUS ? 'en-US' : 'en-IN', { minimumFractionDigits: 2 }) : 'N/A';

    const s1 = tradeSetup.indicators?.sr?.s1 || null;
    const r1 = tradeSetup.indicators?.sr?.r1 || null;
    const price = quote.price || 0;

    let entryZone = '';
    let ratingJustification = '';

    if (composite.total >= 80) {
      const entryMin = s1 ? Math.min(price, s1) : price * 0.98;
      const entryMax = price * 1.01;
      entryZone = `${cSym}${entryMin.toFixed(2)} - ${cSym}${entryMax.toFixed(2)} (Accumulate on minor pullbacks to support S1 at ${cSym}${s1 || 'support'} or 20 EMA, or on breakout above R1 at ${cSym}${r1 || 'resistance'})`;
      ratingJustification = `Strong buy rating is justified by a robust combination of exceptional fundamentals, clear technical breakout above key moving averages, and high institutional volume accumulation.`;
    } else if (composite.total >= 65) {
      const entryMin = s1 ? s1 : price * 0.97;
      entryZone = `${cSym}${entryMin.toFixed(2)} - ${cSym}${price.toFixed(2)} (Optimal entry on minor pullbacks towards support S1 at ${cSym}${s1 || 'support'} or the 50 SMA)`;
      ratingJustification = `Buy rating is supported by a healthy primary uptrend and solid core financials, though wait for key levels or minor cooling of indicators for optimal risk-to-reward.`;
    } else if (composite.total >= 50) {
      entryZone = `Wait for breakout above ${cSym}${r1 ? r1.toFixed(2) : 'R1'} or pullback to ${cSym}${s1 ? s1.toFixed(2) : 'S1'}`;
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

// ── INVY AI CHAT SYSTEM (Client-side, quota-friendly with backend fallback)
function buildInvyRAGContext(currentStockContext, marketSummary) {
  if (!currentStockContext || !currentStockContext.symbol) return '';

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

  let context = `[LIVE TECHNICAL RAG DATA FOR ${currentStockContext.name} (${symbol})]:
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

  // Events-to-Action layer for news
  const news = currentStockContext.news || [];
  if (news.length > 0) {
    context += `- Recent News Catalysts:\n`;
    news.slice(0, 3).forEach((n, idx) => {
      context += `  * Article ${idx + 1}: "${n.title}" | Source: ${n.source || 'News'} | Link: ${n.link || 'N/A'}\n    Summary: ${n.summary || 'N/A'}\n`;
    });
  } else {
    context += `- Recent News Catalysts: None available.\n`;
  }
  
  return context;
}

// ── INVY AI CHAT SYSTEM (Client-side, quota-friendly with backend fallback)
async function sendInvyChatMessage(history, message, currentStockContext, marketSummary) {
  const apiKey = localStorage.getItem('gemini_api_key');
  
  if (!apiKey) {
    // Backend fallback proxy (handles free tier proxy using server key or rule-based response)
    const url = `${BACKEND_URL}/api/chat`;
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ history, message, currentStockContext, marketSummary }),
        timeout: 7000
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server responded with status ${res.status}`);
      }
      const data = await res.json();
      return data.response;
    } catch (e) {
      console.warn('Backend proxy chat failed, using client-side offline generator:', e.message);
      return generateDetailedFallbackReport(currentStockContext, message);
    }
  }

  // Browser-direct query using user's saved Gemini API Key
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

  const contents = [...history];
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

  if (currentStockContext?.symbol) {
    const ragContext = buildInvyRAGContext(currentStockContext, marketSummary);
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

  try {
    const res = await fetchWithTimeout(url, {
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
      }),
      timeout: 7000
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

const simulatedRecommendations = [
  {
    id: 1,
    symbol: 'RELIANCE.NS',
    name: 'Reliance Industries Limited',
    sector: 'Energy',
    market: 'IN',
    rating: 'STRONG BUY',
    price: 1354.50,
    target_1: 1422.00,
    target_2: 1489.00,
    stop_loss: 1286.00,
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
    price: 2317.30,
    target_1: 2433.00,
    target_2: 2549.00,
    stop_loss: 2201.00,
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

async function fetchRecommendations(market = 'IN') {
  try {
    const activeBackend = await checkBackend();
    if (activeBackend) {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/recommendations?market=${market}`, {
        headers: getAuthHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        return data.recommendations || [];
      }
    }
  } catch (e) {
    console.warn('Failed to fetch recommendations from backend:', e);
  }
  return simulatedRecommendations.filter(r => r.market === market);
}

async function fetchSettings() {
  try {
    const activeBackend = await checkBackend();
    if (activeBackend) {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/settings`, {
        headers: getAuthHeaders()
      });
      if (res.ok) {
        return await res.json();
      }
    }
  } catch (e) {
    console.warn('Failed to fetch alert settings:', e);
  }
  return {
    telegram_enabled: false,
    telegram_chat_id: '',
    telegram_bot_token: '',
    whatsapp_enabled: false,
    whatsapp_phone: '',
    whatsapp_apikey: ''
  };
}

async function saveSettings(settings) {
  try {
    const activeBackend = await checkBackend();
    if (activeBackend) {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        const data = await res.json();
        return data.settings;
      }
    }
  } catch (e) {
    console.warn('Failed to save alert settings:', e);
  }
  return settings;
}

async function sendTestSignal(symbol, telegram_chat_id, whatsapp_phone) {
  try {
    const activeBackend = await checkBackend();
    if (activeBackend) {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/test-signal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ symbol, telegram_chat_id, whatsapp_phone })
      });
      if (res.ok) {
        return await res.json();
      }
    }
  } catch (e) {
    console.warn('Failed to send test signal:', e);
  }
  return null;
}

async function runBacktest(symbol, params) {
  try {
    const activeBackend = await checkBackend();
    if (activeBackend) {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/backtest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ symbol, ...params })
      });
      if (res.ok) {
        return await res.json();
      } else {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to run backtest');
      }
    }
  } catch (e) {
    console.error('Failed to run backtest:', e);
    throw e;
  }
  return null;
}

async function runScreener(filters, weights, activeRegime) {
  try {
    const activeBackend = await checkBackend();
    if (activeBackend) {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/screener/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify({ filters, weights, activeRegime })
      });
      if (res.ok) {
        return await res.json();
      } else {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to run screener');
      }
    }
  } catch (e) {
    console.error('Failed to run screener:', e);
    throw e;
  }
  return null;
}

async function fetchPerformanceStats() {
  try {
    const activeBackend = await checkBackend();
    if (activeBackend) {
      const res = await fetchWithTimeout(`${BACKEND_URL}/api/performance-stats`, {
        headers: getAuthHeaders()
      });
      if (res.ok) {
        return await res.json();
      }
    }
  } catch (e) {
    console.warn('Failed to fetch performance stats:', e);
  }
  return {
    active_count: 0,
    settled_count: 0,
    win_rate: 0.0,
    target_hit_count: 0,
    stop_loss_hit_count: 0
  };
}

async function registerUser(email, password) {
  const res = await fetch(`${BACKEND_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Registration failed');
  return data;
}

async function loginUser(email, password) {
  const res = await fetch(`${BACKEND_URL}/api/auth/email-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data;
}

async function connectBroker(brokerName, apiKey, accessToken) {
  const res = await fetch(`${BACKEND_URL}/api/portfolio/connect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders()
    },
    body: JSON.stringify({ brokerName, apiKey, accessToken })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to connect broker');
  return data;
}

async function disconnectBroker(brokerName) {
  const res = await fetch(`${BACKEND_URL}/api/portfolio/disconnect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders()
    },
    body: JSON.stringify({ brokerName })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to disconnect broker');
  return data;
}

async function analyzePortfolio() {
  const res = await fetch(`${BACKEND_URL}/api/portfolio/analyze`, {
    method: 'GET',
    headers: getAuthHeaders()
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to analyze portfolio');
  return data;
}

// Export
window.API = {
  fetchQuote, fetchFundamentals, fetchHistorical, fetchEarnings,
  fetchSectorPerformance, fetchMarketIndices, fetchFearGreed,
  fetchNewsSentiment, fetchGeminiAnalysis, searchStocks, STOCK_CATALOG, SECTOR_MAP,
  checkBackend, fetchFullAnalysisFromBackend, fetchAndCacheAnalysis, fetchMarketPulseFromBackend, fetchMarketSummary, setBackendUrl,
  sendInvyChatMessage, fetchAuthConfig, fetchWithTimeout, setMarketMode,
  fetchRecommendations, fetchSettings, saveSettings, sendTestSignal, runBacktest, runScreener, fetchPerformanceStats,
  registerUser, loginUser, connectBroker, disconnectBroker, analyzePortfolio,
  getBackendUrl: () => BACKEND_URL
};

