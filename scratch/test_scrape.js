const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function testScrape(symbol) {
  const url = `https://www.screener.in/company/${encodeURIComponent(symbol)}/`;
  console.log('\nFetching', url);
  try {
    const response = await axios.get(url, { headers: DEFAULT_HEADERS });
    const $ = cheerio.load(response.data);
    
    console.log('--- Key Ratios ---');
    $('#top-ratios li').each((i, el) => {
      const name = $(el).find('.name').text().trim();
      const val = $(el).find('.number').text().trim();
      console.log(`${name}: ${val}`);
    });
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function run() {
  await testScrape('TCS');
  await testScrape('RELIANCE');
}
run();
