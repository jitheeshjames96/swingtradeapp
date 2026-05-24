const axios = require('axios');
const BrokerAdapter = require('./BrokerAdapter');
const BrokerRequestQueue = require('./BrokerRequestQueue');

class UpstoxAdapter extends BrokerAdapter {
  constructor(credentials = {}) {
    super(credentials);
    // credentials: { accessToken }
    this.queue = new BrokerRequestQueue(125); // Spacing for ~8 requests/second
  }

  async authenticate(authParams) {
    this.credentials.accessToken = authParams.accessToken || this.credentials.accessToken;
    return this.credentials;
  }

  async getHoldings() {
    const { accessToken } = this.credentials;
    if (!accessToken) {
      throw new Error("Upstox Adapter: Missing accessToken");
    }

    // Local Bypass Mode / Mock Mode
    if (accessToken === 'DEMO_BYPASS' || accessToken === 'mock_token') {
      console.log("[Upstox] Using demo/mock holdings...");
      return [
        { symbol: 'RELIANCE.NS', averagePrice: 1315.00, quantity: 10 },
        { symbol: 'SBIN.NS', averagePrice: 560.50, quantity: 25 },
        { symbol: 'TCS.NS', averagePrice: 2290.00, quantity: 5 }
      ];
    }

    try {
      const response = await this.queue.add(() =>
        axios.get('https://api.upstox.com/v2/portfolio/long-term-holdings', {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          },
          timeout: 8000
        })
      );

      const data = response.data?.data || [];
      return data.map(item => {
        let symbol = item.trading_symbol;
        // Upstox symbols may come as 'RELIANCE' and exchange as 'NSE_EQ'
        // Ensure standard suffix
        const exchange = (item.exchange || '').toUpperCase();
        if (exchange.startsWith('NSE') && !symbol.endsWith('.NS')) {
          symbol += '.NS';
        } else if (exchange.startsWith('BSE') && !symbol.endsWith('.BO')) {
          symbol += '.BO';
        }
        return {
          symbol: symbol.toUpperCase(),
          averagePrice: parseFloat(item.average_price),
          quantity: parseInt(item.quantity)
        };
      });
    } catch (err) {
      console.error("[Upstox] Failed to fetch holdings:", err.message);
      throw new Error(`Upstox API failed: ${err.message}`);
    }
  }

  async getPositions() {
    const { accessToken } = this.credentials;
    if (!accessToken) throw new Error("Upstox Adapter: Missing accessToken");

    if (accessToken === 'DEMO_BYPASS' || accessToken === 'mock_token') {
      return [];
    }

    try {
      const response = await this.queue.add(() =>
        axios.get('https://api.upstox.com/v2/portfolio/short-term-positions', {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          },
          timeout: 8000
        })
      );
      return response.data?.data || [];
    } catch (err) {
      throw new Error(`Upstox positions API failed: ${err.message}`);
    }
  }

  async placeOrder(orderParams) {
    const { accessToken } = this.credentials;
    if (!accessToken) throw new Error("Upstox Adapter: Missing credentials");

    if (accessToken === 'DEMO_BYPASS') {
      return { status: 'success', data: { order_id: 'MOCK_UPSTOX_ORDER_123' } };
    }

    try {
      const response = await this.queue.add(() =>
        axios.post('https://api.upstox.com/v2/order/place', orderParams, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 8000
        })
      );
      return response.data;
    } catch (err) {
      throw new Error(`Upstox order placement failed: ${err.message}`);
    }
  }
}

module.exports = UpstoxAdapter;

