class BrokerRequestQueue {
  constructor(minSpacingMs = 200) {
    this.minSpacingMs = minSpacingMs;
    this.queue = [];
    this.running = false;
    this.lastRequestTime = 0;
  }

  async add(requestFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ requestFn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running) return;
    this.running = true;

    while (this.queue.length > 0) {
      const { requestFn, resolve, reject } = this.queue.shift();
      const now = Date.now();
      const timeSinceLast = now - this.lastRequestTime;
      const delay = Math.max(0, this.minSpacingMs - timeSinceLast);

      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
      }

      this.lastRequestTime = Date.now();
      try {
        const result = await requestFn();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }

    this.running = false;
  }
}

module.exports = BrokerRequestQueue;
