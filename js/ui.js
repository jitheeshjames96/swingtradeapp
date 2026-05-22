/* ============================================================
   UI.JS — DOM rendering helpers
   ============================================================ */

const UI = (() => {

  // ── Toast notifications
  function toast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; el.style.transition = 'all 0.3s'; setTimeout(() => el.remove(), 300); }, duration);
  }

  // ── Format helpers
  function fmt(val, decimals = 2) {
    if (val === null || val === undefined || isNaN(val)) return 'N/A';
    return parseFloat(val).toFixed(decimals);
  }
  function fmtCr(val) {
    if (!val) return 'N/A';
    const cr = val / 1e7;
    if (cr >= 1e5) return '₹' + (cr / 1e5).toFixed(2) + 'L Cr';
    if (cr >= 1e3) return '₹' + (cr / 1e3).toFixed(2) + 'K Cr';
    return '₹' + cr.toFixed(0) + ' Cr';
  }
  function fmtVol(val) {
    if (!val) return 'N/A';
    if (val >= 1e7) return (val / 1e7).toFixed(2) + ' Cr';
    if (val >= 1e5) return (val / 1e5).toFixed(2) + ' L';
    return val.toLocaleString();
  }
  function fmtPct(val) {
    if (val === null || val === undefined) return 'N/A';
    const sign = val >= 0 ? '+' : '';
    return sign + parseFloat(val).toFixed(2) + '%';
  }
  function colorClass(val) { return val >= 0 ? 'pos' : 'neg'; }

  // ── Market ticker strip
  function renderMarketTickers(indices) {
    const wrap = document.getElementById('market-tickers');
    if (!wrap) return;
    wrap.innerHTML = indices.map(idx => `
      <div class="market-ticker">
        <div class="mt-name">${idx.name}</div>
        <div class="mt-value ${colorClass(idx.change)}">${idx.price ? idx.price.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'}</div>
        <div class="mt-change ${colorClass(idx.change)}">${fmtPct(idx.change)}</div>
      </div>
    `).join('');
  }

  // ── Fear & Greed Widget
  function renderFearGreed(data) {
    const el = document.getElementById('fg-value');
    const textEl = document.getElementById('fg-text');
    if (!el || !data) return;
    const val = data.value;
    let color;
    if (val <= 25) color = '#ef4444';
    else if (val <= 45) color = '#f97316';
    else if (val <= 55) color = '#f59e0b';
    else if (val <= 75) color = '#22c55e';
    else color = '#10b981';
    el.textContent = val;
    el.style.color = color;
    if (textEl) { textEl.textContent = data.text; textEl.style.color = color; }
  }

  // ── Sector Heatmap
  function renderSectorHeatmap(sectors) {
    const grid = document.getElementById('sector-grid');
    if (!grid) return;
    grid.innerHTML = sectors.map(s => {
      const cls = s.change > 0.5 ? 'bullish' : s.change < -0.5 ? 'bearish' : 'neutral';
      const changeColor = s.change >= 0 ? 'var(--green)' : 'var(--red)';
      return `
        <div class="sector-tile ${cls}" title="${s.name}">
          <div class="st-name">${s.icon} ${s.name}</div>
          <div class="st-change" style="color:${changeColor}">${fmtPct(s.change)}</div>
        </div>
      `;
    }).join('');
  }

  // ── Watchlist item
  function renderWatchlistItem(result, isActive = false) {
    const { symbol, name, quote, scores } = result;
    const score = scores.composite.total;
    const fillColor = score >= 80 ? '#10b981' : score >= 65 ? '#22c55e' : score >= 50 ? '#f59e0b' : score >= 35 ? '#f97316' : '#ef4444';
    const initials = symbol.replace('.NS','').replace('.BO','').slice(0, 3);
    return `
      <div class="watchlist-item ${isActive ? 'active' : ''} fade-in" data-symbol="${symbol}" onclick="App.selectStock('${symbol}')">
        <div class="wi-avatar">${initials}</div>
        <div class="wi-info">
          <div class="wi-symbol">${symbol.replace('.NS','').replace('.BO','')}</div>
          <div class="wi-name">${name}</div>
          <div class="wi-score-bar">
            <div class="wi-score-fill" style="width:${score}%;background:${fillColor}"></div>
          </div>
        </div>
        <div class="wi-right">
          <div class="wi-price ${colorClass(quote.changePct)}">₹${fmt(quote.price, 1)}</div>
          <div class="wi-change ${colorClass(quote.changePct)}">${fmtPct(quote.changePct)}</div>
        </div>
        <button class="wi-remove" onclick="event.stopPropagation();App.removeStock('${symbol}')" title="Remove">✕</button>
      </div>
    `;
  }

  // ── Recommendation Card
  function renderRecCard(result) {
    const { symbol, name, quote, scores } = result;
    const { composite, fundamental, technical, sentiment, institutional } = scores;
    const fillClass = Analysis.scoreFillClass(composite.total);
    const badgeClass = Analysis.scoreBadgeClass(composite.ratingClass);

    return `
      <div class="rec-card ${composite.ratingClass} fade-in" onclick="App.selectStock('${symbol}')">
        <div class="rc-top">
          <div class="rc-symbol-wrap">
            <div class="rc-symbol">${symbol.replace('.NS','').replace('.BO','')}</div>
            <div class="rc-name">${name}</div>
          </div>
          <div class="rating-badge ${badgeClass}">${composite.emoji} ${composite.rating}</div>
        </div>
        <div class="rc-price-row">
          <div class="rc-price ${colorClass(quote.changePct)}">₹${fmt(quote.price, 1)}</div>
          <div class="rc-change ${colorClass(quote.changePct)}">${fmtPct(quote.changePct)}</div>
        </div>
        <div class="rc-score-section">
          <div class="rc-score-label">
            Composite Score
            <span class="rc-score-num" style="color:${Analysis.scoreColor(composite.total, 100)}">${composite.total}/100</span>
          </div>
          <div class="score-bar">
            <div class="score-fill ${fillClass}" style="width:${composite.total}%"></div>
          </div>
        </div>
        <div class="rc-mini-stats">
          <div class="rc-mini-stat">
            <div class="rcms-label">Fund.</div>
            <div class="rcms-val" style="color:${Analysis.scoreColor(fundamental.score,25)}">${fundamental.score}/25</div>
          </div>
          <div class="rc-mini-stat">
            <div class="rcms-label">Tech.</div>
            <div class="rcms-val" style="color:${Analysis.scoreColor(technical.score,30)}">${technical.score}/30</div>
          </div>
          <div class="rc-mini-stat">
            <div class="rcms-label">Inst.</div>
            <div class="rcms-val" style="color:${Analysis.scoreColor(institutional.score,25)}">${institutional.score}/25</div>
          </div>
        </div>
      </div>
    `;
  }

  // ── Detail Header
  function renderDetailHeader(result) {
    const { symbol, name, sector, quote, scores, tradeSetup } = result;
    const { composite, fundamental, technicalSetup, momentum, sentimentFlow } = scores;
    const badgeClass = Analysis.scoreBadgeClass(composite.ratingClass);

    document.getElementById('dh-symbol').textContent = symbol.replace('.NS','').replace('.BO','');
    document.getElementById('dh-name').textContent = name;
    document.getElementById('dh-sector').textContent = sector;
    document.getElementById('dh-price').textContent = `₹${fmt(quote.price, 2)}`;
    document.getElementById('dh-change').textContent = fmtPct(quote.changePct);
    document.getElementById('dh-change').className = `dh-change ${colorClass(quote.changePct)}`;
    document.getElementById('dh-change-abs').textContent = `(${fmtPct(quote.change)})`;

    // Score breakdown
    document.getElementById('dh-total-score').textContent = composite.total;
    document.getElementById('dh-total-score').style.color = Analysis.scoreColor(composite.total, 100);
    document.getElementById('dh-rating').textContent = `${composite.emoji} ${composite.rating}`;
    document.getElementById('dh-rating').className = `rating-badge ${badgeClass}`;
    document.getElementById('dh-fund-score').textContent = fundamental.score + '/25';
    document.getElementById('dh-tech-score').textContent = technicalSetup.score + '/25';
    document.getElementById('dh-sent-score').textContent = momentum.score + '/25';
    document.getElementById('dh-inst-score').textContent = sentimentFlow.score + '/25';
  }

  // ── Fundamental Tab
  function renderFundamentals(result) {
    const { fund, scores, quote } = result;
    const f = fund;

    document.getElementById('tab-fundamental').innerHTML = `
      <div class="fundamental-grid">
        ${fundCard('P/E Ratio', fmt(f.pe, 1), f.forwardPE ? `Fwd: ${fmt(f.forwardPE,1)}` : '', peColor(f.pe))}
        ${fundCard('Industry P/E', f.industryPe ? fmt(f.industryPe, 1) : 'N/A', 'Sector Average', '')}
        ${fundCard('EPS', f.eps ? '₹' + fmt(f.eps, 2) : 'N/A', 'Trailing 12M', '')}
        ${fundCard('P/B Ratio', fmt(f.pb, 2), 'Price to Book', pbColor(f.pb))}
        ${fundCard('ROE', f.roe ? fmt(f.roe, 1) + '%' : 'N/A', 'Return on Equity', roeColor(f.roe))}
        ${fundCard('Debt/Equity', fmt(f.debtToEquity, 2), 'Leverage ratio', deColor(f.debtToEquity))}
        ${fundCard('Revenue Growth', f.revenueGrowth ? fmtPct(f.revenueGrowth) : 'N/A', 'Year-on-Year', growthColor(f.revenueGrowth))}
        ${fundCard('Earnings Growth', f.earningsGrowth ? fmtPct(f.earningsGrowth) : 'N/A', 'YoY earnings', growthColor(f.earningsGrowth))}
        ${fundCard('Profit Margin', f.profitMargin ? fmt(f.profitMargin, 1) + '%' : 'N/A', 'Net margin', roeColor(f.profitMargin))}
        ${fundCard('Market Cap', fmtCr(f.marketCap || quote.marketCap), 'Total market value', '')}
        ${fundCard('Beta', fmt(f.beta, 2), 'Market sensitivity', betaColor(f.beta))}
        ${fundCard('Dividend Yield', f.dividendYield ? fmt(f.dividendYield, 2) + '%' : '—', 'Annual dividend', '')}
        ${fundCard('Current Ratio', fmt(f.currentRatio, 2), 'Liquidity ratio', crColor(f.currentRatio))}
      </div>

      <div class="disclaimer">
        ⚠️ &nbsp; Fundamental data sourced from Yahoo Finance. May have 15–24hr delay.
      </div>

      <div class="earnings-section" style="margin-top:20px">
        <div class="section-title">📊 Quarterly Earnings History</div>
        <div class="chart-wrap" style="height:240px">
          <canvas id="chart-earnings-quarterly"></canvas>
        </div>
      </div>
      <div class="earnings-section" style="margin-top:20px">
        <div class="section-title">📈 Annual Revenue & Income (5 Years)</div>
        <div class="chart-wrap" style="height:220px">
          <canvas id="chart-earnings-annual"></canvas>
        </div>
      </div>

      <div class="earnings-section" style="margin-top:20px">
        <div class="section-title">🗓 Quarterly Table</div>
        <div style="overflow-x:auto">
          <table class="data-table">
            <thead><tr>
              <th>Period</th><th>Revenue (₹ Cr)</th><th>Net Income (₹ Cr)</th><th>EPS</th><th>YoY Rev</th>
            </tr></thead>
            <tbody>
              ${result.earnings.quarterly.slice(0, 8).map((q, i, arr) => {
                const prev = arr[i + 1];
                const yoy = prev && prev.revenue ? ((q.revenue - prev.revenue) / prev.revenue * 100) : null;
                return `<tr>
                  <td>${q.period}</td>
                  <td>₹${(q.revenue/1e7).toFixed(0)}</td>
                  <td class="${q.netIncome >= 0 ? 'pos' : 'neg'}">₹${(q.netIncome/1e7).toFixed(0)}</td>
                  <td>${q.eps !== null ? '₹' + fmt(q.eps, 2) : 'N/A'}</td>
                  <td class="${yoy !== null ? colorClass(yoy) : ''}">${yoy !== null ? fmtPct(yoy) : '—'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="earnings-section" style="margin-top:20px">
        <div class="section-title">📆 Annual Table (5 Years)</div>
        <div style="overflow-x:auto">
          <table class="data-table">
            <thead><tr>
              <th>Year</th><th>Revenue (₹ Cr)</th><th>Net Income (₹ Cr)</th><th>EPS</th><th>Rev Growth</th>
            </tr></thead>
            <tbody>
              ${result.earnings.annual.slice(0, 5).map((a, i, arr) => {
                const prev = arr[i + 1];
                const yoy = prev && prev.revenue ? ((a.revenue - prev.revenue) / prev.revenue * 100) : null;
                return `<tr>
                  <td>${a.period}</td>
                  <td>₹${(a.revenue/1e7).toFixed(0)}</td>
                  <td class="${a.netIncome >= 0 ? 'pos' : 'neg'}">₹${(a.netIncome/1e7).toFixed(0)}</td>
                  <td>${a.eps !== null ? '₹' + fmt(a.eps, 2) : 'N/A'}</td>
                  <td class="${yoy !== null ? colorClass(yoy) : ''}">${yoy !== null ? fmtPct(yoy) : '—'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="earnings-section" style="margin-top:20px">
        <div class="section-title">🎯 Score Breakdown — Fundamentals</div>
        ${renderScoreBreakdown(scores.fundamental.checklist)}
      </div>
    `;
    // Render charts after DOM update
    setTimeout(() => {
      Charts.renderEarningsChart('chart-earnings-quarterly', result.earnings);
      Charts.renderAnnualEarningsChart('chart-earnings-annual', result.earnings);
    }, 50);
  }

  function fundCard(label, value, sub, colorHex) {
    return `
      <div class="fund-card">
        <div class="fc-label">${label}</div>
        <div class="fc-value" style="${colorHex ? 'color:' + colorHex : ''}">${value}</div>
        ${sub ? `<div class="fc-sub">${sub}</div>` : ''}
      </div>
    `;
  }

  function peColor(pe) {
    if (!pe || pe <= 0) return '';
    if (pe < 15) return 'var(--green)';
    if (pe < 25) return '#22c55e';
    if (pe < 35) return 'var(--yellow)';
    if (pe < 50) return 'var(--orange)';
    return 'var(--red)';
  }
  function pbColor(pb) {
    if (!pb) return '';
    if (pb < 1) return 'var(--green)';
    if (pb < 3) return '#22c55e';
    if (pb < 5) return 'var(--yellow)';
    return 'var(--red)';
  }
  function roeColor(roe) {
    if (!roe) return '';
    if (roe > 20) return 'var(--green)';
    if (roe > 12) return 'var(--yellow)';
    return 'var(--red)';
  }
  function deColor(de) {
    if (!de) return '';
    if (de < 0.5) return 'var(--green)';
    if (de < 1) return 'var(--yellow)';
    if (de < 1.5) return 'var(--orange)';
    return 'var(--red)';
  }
  function growthColor(g) {
    if (g === null) return '';
    if (g > 20) return 'var(--green)';
    if (g > 5) return 'var(--yellow)';
    if (g >= 0) return 'var(--orange)';
    return 'var(--red)';
  }
  function betaColor(b) {
    if (!b) return '';
    if (b < 0.8) return 'var(--green)';
    if (b < 1.2) return 'var(--yellow)';
    return 'var(--red)';
  }
  function crColor(cr) {
    if (!cr) return '';
    if (cr > 2) return 'var(--green)';
    if (cr > 1) return 'var(--yellow)';
    return 'var(--red)';
  }

  // ── Technical Tab
  function renderTechnicals(result) {
    const { scores, quote, historical } = result;
    const techInds = scores.technicalSetup.indicators;
    const momInds = scores.momentum.indicators;
    const sr = techInds.sr || {};
    const vd = techInds.volData || {};
    const currentPrice = quote.price;

    const trendColor = techInds.trend === 'uptrend' ? 'var(--green)' : techInds.trend === 'downtrend' ? 'var(--red)' : 'var(--yellow)';
    const trendEmoji = techInds.trend === 'uptrend' ? '📈' : techInds.trend === 'downtrend' ? '📉' : '➡️';

    document.getElementById('tab-technical').innerHTML = `
      <div class="technical-grid">
        ${techIndicator('RSI (14)', fmt(momInds.rsi, 1), momInds.rsiSignal, rsiSignalClass(momInds.rsi))}
        ${techIndicator('MACD', fmt(momInds.macd, 3), momInds.macdCrossover ? '🔥 Bullish Crossover!' : momInds.macdBullish ? 'Bullish' : 'Bearish', momInds.macdBullish ? 'signal-bullish' : 'signal-bearish')}
        ${techIndicator('SMA 20', techInds.sma20 ? '₹' + fmt(techInds.sma20, 1) : 'N/A', currentPrice > (techInds.sma20||0) ? 'Price Above ↑' : 'Price Below ↓', currentPrice > (techInds.sma20||0) ? 'signal-bullish' : 'signal-bearish')}
        ${techIndicator('SMA 50', techInds.sma50 ? '₹' + fmt(techInds.sma50, 1) : 'N/A', currentPrice > (techInds.sma50||0) ? 'Price Above ↑' : 'Price Below ↓', currentPrice > (techInds.sma50||0) ? 'signal-bullish' : 'signal-bearish')}
        ${techIndicator('SMA 200', techInds.sma200 ? '₹' + fmt(techInds.sma200, 1) : 'N/A', currentPrice > (techInds.sma200||0) ? 'Golden Zone ☀️' : 'Below 200 SMA', currentPrice > (techInds.sma200||0) ? 'signal-bullish' : 'signal-bearish')}
        ${techIndicator('ATR (14)', momInds.atr ? '₹' + fmt(momInds.atr, 2) : 'N/A', 'Avg True Range (volatility)', 'signal-neutral')}
        ${techIndicator('Trend', `${trendEmoji} ${techInds.trend.charAt(0).toUpperCase() + techInds.trend.slice(1)}`, 'SMA crossover analysis', techInds.trend === 'uptrend' ? 'signal-bullish' : techInds.trend === 'downtrend' ? 'signal-bearish' : 'signal-neutral')}
        ${techIndicator('Vol Ratio', `${vd.latestRatio || 1}x`, vd.accumulation ? '🏦 Accumulation Signal' : vd.distribution ? '🏦 Distribution Signal' : 'Normal Activity', vd.latestRatio > 1.5 ? 'signal-bullish' : 'signal-neutral')}
      </div>

      <div class="section-title" style="margin-bottom:12px">🎯 Key Price Levels</div>
      <div class="levels-grid" style="margin-bottom:20px">
        ${levelItem('R2', sr.r2, 'Resistance 2', 'var(--red)')}
        ${levelItem('R1', sr.r1, 'Resistance 1', 'var(--orange)')}
        ${levelItem('Pivot', sr.pivot, 'Pivot Point', 'var(--yellow)')}
        ${levelItem('S1', sr.s1, 'Support 1', '#22c55e')}
        ${levelItem('S2', sr.s2, 'Support 2', 'var(--green)')}
        ${levelItem('Current', currentPrice, 'Market Price', 'var(--text-accent)')}
      </div>

      <div class="section-title" style="margin-bottom:12px">💰 Trade Setup (ATR-Based)</div>
      <div class="levels-grid" style="margin-bottom:20px">
        ${levelItem('Entry', currentPrice, 'Current Price', 'var(--text-accent)')}
        ${levelItem('Stop Loss', result.tradeSetup.stopLoss, '1.5× ATR below', 'var(--red)')}
        ${levelItem('Target 1', result.tradeSetup.target1, '2× ATR (quick)', '#22c55e')}
        ${levelItem('Target 2', result.tradeSetup.target2, '4× ATR (swing)', 'var(--green)')}
        ${levelItem('Target 3', result.tradeSetup.target3, 'R2 / Extension', '#06b6d4')}
        ${levelItem('R/R Ratio', result.tradeSetup.riskReward + 'x', 'Risk:Reward', result.tradeSetup.riskReward >= 2 ? 'var(--green)' : 'var(--yellow)')}
      </div>

      <div class="section-title" style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
        <span>📈 TradingView Interactive Chart</span>
        <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">Candlestick Feed</span>
      </div>
      <div class="chart-wrap" style="height:400px; margin-bottom:20px; border-radius:var(--radius-md); overflow:hidden; border:1px solid var(--border)">
        <div id="tradingview_widget" style="width:100%; height:100%"></div>
      </div>

      <div class="section-title" style="margin-bottom:12px">📊 Price Chart (90 Days)</div>
      <div class="chart-wrap" style="height:240px; margin-bottom:16px">
        <canvas id="chart-price"></canvas>
      </div>

      <div class="section-title" style="margin-bottom:12px">📉 RSI (14)</div>
      <div class="chart-wrap" style="height:160px; margin-bottom:16px">
        <canvas id="chart-rsi"></canvas>
      </div>

      <div class="section-title" style="margin-bottom:12px">📈 MACD</div>
      <div class="chart-wrap" style="height:180px; margin-bottom:16px">
        <canvas id="chart-macd"></canvas>
      </div>

      <div class="section-title" style="margin-bottom:12px">📊 Bollinger Bands (20,2)</div>
      <div class="chart-wrap" style="height:200px; margin-bottom:16px">
        <canvas id="chart-bb"></canvas>
      </div>

      <div class="section-title" style="margin-bottom:12px">🔊 Volume Analysis (60 Days)</div>
      <div class="chart-wrap" style="height:180px; margin-bottom:16px">
        <canvas id="chart-volume"></canvas>
      </div>

      <div class="section-title" style="margin-bottom:12px">🎯 Score Breakdown — Technical Setup</div>
      ${renderScoreBreakdown(scores.technicalSetup.checklist)}
    `;

    setTimeout(() => {
      // Initialize TradingView Widget
      const tvSymbol = getTradingViewSymbol(result.symbol);
      if (tvSymbol && typeof TradingView !== 'undefined') {
        new TradingView.widget({
          width: "100%",
          height: "100%",
          symbol: tvSymbol,
          interval: "D",
          timezone: tvSymbol.startsWith('NSE:') || tvSymbol.startsWith('BSE:') ? "Asia/Kolkata" : "America/New_York",
          theme: "dark",
          style: "1",
          locale: "en",
          toolbar_bg: "#0d1220",
          enable_publishing: false,
          hide_side_toolbar: false,
          allow_symbol_change: false,
          container_id: "tradingview_widget",
          studies: [
            "MASimple@tv-basicstudies",
            "RSI@tv-basicstudies"
          ]
        });
      } else {
        const widgetContainer = document.getElementById('tradingview_widget');
        if (widgetContainer) {
          widgetContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted)">TradingView script not loaded</div>`;
        }
      }

      Charts.renderPriceChart('chart-price', historical, result.symbol);
      Charts.renderRSIChart('chart-rsi', historical);
      Charts.renderMACDChart('chart-macd', historical);
      Charts.renderBBChart('chart-bb', historical);
      Charts.renderVolumeChart('chart-volume', historical);
    }, 50);
  }

  function getTradingViewSymbol(symbol) {
    if (!symbol) return '';
    if (symbol.endsWith('.NS')) {
      return 'NSE:' + symbol.replace('.NS', '');
    }
    if (symbol.endsWith('.BO')) {
      return 'BSE:' + symbol.replace('.BO', '');
    }
    const nasdaqStocks = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NFLX', 'AMD'];
    if (nasdaqStocks.includes(symbol)) {
      return 'NASDAQ:' + symbol;
    }
    const nyseStocks = ['JPM', 'BRK.A', 'BRK.B', 'V', 'MA'];
    if (nyseStocks.includes(symbol)) {
      return 'NYSE:' + symbol;
    }
    return symbol;
  }

  function rsiSignalClass(rsi) {
    if (rsi < 30) return 'signal-bullish';
    if (rsi > 70) return 'signal-bearish';
    return 'signal-neutral';
  }

  function techIndicator(label, value, signal, signalClass) {
    return `
      <div class="tech-indicator">
        <div class="ti-label">${label}</div>
        <div class="ti-value">${value}</div>
        <div class="ti-signal ${signalClass}">${signal}</div>
      </div>
    `;
  }

  function levelItem(type, price, label, color) {
    return `
      <div class="level-item">
        <div class="li-type">${type}</div>
        <div class="li-price" style="color:${color}">₹${price ? parseFloat(price).toFixed(1) : '—'}</div>
        <div class="li-label" style="color:var(--text-muted);font-size:0.68rem">${label}</div>
      </div>
    `;
  }

  // ── Sentiment Tab
  function renderSentiment(result) {
    const { news, fearGreed, scores } = result;
    const fgVal = fearGreed?.value || 50;
    let fgColor, fgEmoji;
    if (fgVal <= 25) { fgColor = 'var(--red)'; fgEmoji = '😱'; }
    else if (fgVal <= 45) { fgColor = 'var(--orange)'; fgEmoji = '😨'; }
    else if (fgVal <= 55) { fgColor = 'var(--yellow)'; fgEmoji = '😐'; }
    else if (fgVal <= 75) { fgColor = '#22c55e'; fgEmoji = '😊'; }
    else { fgColor = 'var(--green)'; fgEmoji = '🤑'; }

    const posNews = news.filter(n => n.sentiment === 'positive').length;
    const negNews = news.filter(n => n.sentiment === 'negative').length;
    const neutNews = news.filter(n => n.sentiment === 'neutral').length;

    document.getElementById('tab-sentiment').innerHTML = `
      <div class="sentiment-grid">
        <div class="sentiment-card">
          <div class="sc-icon">${fgEmoji}</div>
          <div class="sc-title">Fear & Greed Index</div>
          <div class="sc-value" style="color:${fgColor}">${fgVal} — ${fearGreed?.text || 'Neutral'}</div>
          <div class="sc-desc">Market sentiment gauge. Values below 40 are potential buying zones.</div>
        </div>
        <div class="sentiment-card">
          <div class="sc-icon">📰</div>
          <div class="sc-title">News Sentiment</div>
          <div class="sc-value" style="color:${posNews > negNews ? 'var(--green)' : negNews > posNews ? 'var(--red)' : 'var(--yellow)'}">
            ${posNews > negNews ? 'Positive Bias' : negNews > posNews ? 'Negative Bias' : 'Neutral'}
          </div>
          <div class="sc-desc">🟢 ${posNews} Positive &nbsp; 🟡 ${neutNews} Neutral &nbsp; 🔴 ${negNews} Negative</div>
        </div>
        <div class="sentiment-card">
          <div class="sc-icon">🧠</div>
          <div class="sc-title">Market Emotion</div>
          <div class="sc-value" style="color:${fgColor}">${getMarketEmotion(fgVal)}</div>
          <div class="sc-desc">Derived from F&G Index, put/call ratio signals, and price action.</div>
        </div>
        <div class="sentiment-card">
          <div class="sc-icon">🎯</div>
          <div class="sc-title">Sentiment & Flows Score</div>
          <div class="sc-value" style="color:${Analysis.scoreColor(scores.sentimentFlow.score, 25)}">${scores.sentimentFlow.score} / 25</div>
          <div class="sc-desc">Combined sentiment signal for swing trade entry.</div>
        </div>
      </div>

      <div class="section-title" style="margin-bottom:12px">📰 Recent News</div>
      <div class="news-feed">
        ${news.map(n => {
          const dotColor = n.sentiment === 'positive' ? 'var(--green)' : n.sentiment === 'negative' ? 'var(--red)' : 'var(--yellow)';
          return `
            <div class="news-item" onclick="window.open('${n.url}','_blank')">
              <div class="news-sentiment-dot" style="background:${dotColor}"></div>
              <div class="news-content">
                <div class="news-headline">${n.headline}</div>
                <div class="news-meta">
                  <span>${n.source}</span>
                  <span>•</span>
                  <span>${n.time}</span>
                  <span style="color:${dotColor};font-weight:600">${n.sentiment.toUpperCase()}</span>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <div class="section-title" style="margin-top:20px; margin-bottom:12px">🎯 Score Breakdown — Sentiment & Flows</div>
      ${renderScoreBreakdown(scores.sentimentFlow.checklist)}
    `;
  }

  function getMarketEmotion(fgVal) {
    if (fgVal <= 20) return 'Extreme Fear 😱';
    if (fgVal <= 35) return 'Fear 😨';
    if (fgVal <= 55) return 'Neutral 😐';
    if (fgVal <= 75) return 'Greed 😊';
    return 'Extreme Greed 🤑';
  }

  // ── Institutional Tab
  function renderInstitutional(result) {
    const { scores, quote } = result;
    const { indicators } = scores.technical;
    const vd = indicators.volData || {};

    const hasRealShareholding = result.shareholding && (
      (result.shareholding.quarters && result.shareholding.quarters.length > 0) ||
      (result.shareholding.insiders !== null && result.shareholding.insiders !== undefined) ||
      (result.shareholding.institutions !== null && result.shareholding.institutions !== undefined)
    );

    document.getElementById('tab-institutional').innerHTML = `
      <div class="institutional-grid">
        <div class="inst-card">
          <div class="ic-title">🔊 Latest Volume</div>
          <div class="ic-value">${fmtVol(vd.latestVolume)}</div>
          <div class="ic-sub">vs avg ${fmtVol(vd.avgVolume)}</div>
          <div class="ic-bar"><div class="ic-fill" style="width:${Math.min(100, vd.latestRatio * 33)}%;background:${vd.latestRatio > 2 ? 'var(--green)' : 'var(--blue)'}"></div></div>
        </div>
        <div class="inst-card">
          <div class="ic-title">📊 Volume Ratio</div>
          <div class="ic-value" style="color:${vd.latestRatio > 2 ? 'var(--green)' : vd.latestRatio > 1.5 ? 'var(--yellow)' : 'var(--text-primary)'}">${vd.latestRatio || 1}x</div>
          <div class="ic-sub">vs 20-day average</div>
          <div class="ic-bar"><div class="ic-fill" style="width:${Math.min(100, (vd.latestRatio||1) * 25)}%;background:var(--blue)"></div></div>
        </div>
        <div class="inst-card">
          <div class="ic-title">🏦 Inst. Signal</div>
          <div class="ic-value" style="color:${vd.institutionalSignal==='strong'?'var(--green)':vd.institutionalSignal==='moderate'?'var(--yellow)':'var(--text-secondary)'}">${(vd.institutionalSignal||'neutral').toUpperCase()}</div>
          <div class="ic-sub">${vd.accumulation ? '🟢 Accumulation detected' : vd.distribution ? '🔴 Distribution detected' : '⚪ Monitoring phase'}</div>
        </div>
        <div class="inst-card">
          <div class="ic-title">⚡ Volume Spikes</div>
          <div class="ic-value">${vd.spikes || 0}</div>
          <div class="ic-sub">Unusual spikes in last 20 days</div>
          <div class="ic-bar"><div class="ic-fill" style="width:${Math.min(100, (vd.spikes||0) * 14)}%;background:var(--purple)"></div></div>
        </div>
      </div>

      <div class="section-title" style="margin-bottom:12px">📋 Institutional Activity Interpretation</div>
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-md);padding:18px;margin-bottom:20px">
        ${instInterpretation(vd, quote)}
      </div>

      <div class="section-title" style="margin-bottom:12px">📊 Volume Profile (20 Days)</div>
      <div class="volume-profile">
        ${generateVolumeProfile(result.historical)}
      </div>

      ${hasRealShareholding ? `
        <div class="earnings-section" style="margin-top:20px">
          <div class="section-title">📊 Institutional Shareholding Pattern</div>
          <div class="chart-wrap" style="height:240px">
            <canvas id="chart-shareholding"></canvas>
          </div>
        </div>
      ` : `
        <div class="section-title" style="margin-top:20px;margin-bottom:12px">⚠️ FII / DII Note</div>
        <div class="disclaimer">
          ⚠️ &nbsp; FII/DII direct data requires NSE/BSE premium subscription. Values shown are estimated from volume-price behaviour patterns (Smart Money Concept analysis).
        </div>
      `}

      <div class="section-title" style="margin-top:20px; margin-bottom:12px">🎯 Score Breakdown — Sentiment & Flows</div>
      ${renderScoreBreakdown(scores.sentimentFlow.checklist)}
    `;

    if (hasRealShareholding) {
      setTimeout(() => {
        Charts.renderShareholdingChart('chart-shareholding', result.shareholding);
      }, 50);
    }
  }

  function instInterpretation(vd, quote) {
    const ratio = vd.latestRatio || 1;
    const lines = [];
    if (vd.accumulation) lines.push(`🟢 <strong>Accumulation Signal:</strong> High volume (${ratio}x avg) with price increase suggests institutions are buying.`);
    if (vd.distribution) lines.push(`🔴 <strong>Distribution Signal:</strong> High volume with price decline suggests smart money selling into retail demand.`);
    if (ratio > 2) lines.push(`🔥 <strong>Volume Anomaly:</strong> Volume is ${ratio}x above average — possible block deal or institutional entry.`);
    if ((vd.spikes || 0) >= 3) lines.push(`⚡ <strong>Repeated Spikes:</strong> ${vd.spikes} volume spikes in 20 days indicate sustained institutional interest.`);
    if (lines.length === 0) lines.push(`⚪ <strong>No unusual activity detected.</strong> Volume is within normal range. Watch for breakouts with volume confirmation.`);
    return lines.map(l => `<div style="margin-bottom:8px;font-size:0.85rem;line-height:1.5">${l}</div>`).join('');
  }

  function generateVolumeProfile(historical) {
    if (!historical || historical.length < 5) return '<div class="empty-state"><div class="es-icon">📊</div><div class="es-title">No data</div></div>';
    const recent = historical.slice(-10);
    const maxVol = Math.max(...recent.map(d => d.volume));
    return recent.map(d => `
      <div class="vp-row">
        <div class="vp-label">${d.date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}</div>
        <div class="vp-bar-wrap">
          <div class="vp-bar" style="width:${(d.volume/maxVol*100).toFixed(1)}%;background:${d.close > (historical[historical.indexOf(d)-1]?.close||d.close) ? 'var(--green)' : 'var(--red)'}"></div>
        </div>
        <div class="vp-val">${fmtVol(d.volume)}</div>
      </div>
    `).reverse().join('');
  }

  // ── Radar Tab (Overview)
  function renderOverview(result) {
    const { scores, tradeSetup, quote, fund } = result;
    const { composite } = scores;
    const fillClass = Analysis.scoreFillClass(composite.total);
    const badgeClass = Analysis.scoreBadgeClass(composite.ratingClass);

    document.getElementById('tab-overview').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start;flex-wrap:wrap">
        <div>
          <div class="section-title" style="margin-bottom:12px">📡 Score Radar</div>
          <div class="chart-wrap radar-wrap">
            <canvas id="chart-radar" width="300" height="300"></canvas>
          </div>
        </div>
        <div>
          <div class="section-title" style="margin-bottom:12px">🏆 Composite Score</div>
          <div style="text-align:center;padding:20px">
            <div style="font-size:4rem;font-weight:900;font-family:'JetBrains Mono',monospace;color:${Analysis.scoreColor(composite.total,100)}">${composite.total}</div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:16px">out of 100</div>
            <div class="rating-badge ${badgeClass}" style="font-size:0.9rem;padding:8px 20px;display:inline-block">${composite.emoji} ${composite.rating}</div>
            <div class="score-bar" style="margin-top:20px">
              <div class="score-fill ${fillClass}" style="width:${composite.total}%"></div>
            </div>
          </div>

          <div class="section-title" style="margin:20px 0 12px">📊 Category Scores</div>
          <div class="score-breakdown">
            <div class="sbd-row">
              <div class="sbd-label">📈 Fundamentals</div>
              <div class="sbd-bar-wrap"><div class="sbd-bar" style="width:${(scores.fundamental.score/25)*100}%;background:#10b981"></div></div>
              <div class="sbd-score" style="color:${Analysis.scoreColor(scores.fundamental.score,25)}">${scores.fundamental.score}</div>
              <div class="sbd-max">/25</div>
            </div>
            <div class="sbd-row">
              <div class="sbd-label">📊 Technical Setup</div>
              <div class="sbd-bar-wrap"><div class="sbd-bar" style="width:${(scores.technicalSetup.score/25)*100}%;background:#3b82f6"></div></div>
              <div class="sbd-score" style="color:${Analysis.scoreColor(scores.technicalSetup.score,25)}">${scores.technicalSetup.score}</div>
              <div class="sbd-max">/25</div>
            </div>
            <div class="sbd-row">
              <div class="sbd-label">⚡ Momentum</div>
              <div class="sbd-bar-wrap"><div class="sbd-bar" style="width:${(scores.momentum.score/25)*100}%;background:#f59e0b"></div></div>
              <div class="sbd-score" style="color:${Analysis.scoreColor(scores.momentum.score,25)}">${scores.momentum.score}</div>
              <div class="sbd-max">/25</div>
            </div>
            <div class="sbd-row">
              <div class="sbd-label">🧠 Sentiment &amp; Flows</div>
              <div class="sbd-bar-wrap"><div class="sbd-bar" style="width:${(scores.sentimentFlow.score/25)*100}%;background:#8b5cf6"></div></div>
              <div class="sbd-score" style="color:${Analysis.scoreColor(scores.sentimentFlow.score,25)}">${scores.sentimentFlow.score}</div>
              <div class="sbd-max">/25</div>
            </div>
          </div>
        </div>
      </div>

      <div class="section-title" style="margin:24px 0 12px">🔍 25-Year Multi-Factor Checklist</div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px; margin-bottom:24px;">
        ${scores.checklist.map(item => `
          <div style="background:var(--bg-elevated); border:1px solid var(--border); border-left:4px solid ${item.passed ? 'var(--green)' : 'var(--red)'}; padding:12px; border-radius:var(--radius-sm); display:flex; flex-direction:column; gap:4px; text-align:left;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-weight:600; font-size:0.82rem; color:var(--text-primary)">${item.label}</span>
              <span style="font-size:0.8rem; font-weight:700; color:${item.passed ? 'var(--green)' : 'var(--red)'}">${item.passed ? '🟢 PASS' : '🔴 FAIL'}</span>
            </div>
            <div style="font-size:0.75rem; color:var(--text-secondary); line-height:1.4;">${item.desc}</div>
            <div style="font-size:0.72rem; color:var(--text-muted); border-top:1px solid rgba(255,255,255,0.05); padding-top:4px; margin-top:4px;">
              <strong>Metric:</strong> ${item.value} (${item.score}/${item.max} pts)
            </div>
          </div>
        `).join('')}
      </div>

      <div class="section-title" style="margin:24px 0 12px">💡 AI Recommendation</div>
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-md);padding:20px;line-height:1.8;font-size:0.88rem">
        ${result.geminiCommentary ? `
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;color:var(--text-accent);font-weight:600;">
            <span>🧠</span> Gemini AI Swing Analysis
            <span class="rating-badge badge-buy" style="font-size:0.65rem;padding:2px 6px">Free Live</span>
          </div>
          <div style="color:var(--text-secondary);line-height:1.6">${result.geminiCommentary}</div>
        ` : `
          ${generateRecommendationText(result)}
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);font-size:0.75rem;color:var(--text-muted);display:flex;align-items:center;gap:6px">
            <span>⚙️</span> <span>Tip: Paste your free Gemini API Key under <strong>AI Settings</strong> in the top header for customized swing analysis!</span>
          </div>
        `}
      </div>

      <div class="section-title" style="margin:20px 0 12px">⚠️ Disclaimer</div>
      <div class="disclaimer">
        ⚠️ &nbsp; This analysis is algorithmic and for educational purposes only. Not financial advice. Always do your own research before investing.
      </div>
    `;
    setTimeout(() => Charts.renderRadarChart('chart-radar', scores), 50);
  }

  function generateRecommendationText(result) {
    const { symbol, name, scores, tradeSetup, quote } = result;
    const { composite, fundamental, technicalSetup, momentum, sentimentFlow } = scores;
    const sym = symbol.replace('.NS','').replace('.BO','');

    let text = `<strong style="color:var(--text-accent)">📊 Analysis for ${sym} (${name}):</strong><br><br>`;
    text += `Based on our multi-factor scoring model, <strong>${sym}</strong> received a composite score of <strong style="color:${Analysis.scoreColor(composite.total,100)}">${composite.total}/100</strong>, placing it in the <strong>${composite.emoji} ${composite.rating}</strong> category.<br><br>`;

    if (fundamental.score >= 18) text += `      ✅ <strong>Fundamentally Strong:</strong> The stock shows excellent financials with a high fundamental score of ${fundamental.score}/25. Revenue and earnings growth are supporting the bull case.<br>`;
    else if (fundamental.score >= 12) text += `      🟡 <strong>Decent Fundamentals:</strong> Fundamental score of ${fundamental.score}/25 is average. Watch for upcoming quarterly results.<br>`;
    else text += `      🔴 <strong>Weak Fundamentals:</strong> Fundamental score of ${fundamental.score}/25 raises concerns. Exercise caution.<br>`;

    const techInds = technicalSetup.indicators;
    const momInds = momentum.indicators;
    if (momInds.macdCrossover) text += `      🔥 <strong>MACD Crossover:</strong> Fresh bullish MACD crossover detected — a strong technical entry signal for swing trades.<br>`;
    if (momInds.rsi < 35) text += `      ⚡ <strong>Oversold RSI (${momInds.rsi.toFixed(1)}):</strong> RSI in oversold zone — potential bounce play. Look for confirmation candle.<br>`;
    else if (momInds.rsi > 65) text += `      ⚠️ <strong>RSI Elevated (${momInds.rsi.toFixed(1)}):</strong> RSI approaching overbought. Better to wait for a pullback before entering.<br>`;
    if (techInds.trend === 'uptrend') text += `      📈 <strong>Uptrend Intact:</strong> Price is above SMA20 & SMA50. Trend alignment is bullish — dips are buying opportunities.<br>`;
    if (sentimentFlow.score >= 18) text += `      🏦 <strong>Institutional &amp; Flows:</strong> High institutional holding or accumulation volume suggests strong smart money backing.<br>`;

    text += `<br><strong style="color:var(--text-accent)">🎯 Swing Trade Setup:</strong><br>`;
    text += `• Entry: <strong>₹${quote.price.toFixed(2)}</strong> (current market price)<br>`;
    text += `• Stop Loss: <strong style="color:var(--red)">₹${tradeSetup.stopLoss}</strong><br>`;
    text += `• Target 1: <strong style="color:#22c55e">₹${tradeSetup.target1}</strong> | Target 2: <strong style="color:var(--green)">₹${tradeSetup.target2}</strong> | Target 3: <strong style="color:var(--cyan)">₹${tradeSetup.target3}</strong><br>`;
    text += `• Risk/Reward Ratio: <strong style="color:${tradeSetup.riskReward >= 2 ? 'var(--green)' : 'var(--yellow)'}">${tradeSetup.riskReward}:1</strong><br>`;

    return text;
  }

  // Helper to render markdown-like formatting in chat bubbles
  function formatChatMessage(text) {
    if (!text) return '';
    // Bold: **text** -> <strong>text</strong>
    let html = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Italic: *text* -> <em>text</em>
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Bullet points: * item or - item -> <li>item</li> wrapped in <ul>
    const lines = html.split('\n');
    let inList = false;
    let listHtml = '';
    
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (line.startsWith('* ') || line.startsWith('- ')) {
        if (!inList) {
          listHtml += '<ul style="margin:4px 0 8px 16px; padding:0; list-style-type:disc;">';
          inList = true;
        }
        listHtml += `<li style="margin-bottom:4px;">${line.substring(2)}</li>`;
      } else {
        if (inList) {
          listHtml += '</ul>';
          inList = false;
        }
        if (line) {
          listHtml += `<div>${line}</div>`;
        } else {
          listHtml += '<div style="height:6px;"></div>';
        }
      }
    }
    if (inList) {
      listHtml += '</ul>';
    }
    return listHtml;
  }

  function renderInvyMessage(sender, text) {
    const chatMessages = document.getElementById('invy-chat-messages');
    if (!chatMessages) return;
    
    const messageEl = document.createElement('div');
    messageEl.className = `invy-message ${sender === 'user' ? 'user' : 'assistant'}`;
    
    const senderName = sender === 'user' ? 'You' : 'Invy AI';
    const formattedText = formatChatMessage(text);
    
    messageEl.innerHTML = `
      <div class="msg-sender">${senderName}</div>
      <div class="msg-text">${formattedText}</div>
    `;
    
    chatMessages.appendChild(messageEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ── Score breakdown renderer
  function renderScoreBreakdown(checklist) {
    if (!checklist || !checklist.length) return '<div style="color:var(--text-muted);font-size:0.8rem">No checklist data available</div>';
    return `
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${checklist.map(b => `
          <div style="background:var(--bg-elevated); border:1px solid var(--border); border-left:4px solid ${b.passed ? 'var(--green)' : 'var(--red)'}; padding:10px 12px; border-radius:var(--radius-sm); display:flex; justify-content:space-between; align-items:center;">
            <div style="display:flex; flex-direction:column; gap:2px; text-align:left;">
              <div style="font-weight:600; font-size:0.82rem; color:var(--text-primary); display:flex; align-items:center; gap:6px;">
                <span>${b.passed ? '🟢' : '🔴'}</span>
                <span>${b.label}</span>
              </div>
              <div style="font-size:0.75rem; color:var(--text-secondary);">${b.desc}</div>
            </div>
            <div style="text-align:right; min-width:100px;">
              <div style="font-size:0.8rem; font-weight:700; color:var(--text-primary)">${b.score}/${b.max} pts</div>
              <div style="font-size:0.7rem; color:var(--text-muted);">${b.value}</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // ── Render Interactive Live Chart
  function renderLiveChart(result) {
    const tvSymbol = getTradingViewSymbol(result.symbol);
    const container = document.getElementById('tab-live-chart');
    if (!container) return;

    container.innerHTML = `
      <div class="live-chart-container" style="display:flex; flex-direction:column; gap:16px; animation: fadeIn 0.3s ease-out;">
        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-elevated); border:1px solid var(--border); padding:12px 18px; border-radius:var(--radius-md);">
          <div>
            <span style="font-size:0.75rem; color:var(--text-accent); text-transform:uppercase; font-weight:600; letter-spacing:0.05em;">Interactive Terminal</span>
            <h3 style="margin:4px 0 0 0; font-size:1.25rem; font-weight:700; color:var(--text-primary); display:flex; align-items:center; gap:8px;">
              <span>📈</span> ${result.name} (${result.symbol.replace('.NS','').replace('.BO','')})
            </h3>
          </div>
          <div style="text-align:right;">
            <div style="font-size:1.15rem; font-weight:700; color:${result.quote.changePct >= 0 ? 'var(--green)' : 'var(--red)'}">
              ₹${fmt(result.quote.price, 2)}
            </div>
            <div style="font-size:0.75rem; font-weight:600;" class="${colorClass(result.quote.changePct)}">
              ${fmtPct(result.quote.changePct)} (${result.quote.change >= 0 ? '+' : ''}${fmt(result.quote.change, 2)})
            </div>
          </div>
        </div>

        <div class="chart-widget-wrap" style="height:550px; border-radius:var(--radius-md); overflow:hidden; border:1px solid var(--border); background:var(--bg-card); position:relative;">
          <div id="tradingview_widget_main" style="width:100%; height:100%;"></div>
        </div>

        <div style="background:var(--bg-elevated); border:1px solid var(--border); padding:12px 16px; border-radius:var(--radius-md); font-size:0.75rem; color:var(--text-secondary); display:flex; align-items:center; gap:8px; line-height:1.5;">
          <span style="font-size:1.1rem;">💡</span>
          <div>
            <strong>Interactive Mode Enabled:</strong> Use the search bar inside the chart header (top-left) to manual switch tickers, draw trend lines, load indicators (like RSI or Bollinger Bands), or toggle periods (hourly, daily, weekly).
          </div>
        </div>
      </div>
    `;

    setTimeout(() => {
      if (tvSymbol && typeof TradingView !== 'undefined') {
        new TradingView.widget({
          width: "100%",
          height: "100%",
          symbol: tvSymbol,
          interval: "D",
          timezone: tvSymbol.startsWith('NSE:') || tvSymbol.startsWith('BSE:') ? "Asia/Kolkata" : "America/New_York",
          theme: "dark",
          style: "1",
          locale: "en",
          toolbar_bg: "#0d1220",
          enable_publishing: false,
          hide_side_toolbar: false,
          allow_symbol_change: true,
          container_id: "tradingview_widget_main",
          studies: [
            "MASimple@tv-basicstudies",
            "RSI@tv-basicstudies"
          ]
        });
      } else {
        const widgetContainer = document.getElementById('tradingview_widget_main');
        if (widgetContainer) {
          widgetContainer.innerHTML = `
            <div style="padding: 48px; text-align: center; color: var(--text-muted); display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:12px;">
              <span style="font-size:2rem;">🌐</span>
              <div>TradingView script failed to load or is offline. Please check your internet connection.</div>
            </div>`;
        }
      }
    }, 50);
  }

  // ── Search results
  function renderSearchResults(results) {
    const el = document.getElementById('search-dropdown');
    if (!el) return;
    if (!results.length) { el.classList.remove('show'); return; }
    el.innerHTML = results.map(r => `
      <div class="search-result-item" onclick="App.addStock('${r.symbol}','${r.name}','${r.sector}')">
        <div class="sri-symbol">${r.symbol.replace('.NS','').replace('.BO','')}</div>
        <div class="sri-name">${r.name}</div>
        <div class="sri-sector">${r.sector}</div>
      </div>
    `).join('');
    el.classList.add('show');
  }

  // ── Loading state for detail panel
  function setDetailLoading(loading) {
    const spinner = document.getElementById('detail-loading');
    if (spinner) spinner.style.display = loading ? 'flex' : 'none';
  }

  return {
    toast, renderMarketTickers, renderFearGreed, renderSectorHeatmap,
    renderWatchlistItem, renderRecCard, renderDetailHeader,
    renderFundamentals, renderTechnicals, renderSentiment,
    renderInstitutional, renderOverview, renderSearchResults, renderInvyMessage,
    renderLiveChart, setDetailLoading, fmt, fmtCr, fmtVol, fmtPct, colorClass,
  };
})();

window.UI = UI;
