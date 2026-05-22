const fs = require('fs');
const path = require('path');

global.window = { location: { protocol: 'https:', origin: 'https://swing-trading-app-nine.vercel.app' } };
global.localStorage = { getItem: (key) => key === 'swing_backend_url' ? 'https://swing-trading-app-nine.vercel.app' : null, setItem: () => {} };
global.document = { getElementById: () => ({}) };

const nativeFetch = globalThis.fetch;
global.fetch = async (url, options) => nativeFetch(url, options);

const apiCode = fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8');
eval(apiCode);
const analysisCode = fs.readFileSync(path.join(__dirname, '../js/analysis.js'), 'utf8');
eval(analysisCode);

async function run() {
  const fund = await window.API.fetchFundamentals('RELIANCE.NS');
  console.log('--- Raw Fundamentals ---');
  console.log(JSON.stringify(fund, null, 2));
}
run();
