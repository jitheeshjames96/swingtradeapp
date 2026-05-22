const scraper = require('../server/src/scraper.js');

async function test() {
  console.log('Fetching RELIANCE.NS direct screener data...');
  try {
    const data = await scraper.fetchScreenerData('RELIANCE.NS');
    console.log('Result:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error:', e);
  }
}
test();
