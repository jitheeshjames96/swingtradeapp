const axios = require('axios');
const cheerio = require('cheerio');

axios.get('https://www.screener.in/company/RELIANCE/', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
})
.then(res => {
  const $ = cheerio.load(res.data);
  console.log('--- Profit & Loss Rows ---');
  $('#profit-loss table tbody tr').each((i, el) => {
    const rowName = $(el).find('td').first().text().trim();
    const cols = [];
    $(el).find('td').each((idx, td) => {
      if (idx > 0) cols.push($(td).text().trim());
    });
    console.log(`${rowName}:`, cols);
  });
})
.catch(console.error);
