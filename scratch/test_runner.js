const fs = require('fs');
const path = require('path');

// Mock browser globals
global.window = {
  location: {
    protocol: 'https:',
    origin: 'https://swing-trading-app-nine.vercel.app'
  }
};
global.localStorage = {
  getItem: (key) => {
    if (key === 'swing_backend_url') return 'https://swing-trading-app-nine.vercel.app';
    return null;
  },
  setItem: () => {}
};
global.document = {
  getElementById: (id) => {
    return {
      className: '',
      innerHTML: '',
      title: ''
    };
  }
};
const nativeFetch = globalThis.fetch;
global.fetch = async (url, options) => {
  return nativeFetch(url, options);
};
global.console = console;

// Load API.JS
const apiCode = fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8');
eval(apiCode); // defines global API
global.API = window.API;

// Load ANALYSIS.JS
const analysisCode = fs.readFileSync(path.join(__dirname, '../js/analysis.js'), 'utf8');
eval(analysisCode); // defines global Analysis
global.Analysis = window.Analysis;

async function test() {
  console.log('Testing RELIANCE.NS...');
  try {
    const result = await Analysis.analyzeStock('RELIANCE.NS', 'Reliance Industries', 'Energy');
    console.log('RELIANCE.NS Analysis Success!');
    console.log('Composite Score:', result.scores.composite);
  } catch (err) {
    console.error('RELIANCE.NS Analysis Failed:', err);
  }

  console.log('\nTesting RELIANCE...');
  try {
    const result = await Analysis.analyzeStock('RELIANCE', 'Reliance Industries', 'Energy');
    console.log('RELIANCE Analysis Success!');
    console.log('Composite Score:', result.scores.composite);
  } catch (err) {
    console.error('RELIANCE Analysis Failed:', err);
  }
}

test();
