const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function testScrape(symbol) {
  const url = `https://www.screener.in/company/${encodeURIComponent(symbol)}/`;
  console.log('Fetching', url);
  try {
    const response = await axios.get(url, { headers: DEFAULT_HEADERS });
    const $ = cheerio.load(response.data);
    
    // Test Shareholding Pattern
    console.log('\n--- Shareholding Pattern (First Table only) ---');
    const table = $('#shareholding table').first();
    if (table.length > 0) {
      const headers = [];
      table.find('thead th').each((i, el) => {
        headers.push($(el).text().trim());
      });
      console.log('Headers:', headers);
      
      table.find('tbody tr').each((i, el) => {
        const rowName = $(el).find('td').first().text().trim();
        const rowValues = [];
        $(el).find('td').each((idx, cell) => {
          if (idx > 0) {
            rowValues.push($(cell).text().trim());
          }
        });
        console.log(`${rowName}:`, rowValues);
      });
    } else {
      console.log('No table found in shareholding section.');
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
}

testScrape('TCS');
