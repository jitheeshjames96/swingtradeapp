const scraper = require('../server/src/scraper');

async function testSuzlon() {
  console.log('Fetching SUZLON.NS quote...');
  try {
    const quote = await scraper.fetchQuote('SUZLON.NS');
    console.log('Suzlon Quote Details:', JSON.stringify(quote, null, 2));
    
    console.log('Fetching SUZLON.NS fundamentals...');
    const fundamentals = await scraper.fetchYahooFundamentals('SUZLON.NS');
    console.log('Suzlon Fundamentals Keys:', Object.keys(fundamentals || {}));
    if (fundamentals) {
      console.log('Market Cap:', fundamentals.marketCap);
      console.log('P/E Ratio:', fundamentals.trailingPE);
    }
    
    console.log('Fetching SUZLON screener data...');
    const screener = await scraper.fetchScreenerData('SUZLON.NS');
    console.log('Suzlon Screener Ratios:', JSON.stringify(screener?.ratios, null, 2));
  } catch (e) {
    console.error('Error fetching Suzlon:', e.stack);
  }
}

testSuzlon();
