class BrokerAdapter {
  constructor(credentials = {}) {
    this.credentials = credentials;
  }

  /**
   * Authenticate / trade authorization.
   * @param {Object} authParams 
   * @returns {Promise<Object>} Auth credentials/tokens
   */
  async authenticate(authParams) {
    throw new Error("authenticate() not implemented");
  }

  /**
   * Fetch current holdings.
   * @returns {Promise<Array>} List of holdings [{ symbol, averagePrice, quantity }]
   */
  async getHoldings() {
    throw new Error("getHoldings() not implemented");
  }

  /**
   * Fetch current open positions.
   * @returns {Promise<Array>} List of positions
   */
  async getPositions() {
    throw new Error("getPositions() not implemented");
  }

  /**
   * Place an order.
   * @param {Object} orderParams 
   * @returns {Promise<Object>} Order confirmation
   */
  async placeOrder(orderParams) {
    throw new Error("placeOrder() not implemented");
  }
}

module.exports = BrokerAdapter;
