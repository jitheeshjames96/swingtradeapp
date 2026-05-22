const axios = require('axios');
const cheerio = require('cheerio');

axios.get('https://www.screener.in/company/TCS/', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
})
.then(res => {
  const $ = cheerio.load(res.data);
  $('#top-ratios li').each((i, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    console.log(text);
  });
})
.catch(console.error);
