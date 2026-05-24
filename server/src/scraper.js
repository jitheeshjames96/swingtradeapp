const axios = require('axios');
const cheerio = require('cheerio');

// Ticker aliases: map broken/renamed Yahoo Finance tickers to working ones
// These are tickers where Yahoo Finance dropped or renamed the symbol
const TICKER_ALIASES = {
  'TATAMOTORS.NS': null, // Yahoo dropped post-demerger — returns 404
  'TATAMOTORS.BO': null,
  'ZOMATO.NS': 'ETERNAL.NS', // Zomato rebranded to Eternal Limited
};

// Default headers for scraping
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Yahoo-specific headers to avoid JSON API block (doesn't trigger 429)
const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

function getEtfSectorName(stockSector) {
  const s = (stockSector || '').toLowerCase();
  if (s === 'it' || s === 'information technology' || s.includes('tech') || s.includes('semiconductor') || s.includes('social') || s.includes('streaming') || s.includes('e-commerce') || s.includes('consumer tech') || s.includes('computers')) {
    return 'Technology';
  }
  if (s.includes('bank') || s.includes('nbfc') || s.includes('financial') || s.includes('insurance') || s.includes('finance') || s.includes('capital') || s.includes('holding') || s.includes('investment')) {
    return 'Financials';
  }
  if (s.includes('pharma') || s.includes('health') || s.includes('hospital') || s.includes('clinical') || s.includes('biotech') || s.includes('medicine') || s.includes('medical') || s.includes('life sciences')) {
    return 'Healthcare';
  }
  if (s.includes('renewable') || s.includes('wind') || s.includes('solar') || s.includes('green') || s.includes('clean')) {
    return 'Renewables';
  }
  if (s.includes('energy') || s.includes('refiner') || s.includes('oil') || s.includes('gas') || s.includes('fuel') || s.includes('coal')) {
    return 'Energy';
  }
  if (s.includes('telecom') || s.includes('telco') || s.includes('telecommunications') || s.includes('communication')) {
    return 'Telecom';
  }
  if (s.includes('auto') || s.includes('engineer') || s.includes('conglomerate') || s.includes('industrial') || s.includes('aerospace') || s.includes('defense') || s.includes('defence') || s.includes('electronics') || s.includes('infrastructure') || s.includes('construction') || s.includes('machinery') || s.includes('rail') || s.includes('passenger') || s.includes('vehicle')) {
    return 'Industrials';
  }
  if (s.includes('fmcg') || s.includes('consumer') || s.includes('retail') || s.includes('food') || s.includes('beverage') || s.includes('textile') || s.includes('hotel') || s.includes('tourism') || s.includes('entertainment') || s.includes('jeweller') || s.includes('apparel')) {
    return 'Consumer';
  }
  if (s.includes('metal') || s.includes('cement') || s.includes('material') || s.includes('steel') || s.includes('mining') || s.includes('iron') || s.includes('chemical') || s.includes('paper') || s.includes('paint') || s.includes('glass')) {
    return 'Materials';
  }
  if (s.includes('utility') || s.includes('utilities') || s.includes('power') || s.includes('electricity') || s.includes('water')) {
    return 'Utilities';
  }
  if (s.includes('real estate') || s.includes('realty') || s.includes('property') || s.includes('properties') || s.includes('developer')) {
    return 'Real Estate';
  }
  return 'Other';
}

// Simple cookie jar memory storage for NSE India sessions
let nseCookies = '';
let lastCookieFetch = 0;
let pendingNseCookiesPromise = null;

async function getNseCookies() {
  if (nseCookies && Date.now() - lastCookieFetch < 5 * 60 * 1000) {
    return nseCookies;
  }

  if (pendingNseCookiesPromise) {
    return pendingNseCookiesPromise;
  }

  pendingNseCookiesPromise = (async () => {
    try {
      const response = await axios.get('https://www.nseindia.com', { 
        headers: DEFAULT_HEADERS,
        timeout: 4000 
      });
      const cookies = response.headers['set-cookie'] || [];
      nseCookies = cookies.map(cookie => cookie.split(';')[0]).join('; ');
      lastCookieFetch = Date.now();
      return nseCookies;
    } catch (e) {
      console.error('Failed to retrieve NSE cookies:', e.message);
      return '';
    } finally {
      pendingNseCookiesPromise = null;
    }
  })();

  return pendingNseCookiesPromise;
}

/**
 * Fetch live stock quote (Yahoo Finance /v7/finance/quote with cookie/crumb, falling back to /v8/finance/chart and NSE India)
 */
async function fetchQuote(symbol) {
  // 1. Try authenticated Yahoo /v7/finance/quote first (most detailed, contains actual marketCap)
  try {
    const auth = await getYahooAuth().catch(() => null);
    if (auth) {
      const { cookie, crumb } = auth;
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&crumb=${encodeURIComponent(crumb)}`;
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Cookie': cookie
        },
        timeout: 4000
      });
      const result = response.data?.quoteResponse?.result?.[0];
      if (result) {
        return {
          symbol,
          price: result.regularMarketPrice || 0,
          change: result.regularMarketChange || 0,
          changePct: result.regularMarketChangePercent || 0,
          open: result.regularMarketOpen || result.regularMarketPrice || 0,
          high: result.regularMarketDayHigh || result.regularMarketPrice || 0,
          low: result.regularMarketDayLow || result.regularMarketPrice || 0,
          volume: result.regularMarketVolume || 0,
          marketCap: result.marketCap || 0,
          currency: result.currency || (symbol.endsWith('.NS') || symbol.endsWith('.BO') ? 'INR' : 'USD'),
          exchange: result.fullExchangeName || result.exchange || '',
          longName: result.longName || result.shortName || symbol,
        };
      }
    }
  } catch (e) {
    console.warn(`Yahoo /v7/finance/quote failed for ${symbol}: ${e.message}. Trying chart fallback...`);
  }

  // 2. NSE quote fallback (only for Indian stocks)
  const isIndian = symbol.endsWith('.NS') || symbol.endsWith('.BO');
  const baseSymbol = symbol.replace('.NS', '').replace('.BO', '');
  if (isIndian) {
    try {
      const cookies = await getNseCookies();
      const url = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(baseSymbol)}`;
      const response = await axios.get(url, {
        headers: {
          ...DEFAULT_HEADERS,
          'Cookie': cookies,
          'Referer': 'https://www.nseindia.com/',
        },
        timeout: 4000
      });
      const data = response.data;
      const priceInfo = data.priceInfo || {};

      return {
        symbol,
        price: priceInfo.lastPrice || 0,
        change: priceInfo.change || 0,
        changePct: priceInfo.pChange || 0,
        open: priceInfo.open || 0,
        high: priceInfo.intraDayHighLow?.high || 0,
        low: priceInfo.intraDayHighLow?.low || 0,
        volume: data.volume?.totListedVol || 0,
        marketCap: 0, // NSE api doesn't give clean total market cap in this endpoint
        currency: 'INR',
        exchange: 'NSE',
        longName: data.info?.companyName || symbol,
      };
    } catch (e) {
      console.warn(`NSE quote fetch failed for ${baseSymbol}: ${e.message}`);
    }
  }

  // 3. Public Yahoo Chart endpoint /v8/finance/chart fallback (completely unauthenticated, highly reliable)
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const response = await axios.get(url, { 
      headers: YAHOO_HEADERS,
      timeout: 4000
    });
    const result = response.data.chart.result[0];
    const meta = result.meta;
    const close = meta.regularMarketPrice || 0;
    const prevClose = meta.chartPreviousClose || meta.previousClose || close;
    const change = close - prevClose;
    
    return {
      symbol,
      price: close,
      change,
      changePct: prevClose ? ((change / prevClose) * 100) : 0,
      open: meta.regularMarketOpen || close,
      high: meta.regularMarketDayHigh || close,
      low: meta.regularMarketDayLow || close,
      volume: meta.regularMarketVolume || 0,
      marketCap: meta.marketCap || 0,
      currency: meta.currency || 'USD',
      exchange: meta.exchangeName || '',
      longName: meta.longName || symbol,
    };
  } catch (e) {
    throw new Error(`Failed to fetch quote for ${symbol} across all sources: ${e.message}`);
  }
}

/**
 * Scrape fundamental metrics and 5-year financials from Screener.in (for Indian stocks)
 */
async function fetchScreenerData(symbol) {
  const baseSymbol = symbol.replace('.NS', '').replace('.BO', '');
  const url = `https://www.screener.in/company/${encodeURIComponent(baseSymbol)}/`;
  
  try {
    const response = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 12000 });
    const $ = cheerio.load(response.data);
    
    // Scrape sector and industry breadcrumbs
    const broadSector = $('a[title="Broad Sector"]').text().trim();
    const sectorVal = $('a[title="Sector"]').text().trim();
    const industryVal = $('a[title="Industry"]').text().trim();
    const resolvedSector = getEtfSectorName(broadSector || sectorVal || industryVal || '');

    const fund = {};
    
    // Parse key ratios
    $('#top-ratios li').each((i, el) => {
      const name = $(el).find('.name').text().trim().toLowerCase();
      const rawVal = $(el).find('.number').text().trim().replace(/,/g, '');
      const val = parseFloat(rawVal);
      
      if (name.includes('stock p/e') || name.includes('pe')) fund.pe = val || null;
      else if (name.includes('book value')) fund.bookValue = val || null;
      else if (name.includes('industry p/e') || name.includes('industry pe')) fund.industryPe = val || null;
      else if (name.includes('roce')) fund.roce = val || null;
      else if (name.includes('roe')) fund.roe = val || null;
      else if (name.includes('debt to equity')) fund.debtToEquity = val || null;
      else if (name.includes('dividend yield')) fund.dividendYield = val || null;
      else if (name.includes('market cap')) fund.marketCap = (val * 10000000) || 0; // Screener MC is in Cr
    });

    // Scrape Quarterly Profit/Loss Table
    const quarterly = [];
    const qHeaders = [];
    $('#quarters table thead th').each((i, el) => {
      const txt = $(el).text().trim();
      if (txt && i > 0) qHeaders.push(txt);
    });
    
    const qSalesRow = [];
    const qProfitRow = [];
    $('#quarters table tbody tr').each((i, el) => {
      const rowName = $(el).find('td').first().text().trim().toLowerCase();
      if (rowName.includes('sales') || rowName.includes('revenue')) {
        $(el).find('td').each((idx, cell) => {
          if (idx > 0) qSalesRow.push(parseFloat($(cell).text().trim().replace(/,/g, '')) * 1e7 || 0); // Convert Cr to raw INR
        });
      }
      if (rowName.includes('net profit')) {
        $(el).find('td').each((idx, cell) => {
          if (idx > 0) qProfitRow.push(parseFloat($(cell).text().trim().replace(/,/g, '')) * 1e7 || 0);
        });
      }
    });

    qHeaders.forEach((q, idx) => {
      quarterly.push({
        period: q,
        revenue: qSalesRow[idx] || 0,
        netIncome: qProfitRow[idx] || 0,
        eps: null // Screener basic free table may omit quarterly EPS details, we estimate
      });
    });

    // Scrape Annual Profit/Loss Table
    const annual = [];
    const aHeaders = [];
    $('#profit-loss table thead th').each((i, el) => {
      const txt = $(el).text().trim();
      if (txt && i > 0 && !txt.includes('TTM')) aHeaders.push(txt);
    });

    const aSalesRow = [];
    const aProfitRow = [];
    const aEpsRow = [];
    $('#profit-loss table tbody tr').each((i, el) => {
      const rowName = $(el).find('td').first().text().trim().toLowerCase();
      if (rowName.includes('sales') || rowName.includes('revenue')) {
        $(el).find('td').each((idx, cell) => {
          if (idx > 0 && idx <= aHeaders.length) aSalesRow.push(parseFloat($(cell).text().trim().replace(/,/g, '')) * 1e7 || 0);
        });
      }
      if (rowName.includes('net profit')) {
        $(el).find('td').each((idx, cell) => {
          if (idx > 0 && idx <= aHeaders.length) aProfitRow.push(parseFloat($(cell).text().trim().replace(/,/g, '')) * 1e7 || 0);
        });
      }
      if (rowName.includes('eps')) {
        $(el).find('td').each((idx, cell) => {
          if (idx > 0 && idx <= aHeaders.length) aEpsRow.push(parseFloat($(cell).text().trim().replace(/,/g, '')) || null);
        });
      }
    });

    aHeaders.forEach((y, idx) => {
      annual.push({
        period: y,
        revenue: aSalesRow[idx] || 0,
        netIncome: aProfitRow[idx] || 0,
        eps: aEpsRow[idx]
      });
    });

    // Estimate missing ratios
    if (fund.marketCap && fund.pe) {
      fund.eps = fund.marketCap / fund.pe / 1e7;
    }

    // Balance Sheet Ratios (Debt to Equity)
    let shareCapital = [];
    let reserves = [];
    let borrowings = [];
    $('#balance-sheet table tbody tr').each((i, el) => {
      const rowName = $(el).find('td').first().text().trim().toLowerCase().replace(/[\s\xa0]+/g, ' ');
      const rowVals = [];
      $(el).find('td').each((idx, td) => {
        if (idx > 0) {
          const val = parseFloat($(td).text().trim().replace(/,/g, ''));
          rowVals.push(isNaN(val) ? 0 : val);
        }
      });
      if (rowName.includes('equity capital') || rowName.includes('share capital')) {
        shareCapital = rowVals;
      } else if (rowName.includes('reserves')) {
        reserves = rowVals;
      } else if (rowName.includes('borrowings')) {
        borrowings = rowVals;
      }
    });

    if (!fund.debtToEquity && shareCapital.length > 0 && reserves.length > 0 && borrowings.length > 0) {
      const latestEquity = shareCapital[shareCapital.length - 1] + reserves[reserves.length - 1];
      const latestBorrowings = borrowings[borrowings.length - 1];
      if (latestEquity > 0) {
        fund.debtToEquity = parseFloat((latestBorrowings / latestEquity).toFixed(2));
      }
    }

    // Profit & Loss Ratios (Growth and Margins)
    let sales = [];
    let netProfit = [];
    let opm = [];
    $('#profit-loss table tbody tr').each((i, el) => {
      const rowName = $(el).find('td').first().text().trim().toLowerCase().replace(/[\s\xa0]+/g, ' ');
      const rowVals = [];
      $(el).find('td').each((idx, td) => {
        if (idx > 0) {
          const val = parseFloat($(td).text().trim().replace(/,/g, '').replace(/%/g, ''));
          rowVals.push(isNaN(val) ? 0 : val);
        }
      });
      if (rowName.includes('sales') || rowName.includes('revenue')) {
        sales = rowVals;
      } else if (rowName.includes('net profit')) {
        netProfit = rowVals;
      } else if (rowName.includes('opm')) {
        opm = rowVals;
      }
    });

    if (!fund.revenueGrowth && sales.length > 1) {
      const latestSales = sales[sales.length - 1];
      const prevSales = sales[sales.length - 2];
      if (prevSales > 0) {
        fund.revenueGrowth = parseFloat((((latestSales - prevSales) / prevSales) * 100).toFixed(1));
      }
    }

    if (!fund.earningsGrowth && netProfit.length > 1) {
      const latestProfit = netProfit[netProfit.length - 1];
      const prevProfit = netProfit[netProfit.length - 2];
      if (prevProfit > 0) {
        fund.earningsGrowth = parseFloat((((latestProfit - prevProfit) / prevProfit) * 100).toFixed(1));
      }
    }

    if (!fund.profitMargin) {
      if (sales.length > 0 && netProfit.length > 0) {
        const latestSales = sales[sales.length - 1];
        const latestProfit = netProfit[netProfit.length - 1];
        if (latestSales > 0) {
          fund.profitMargin = parseFloat(((latestProfit / latestSales) * 100).toFixed(1));
        }
      } else if (opm.length > 0) {
        fund.profitMargin = opm[opm.length - 1];
      }
    }

    // Scrape Shareholding Pattern (First Table only)
    const shareholding = { quarters: [], promoters: [], fii: [], dii: [], public: [] };
    const shTable = $('#shareholding table').first();
    if (shTable.length > 0) {
      shTable.find('thead th').each((i, el) => {
        const txt = $(el).text().trim();
        if (txt && i > 0) shareholding.quarters.push(txt);
      });
      
      shTable.find('tbody tr').each((i, el) => {
        const rowName = $(el).find('td').first().text().trim().toLowerCase();
        const rowValues = [];
        $(el).find('td').each((idx, cell) => {
          if (idx > 0) {
            const val = parseFloat($(cell).text().trim().replace(/%/g, '').replace(/,/g, ''));
            rowValues.push(isNaN(val) ? 0 : val);
          }
        });
        
        if (rowName.includes('promoter')) shareholding.promoters = rowValues;
        else if (rowName.includes('fii')) shareholding.fii = rowValues;
        else if (rowName.includes('dii')) shareholding.dii = rowValues;
        else if (rowName.includes('public')) shareholding.public = rowValues;
      });
    }

    return {
      fundamentals: fund,
      earnings: {
        quarterly: quarterly.reverse().slice(0, 12),
        annual: annual.reverse().slice(0, 5)
      },
      shareholding,
      sector: resolvedSector,
      industry: industryVal
    };
  } catch (e) {
    console.warn(`Screener scraping failed for ${baseSymbol}: ${e.message}`);
    return null;
  }
}

let yahooCookie = '';
let yahooCrumb = '';
let lastYahooAuthFetch = 0;
let pendingYahooAuthPromise = null;

/**
 * Fetch a session cookie from fc.yahoo.com and a crumb token from query2.finance.yahoo.com
 */
async function getYahooAuth() {
  if (yahooCookie && yahooCrumb && Date.now() - lastYahooAuthFetch < 15 * 60 * 1000) {
    return { cookie: yahooCookie, crumb: yahooCrumb };
  }

  if (pendingYahooAuthPromise) {
    return pendingYahooAuthPromise;
  }

  pendingYahooAuthPromise = (async () => {
    try {
      const authHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      };

      // 1. Get Cookie from fc.yahoo.com
      const cookieResponse = await axios.get('https://fc.yahoo.com/', {
        headers: authHeaders,
        validateStatus: () => true,
        timeout: 4000
      });

      const cookies = cookieResponse.headers['set-cookie'] || [];
      const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

      if (!cookieHeader) {
        throw new Error('No cookie returned from fc.yahoo.com');
      }

      // 2. Get Crumb using the cookie
      const crumbResponse = await axios.get('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        headers: {
          ...authHeaders,
          'Cookie': cookieHeader,
        },
        timeout: 4000
      });

      const crumb = crumbResponse.data;
      if (!crumb) {
        throw new Error('No crumb returned from getcrumb endpoint');
      }

      yahooCookie = cookieHeader;
      yahooCrumb = crumb;
      lastYahooAuthFetch = Date.now();

      return { cookie: yahooCookie, crumb: yahooCrumb };
    } catch (e) {
      console.error('Failed to retrieve Yahoo cookie/crumb, using existing cache if available:', e.message);
      if (yahooCookie && yahooCrumb) {
        return { cookie: yahooCookie, crumb: yahooCrumb };
      }
      throw e;
    } finally {
      pendingYahooAuthPromise = null;
    }
  })();

  return pendingYahooAuthPromise;
}

/**
 * Fallback: Fetch basic fundamentals from Yahoo /v7/finance/quote endpoint (requires cookie/crumb)
 */
async function fetchYahooQuoteFundamentals(symbol) {
  try {
    const auth = await getYahooAuth();
    const { cookie, crumb } = auth;
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&crumb=${encodeURIComponent(crumb)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Cookie': cookie
      },
      timeout: 4000
    });

    const result = response.data?.quoteResponse?.result?.[0];
    if (!result) {
      throw new Error('No result returned from Yahoo quote endpoint');
    }

    return {
      pe: result.trailingPE || result.forwardPE || null,
      forwardPE: result.forwardPE || null,
      pb: result.priceToBook || null,
      eps: result.epsTrailingTwelveMonths || null,
      roe: null,
      debtToEquity: null,
      revenueGrowth: null,
      earningsGrowth: null,
      profitMargin: null,
      currentRatio: null,
      dividendYield: result.dividendYield ? result.dividendYield * 100 : null, // Convert decimal yield to percent
      marketCap: result.marketCap || 0,
      beta: result.beta || null,
      fiftyTwoWeekHigh: result.fiftyTwoWeekHigh || null,
      fiftyTwoWeekLow: result.fiftyTwoWeekLow || null,
      avgVolume: result.averageDailyVolume3Month || 0,
      shareholding: null
    };
  } catch (e) {
    throw new Error(`Yahoo /v7/finance/quote fundamentals fallback failed: ${e.message}`);
  }
}

/**
 * Fetch Yahoo Finance quote summary as primary source for US stocks or missing Indian data
 */
async function fetchYahooFundamentals(symbol) {
  const modules = 'summaryDetail,defaultKeyStatistics,financialData,earningsTrend,assetProfile';
  
  try {
    const { cookie, crumb } = await getYahooAuth();
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
    
    const response = await axios.get(url, { 
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Cookie': cookie
      },
      timeout: 4000
    });
    const result = response.data.quoteSummary.result[0];
    const sd = result.summaryDetail || {};
    const ks = result.defaultKeyStatistics || {};
    const fd = result.financialData || {};
    const ap = result.assetProfile || {};
    
    const yahooSector = ap.sector || '';
    const yahooIndustry = ap.industry || '';
    const resolvedSector = getEtfSectorName(yahooSector || yahooIndustry || '');

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
      shareholding: {
        insiders,
        institutions,
        public: publicHeld
      },
      sector: resolvedSector,
      industry: yahooIndustry
    };
  } catch (e) {
    console.warn(`Yahoo Summary API failed for ${symbol}: ${e.message}. Trying quote endpoint fallback...`);
    try {
      return await fetchYahooQuoteFundamentals(symbol);
    } catch (fallbackError) {
      console.error(`All Yahoo fundamentals endpoints failed for ${symbol}: ${fallbackError.message}. Returning empty default metrics.`);
      // Graceful degradation: return empty metrics instead of failing the entire stock load
      return {
        pe: null,
        forwardPE: null,
        pb: null,
        eps: null,
        roe: null,
        debtToEquity: null,
        revenueGrowth: null,
        earningsGrowth: null,
        profitMargin: null,
        currentRatio: null,
        dividendYield: null,
        marketCap: 0,
        beta: null,
        fiftyTwoWeekHigh: null,
        fiftyTwoWeekLow: null,
        avgVolume: 0,
        shareholding: null,
        isDegraded: true
      };
    }
  }
}

/**
 * Fetch quotes for multiple symbols in parallel or batch (Yahoo Finance /v7/finance/quote)
 */
async function fetchQuotes(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];

  // Deduplicate and filter symbols
  const uniqueSymbols = [...new Set(symbols)].map(s => s.trim().toUpperCase());

  try {
    const auth = await getYahooAuth().catch(() => null);
    if (auth) {
      const { cookie, crumb } = auth;
      const symbolsString = uniqueSymbols.join(',');
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolsString)}&crumb=${encodeURIComponent(crumb)}`;
      
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Cookie': cookie
        },
        timeout: 8000
      });

      const results = response.data?.quoteResponse?.result;
      if (Array.isArray(results) && results.length > 0) {
        return results.map(result => {
          const symbol = result.symbol;
          return {
            symbol,
            price: result.regularMarketPrice || 0,
            change: result.regularMarketChange || 0,
            changePct: result.regularMarketChangePercent || 0,
            open: result.regularMarketOpen || result.regularMarketPrice || 0,
            high: result.regularMarketDayHigh || result.regularMarketPrice || 0,
            low: result.regularMarketDayLow || result.regularMarketPrice || 0,
            volume: result.regularMarketVolume || 0,
            marketCap: result.marketCap || 0,
            currency: result.currency || (symbol.endsWith('.NS') || symbol.endsWith('.BO') ? 'INR' : 'USD'),
            exchange: result.fullExchangeName || result.exchange || '',
            longName: result.longName || result.shortName || symbol,
          };
        });
      }
    }
  } catch (e) {
    console.warn(`Yahoo batch /v7/finance/quote failed: ${e.message}. Falling back to individual fetches.`);
  }

  // Fallback to parallel single fetches if cookie/crumb query failed
  console.log(`Executing individual fallback quote fetches for ${uniqueSymbols.length} symbols...`);
  const promises = uniqueSymbols.map(async (symbol) => {
    try {
      return await fetchQuote(symbol);
    } catch (err) {
      console.warn(`Fallback fetchQuote failed for ${symbol}: ${err.message}`);
      return null;
    }
  });

  const results = await Promise.all(promises);
  return results.filter(Boolean);
}

module.exports = {
  fetchQuote,
  fetchQuotes,
  fetchScreenerData,
  fetchYahooFundamentals
};

