const axios = require('axios');

async function getYahooAuth() {
  const authHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  };

  // 1. Get Cookie from fc.yahoo.com
  const cookieResponse = await axios.get('https://fc.yahoo.com/', {
    headers: authHeaders,
    validateStatus: () => true
  });

  const cookies = cookieResponse.headers['set-cookie'] || [];
  const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

  if (!cookieHeader) {
    throw new Error('No cookie returned from fc.yahoo.com');
  }

  // 2. Get Crumb using the cookie
  const crumbResponse = await axios.get('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      ...authHeaders,
      'Cookie': cookieHeader,
    }
  });

  const crumb = crumbResponse.data;
  if (!crumb) {
    throw new Error('No crumb returned from getcrumb endpoint');
  }

  return { cookie: cookieHeader, crumb };
}

async function runTest() {
  try {
    const { cookie, crumb } = await getYahooAuth();
    console.log(`Successfully obtained Auth! Cookie length: ${cookie.length}, Crumb: ${crumb}`);

    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,TCS.NS&crumb=${crumb}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Cookie': cookie
      }
    });

    const result = response.data?.quoteResponse?.result;
    console.log(`Retrieved ${result?.length} quotes successfully!`);
    if (result && result.length > 0) {
      console.log('Sample AAPL data:', JSON.stringify(result[0], null, 2));
    }
  } catch (e) {
    console.error('Test failed:', e.message);
  }
}

runTest();
