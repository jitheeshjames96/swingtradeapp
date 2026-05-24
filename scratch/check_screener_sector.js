const axios = require('axios');
const cheerio = require('cheerio');

async function checkStock(symbol) {
  const baseSymbol = symbol.replace('.NS', '').replace('.BO', '');
  const url = `https://www.screener.in/company/${encodeURIComponent(baseSymbol)}/`;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const $ = cheerio.load(res.data);
    const broadSector = $('a[title="Broad Sector"]').text().trim();
    const sector = $('a[title="Sector"]').text().trim();
    const industry = $('a[title="Industry"]').text().trim();
    
    console.log(`Symbol: ${symbol}`);
    console.log(`  - Broad Sector: "${broadSector}"`);
    console.log(`  - Sector: "${sector}"`);
    console.log(`  - Industry: "${industry}"`);
  } catch (e) {
    console.error(`Failed for ${symbol}:`, e.message);
  }
}

async function run() {
  await checkStock('RELIANCE.NS');
  console.log('----------------');
  await checkStock('TCS.NS');
  console.log('----------------');
  await checkStock('M&M.NS');
}

run();
