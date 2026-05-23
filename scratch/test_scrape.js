const axios = require('axios');

async function test() {
  try {
    const res = await axios.get('https://query1.finance.yahoo.com/v1/finance/search?q=AAPL', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    console.log(JSON.stringify(res.data.quotes, null, 2));
  } catch (err) {
    console.error(err.message);
  }
}

test();
