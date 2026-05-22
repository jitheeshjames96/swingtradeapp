const scraper = require('../server/src/scraper');

async function runTest(symbol) {
  console.log(`\n========================================`);
  console.log(`Profiling performance for symbol: ${symbol}`);
  console.log(`========================================`);

  // Measure sequential fetches
  console.log('\n--- Running Sequential Fetches ---');
  const seqStart = Date.now();
  
  try {
    console.time('Sequential - Quote');
    const quote = await scraper.fetchQuote(symbol);
    console.timeEnd('Sequential - Quote');
    console.log(`  Quote price: ${quote.price}`);
  } catch (e) {
    console.error('Sequential - Quote failed:', e.message);
  }

  const isIndian = symbol.endsWith('.NS') || symbol.endsWith('.BO');
  
  try {
    if (isIndian) {
      console.time('Sequential - Screener');
      const screener = await scraper.fetchScreenerData(symbol);
      console.timeEnd('Sequential - Screener');
      console.log(`  Screener data: ${screener ? 'Found' : 'Not Found'}`);
    }
  } catch (e) {
    console.error('Sequential - Screener failed:', e.message);
  }

  try {
    console.time('Sequential - Yahoo Fundamentals');
    const yahoo = await scraper.fetchYahooFundamentals(symbol);
    console.timeEnd('Sequential - Yahoo Fundamentals');
    console.log(`  Yahoo fundamentals: ${yahoo ? 'Found' : 'Not Found'}`);
  } catch (e) {
    console.error('Sequential - Yahoo Fundamentals failed:', e.message);
  }

  const seqTime = Date.now() - seqStart;
  console.log(`Total Sequential Time: ${seqTime}ms`);

  // Measure parallel fetches
  console.log('\n--- Running Parallel Fetches (Promise.all) ---');
  const parStart = Date.now();
  console.time('Parallel - All');

  try {
    const promises = [
      scraper.fetchQuote(symbol).catch(e => ({ error: e.message })),
      scraper.fetchYahooFundamentals(symbol).catch(e => ({ error: e.message }))
    ];
    if (isIndian) {
      promises.push(scraper.fetchScreenerData(symbol).catch(e => ({ error: e.message })));
    }

    const results = await Promise.all(promises);
    console.timeEnd('Parallel - All');
    
    const quote = results[0];
    const yahoo = results[1];
    const screener = isIndian ? results[2] : null;

    console.log(`  Quote: ${quote && quote.price ? 'Success' : 'Failed'}`);
    console.log(`  Yahoo: ${yahoo && !yahoo.error ? 'Success' : 'Failed'}`);
    if (isIndian) {
      console.log(`  Screener: ${screener && !screener.error ? 'Success' : 'Failed'}`);
    }
  } catch (e) {
    console.error('Parallel - All failed:', e.message);
  }

  const parTime = Date.now() - parStart;
  console.log(`Total Parallel Time: ${parTime}ms`);
  
  const savings = seqTime - parTime;
  const savingsPct = ((savings / seqTime) * 100).toFixed(1);
  console.log(`\nTime saved: ${savings}ms (${savingsPct}% faster)`);
  console.log(`========================================`);
}

async function main() {
  // Test with Indian stocks
  await runTest('RELIANCE.NS');
  await runTest('TCS.NS');
}

main().catch(console.error);
