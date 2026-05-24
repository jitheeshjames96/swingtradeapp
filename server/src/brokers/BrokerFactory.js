const ZerodhaAdapter = require('./ZerodhaAdapter');
const UpstoxAdapter = require('./UpstoxAdapter');

class BrokerFactory {
  static getAdapter(brokerName, credentials = {}) {
    const name = (brokerName || '').toUpperCase();
    switch (name) {
      case 'ZERODHA':
        return new ZerodhaAdapter(credentials);
      case 'UPSTOX':
        return new UpstoxAdapter(credentials);
      default:
        throw new Error(`BrokerFactory: Unsupported broker "${brokerName}"`);
    }
  }
}

module.exports = BrokerFactory;
