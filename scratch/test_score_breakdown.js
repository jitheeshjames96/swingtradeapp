const fs = require('fs');
const path = require('path');

// Mock browser globals
global.window = {
  location: { protocol: 'https:', origin: 'https://swing-trading-app-nine.vercel.app' }
};
global.localStorage = {
  getItem: (key) => {
    if (key === 'swing_backend_url') return 'http://localhost:3000';
    return null;
  },
  setItem: () => {}
};
global.document = {
  getElementById: (id) => ({ className: '', innerHTML: '', title: '' })
};

const nativeFetch = globalThis.fetch;
global.fetch = async (url, options) => nativeFetch(url, options);

// Load API.JS
const apiCode = fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8');
eval(apiCode);
global.API = window.API;

// Load ANALYSIS.JS
const analysisCode = fs.readFileSync(path.join(__dirname, '../js/analysis.js'), 'utf8');
eval(analysisCode);
global.Analysis = window.Analysis;

async function run() {
  try {
    console.log('Running detailed scoring analysis on RELIANCE.NS...');
    const result = await Analysis.analyzeStock('RELIANCE.NS', 'Reliance Industries', 'Energy');
    console.log('--- Scores ---');
    console.log(JSON.stringify(result.scores, null, 2));
  } catch (err) {
    console.error('Error during analysis:', err);
  }
}
run();
