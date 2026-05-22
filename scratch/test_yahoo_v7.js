const axios = require('axios');

const symbols = ['TCS.NS', 'AAPL'];

async function testChartMeta() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  };

  for (const symbol of symbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
      const response = await axios.get(url, { headers });
      const result = response.data?.chart?.result?.[0];
      
      if (!result) {
        console.log(`❌ No data found for ${symbol}`);
        continue;
      }

      console.log(`=========================================`);
      console.log(`📈 Symbol: ${symbol}`);
      console.log(`Metadata keys:`, Object.keys(result.meta || {}));
      console.log(`Metadata details:`, JSON.stringify(result.meta, null, 2));
    } catch (e) {
      console.log(`❌ Error fetching ${symbol}:`, e.message);
    }
  }
}

testChartMeta();
