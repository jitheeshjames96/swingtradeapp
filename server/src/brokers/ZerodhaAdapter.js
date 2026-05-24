const axios = require('axios');
const BrokerAdapter = require('./BrokerAdapter');
const BrokerRequestQueue = require('./BrokerRequestQueue');

class ZerodhaAdapter extends BrokerAdapter {
  constructor(credentials = {}) {
    super(credentials);
    // credentials: { apiKey, accessToken }
    this.queue = new BrokerRequestQueue(334); // Spacing for ~3 requests/second
  }

  async authenticate(authParams) {
    this.credentials.apiKey = authParams.apiKey || this.credentials.apiKey;
    this.credentials.accessToken = authParams.accessToken || this.credentials.accessToken;
    return this.credentials;
  }

  async getHoldings() {
    const { apiKey, accessToken } = this.credentials;
    if (!apiKey || !accessToken) {
      throw new Error("Zerodha Adapter: Missing apiKey or accessToken");
    }

    // Local Bypass Mode / Mock Mode
    if (accessToken === 'DEMO_BYPASS' || accessToken === 'mock_token') {
      console.log("[Zerodha] Using demo/mock holdings...");
      return [
        { symbol: 'RELIANCE.NS', averagePrice: 1320.50, quantity: 15 },
        { symbol: 'TCS.NS', averagePrice: 2280.00, quantity: 8 },
        { symbol: 'INFY.NS', averagePrice: 1190.00, quantity: 20 },
        { symbol: 'AAPL', averagePrice: 175.20, quantity: 10 }
      ];
    }

    try {
      const response = await this.queue.add(() =>
        axios.get('https://api.kite.trade/portfolio/holdings', {
          headers: {
            'X-Kite-Version': '3',
            'Authorization': `token ${apiKey}:${accessToken}`
          },
          timeout: 8000
        })
      );

      const data = response.data?.data || [];
      return data.map(item => {
        let symbol = item.tradingsymbol;
        if (item.exchange === 'NSE') {
          symbol += '.NS';
        } else if (item.exchange === 'BSE') {
          symbol += '.BO';
        }
        return {
          symbol: symbol.toUpperCase(),
          averagePrice: parseFloat(item.average_price),
          quantity: parseInt(item.quantity)
        };
      });
    } catch (err) {
      console.error("[Zerodha] Failed to fetch holdings:", err.message);
      throw new Error(`Zerodha API failed: ${err.message}`);
    }
  }

  async getPositions() {
    const { apiKey, accessToken } = this.credentials;
    if (!apiKey || !accessToken) {
      throw new Error("Zerodha Adapter: Missing apiKey or accessToken");
    }

    if (accessToken === 'DEMO_BYPASS' || accessToken === 'mock_token') {
      return [];
    }

    try {
      const response = await this.queue.add(() =>
        axios.get('https://api.kite.trade/portfolio/positions', {
          headers: {
            'X-Kite-Version': '3',
            'Authorization': `token ${apiKey}:${accessToken}`
          },
          timeout: 8000
        })
      );
      return response.data?.data || [];
    } catch (err) {
      throw new Error(`Zerodha positions API failed: ${err.message}`);
    }
  }

  async placeOrder(orderParams) {
    const { apiKey, accessToken } = this.credentials;
    if (!apiKey || !accessToken) {
      throw new Error("Zerodha Adapter: Missing credentials");
    }

    if (accessToken === 'DEMO_BYPASS') {
      return { status: 'success', order_id: 'MOCK_ORDER_12345' };
    }

    try {
      const response = await this.queue.add(() =>
        axios.post('https://api.kite.trade/orders/regular', orderParams, {
          headers: {
            'X-Kite-Version': '3',
            'Authorization': `token ${apiKey}:${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 8000
        })
      );
      return response.data;
    } catch (err) {
      throw new Error(`Zerodha order placement failed: ${err.message}`);
    }
  }
}

module.exports = ZerodhaAdapter;

