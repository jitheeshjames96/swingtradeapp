const scraper = require('../server/src/scraper');
const { Pool } = require('pg');

const STOCK_CATALOG = [
  { symbol: 'RELIANCE.NS',   name: 'Reliance Industries',       sector: 'Energy' },
  { symbol: 'TCS.NS',        name: 'Tata Consultancy Services', sector: 'IT' },
  { symbol: 'INFY.NS',       name: 'Infosys Ltd',               sector: 'IT' },
  { symbol: 'HDFCBANK.NS',   name: 'HDFC Bank',                 sector: 'Banking' },
  { symbol: 'ICICIBANK.NS',  name: 'ICICI Bank',                sector: 'Banking' },
  { symbol: 'WIPRO.NS',      name: 'Wipro Ltd',                 sector: 'IT' },
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
  { symbol: 'DLF.NS',    name: 'DLF Limited',             sector: 'Real Estate' },
  { symbol: 'PLD',       name: 'Prologis Inc',            sector: 'Real Estate' },
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
  if (s.includes('energy')) {
    return 'Energy';
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

async function test() {
  const symbols = STOCK_CATALOG.map(s => s.symbol);
  console.log(`Fetching quotes for ${symbols.length} symbols...`);
  const quotes = await scraper.fetchQuotes(symbols);
  console.log(`Fetched ${quotes.length} quotes.`);

  const enrichedQuotes = quotes.map(q => {
    const catItem = STOCK_CATALOG.find(s => s.symbol === q.symbol);
    return {
      symbol: q.symbol,
      sector: catItem ? catItem.sector : 'N/A',
      resolvedSector: catItem ? getEtfSectorName(catItem.sector) : 'N/A'
    };
  });

  console.log("Enriched Quotes Sector Mapping:");
  console.log(enrichedQuotes);
}

test();
