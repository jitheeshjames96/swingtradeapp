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
    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    if (mode === 'US') {
      const mil = val / 1e6;
      if (mil >= 1e3) return '$' + (mil / 1e3).toFixed(2) + 'B';
      return '$' + mil.toFixed(0) + 'M';
    } else {
      const cr = val / 1e7;
      if (cr >= 1e5) return '₹' + (cr / 1e5).toFixed(2) + 'L Cr';
      if (cr >= 1e3) return '₹' + (cr / 1e3).toFixed(2) + 'K Cr';
      return '₹' + cr.toFixed(0) + ' Cr';
    }
  }
  function fmtVol(val) {
    if (!val) return 'N/A';
    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    if (mode === 'US') {
      if (val >= 1e9) return (val / 1e9).toFixed(2) + ' B';
      if (val >= 1e6) return (val / 1e6).toFixed(2) + ' M';
      return val.toLocaleString('en-US');
    } else {
      if (val >= 1e7) return (val / 1e7).toFixed(2) + ' Cr';
      if (val >= 1e5) return (val / 1e5).toFixed(2) + ' L';
      return val.toLocaleString('en-IN');
    }
  }
  function fmtPct(val) {
    if (val === null || val === undefined) return 'N/A';
    const sign = val >= 0 ? '+' : '';
    return sign + parseFloat(val).toFixed(2) + '%';
  }
  function colorClass(val) { return val >= 0 ? 'pos' : 'neg'; }
  function formatNewsDate(unixTime, fallbackText) {
    if (!unixTime) return fallbackText || 'Recent';
    const pubDate = new Date(unixTime * 1000);
    const now = new Date();
    const diffMs = now - pubDate;
    const diffMins = Math.floor(diffMs / (60 * 1000));
    const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
    
    if (diffMins < 0) {
      return 'Just now';
    }
    if (diffMins < 60) {
      return `${diffMins}m ago`;
    }
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    
    const day = pubDate.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[pubDate.getMonth()];
    const year = pubDate.getFullYear();
    return `${day} ${month} ${year}`;
  }
  function getFinancialYear(period) {
    if (!period) return 'N/A';
    if (period.includes('-')) {
      const parts = period.split('-');
      if (parts.length >= 2) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10);
        if (!isNaN(year) && !isNaN(month)) {
          const fy = month >= 4 ? year + 1 : year;
          return `FY${fy - 2000}`;
        }
      }
    }
    const match = period.match(/FY(\d{2,4})/i);
    if (match) {
      const fyNum = parseInt(match[1], 10);
      if (fyNum > 100) {
        return `FY${fyNum - 2000}`;
      }
      return `FY${fyNum}`;
    }
    return 'N/A';
  }

  // ── Market ticker strip
  function renderMarketTickers(indices) {
    const wrap = document.getElementById('market-tickers');
    if (!wrap) return;
    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    const fmtLoc = mode === 'US' ? 'en-US' : 'en-IN';
    wrap.innerHTML = indices.map(idx => `
      <div class="market-ticker">
        <div class="mt-name">${idx.name}</div>
        <div class="mt-value ${colorClass(idx.change)}">${idx.price ? idx.price.toLocaleString(fmtLoc, { maximumFractionDigits: 0 }) : '—'}</div>
        <div class="mt-change ${colorClass(idx.change)}">${fmtPct(idx.change)}</div>
      </div>
    `).join('');
  }

  // ── Market indices sidebar panel
  function renderMarketIndicesPanel(indices) {
    const listEl = document.getElementById('sidebar-indices-list');
    if (!listEl) return;
    if (!indices || indices.length === 0) {
      listEl.innerHTML = '<div style="font-size:0.75rem;color:var(--text-muted);text-align:center;padding:10px;">No index data</div>';
      return;
    }
    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    const fmtLoc = mode === 'US' ? 'en-US' : 'en-IN';
    
    listEl.innerHTML = indices.map(idx => {
      const priceStr = idx.price ? idx.price.toLocaleString(fmtLoc, { maximumFractionDigits: 0 }) : '—';
      const changeVal = idx.change || 0;
      const changeStr = fmtPct(changeVal);
      const rawChangeStr = idx.rawChange !== undefined ? ((idx.rawChange >= 0 ? '+' : '') + idx.rawChange.toLocaleString(fmtLoc, { maximumFractionDigits: 0 })) : '';
      const changeClass = changeVal > 0 ? 'positive' : (changeVal < 0 ? 'negative' : 'neutral');
      return `
        <div class="sidebar-index-card">
          <div class="sidebar-index-info">
            <span class="sidebar-index-name">${idx.name}</span>
            <span class="sidebar-index-symbol">${idx.symbol}</span>
          </div>
          <div class="sidebar-index-vals">
            <span class="sidebar-index-price">${priceStr}</span>
            <span class="sidebar-index-change ${changeClass}">${changeStr} ${rawChangeStr ? `(${rawChangeStr})` : ''}</span>
          </div>
        </div>
      `;
    }).join('');
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
  function renderSectorHeatmap(sectors, resultsMap) {
    const grid = document.getElementById('sector-grid');
    if (!grid) return;

    function getEtfSectorName(stockSector) {
      const s = (stockSector || '').toLowerCase();
      if (s === 'it' || s.includes('tech') || s.includes('semiconductor') || s.includes('social') || s.includes('streaming') || s.includes('e-commerce') || s.includes('consumer tech')) {
        return 'Technology';
      }
      if (s.includes('bank') || s.includes('nbfc') || s.includes('financial') || s.includes('insurance')) {
        return 'Financials';
      }
      if (s.includes('pharma') || s.includes('health') || s.includes('hospital')) {
        return 'Healthcare';
      }
      if (s.includes('renewable') || s.includes('wind') || s.includes('solar') || s.includes('green') || s.includes('clean')) {
        return 'Renewables';
      }
      if (s.includes('energy')) {
        return 'Energy';
      }
      if (s.includes('telecom') || s.includes('telco') || s.includes('telecommunications')) {
        return 'Telecom';
      }
      if (s.includes('auto') || s.includes('engineer') || s.includes('conglomerate') || s.includes('industrial') || s.includes('aerospace') || s.includes('defense') || s.includes('defence') || s.includes('electronics') || s.includes('infrastructure')) {
        return 'Industrials';
      }
      if (s.includes('fmcg') || s.includes('consumer') || s.includes('retail')) {
        return 'Consumer';
      }
      if (s.includes('metal') || s.includes('cement') || s.includes('material')) {
        return 'Materials';
      }
      if (s.includes('utility') || s.includes('utilities')) {
        return 'Utilities';
      }
      if (s.includes('real estate')) {
        return 'Real Estate';
      }
      return '';
    }

    grid.innerHTML = sectors.map(s => {
      const cls = s.change > 0.5 ? 'bullish' : s.change < -0.5 ? 'bearish' : 'neutral';
      const changeColor = s.change >= 0 ? 'var(--green)' : 'var(--red)';

      let gainersHtml = `<span style="color:var(--text-muted); font-size:0.65rem">—</span>`;
      let losersHtml = `<span style="color:var(--text-muted); font-size:0.65rem">—</span>`;

      if (s.gainers && s.losers) {
        if (s.gainers.length > 0) {
          gainersHtml = s.gainers.map(q => {
            const cleanSym = q.symbol.replace('.NS', '').replace('.BO', '');
            const color = (q.quote?.changePct || 0) >= 0 ? 'var(--green)' : 'var(--red)';
            const val = q.quote?.changePct || 0;
            return `
              <div class="sector-stock-badge" data-symbol="${q.symbol}" title="${q.name}" style="cursor:pointer; display:flex; justify-content:space-between; font-size:0.68rem; padding:2px 4px; border-radius:3px; background:rgba(255,255,255,0.04); margin-bottom:2px; transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='rgba(255,255,255,0.04)'">
                <span style="font-weight:700; text-decoration:underline;">${cleanSym}</span>
                <span style="color:${color}; font-weight:600;">${val >= 0 ? '+' : ''}${val.toFixed(1)}%</span>
              </div>
            `;
          }).join('');
        }
        if (s.losers.length > 0) {
          losersHtml = s.losers.map(q => {
            const cleanSym = q.symbol.replace('.NS', '').replace('.BO', '');
            const color = (q.quote?.changePct || 0) >= 0 ? 'var(--green)' : 'var(--red)';
            const val = q.quote?.changePct || 0;
            return `
              <div class="sector-stock-badge" data-symbol="${q.symbol}" title="${q.name}" style="cursor:pointer; display:flex; justify-content:space-between; font-size:0.68rem; padding:2px 4px; border-radius:3px; background:rgba(255,255,255,0.04); margin-bottom:2px; transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='rgba(255,255,255,0.04)'">
                <span style="font-weight:700; text-decoration:underline;">${cleanSym}</span>
                <span style="color:${color}; font-weight:600;">${val >= 0 ? '+' : ''}${val.toFixed(1)}%</span>
              </div>
            `;
          }).join('');
        }
      } else if (resultsMap) {
        const sectorStocks = Array.from(resultsMap.values()).filter(r => {
          if (r.error || !r.quote || !r.sector) return false;
          return getEtfSectorName(r.sector) === s.name;
        });

        if (sectorStocks.length > 0) {
          const sortedDesc = [...sectorStocks].filter(q => (q.quote?.changePct || 0) > 0).sort((a, b) => b.quote.changePct - a.quote.changePct);
          const sortedAsc = [...sectorStocks].filter(q => (q.quote?.changePct || 0) < 0).sort((a, b) => a.quote.changePct - b.quote.changePct);

          gainersHtml = sortedDesc.slice(0, 5).map(q => {
            const cleanSym = q.symbol.replace('.NS', '').replace('.BO', '');
            const color = q.quote.changePct >= 0 ? 'var(--green)' : 'var(--red)';
            const val = q.quote.changePct || 0;
            return `
              <div class="sector-stock-badge" data-symbol="${q.symbol}" title="${q.name}" style="cursor:pointer; display:flex; justify-content:space-between; font-size:0.68rem; padding:2px 4px; border-radius:3px; background:rgba(255,255,255,0.04); margin-bottom:2px; transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='rgba(255,255,255,0.04)'">
                <span style="font-weight:700; text-decoration:underline;">${cleanSym}</span>
                <span style="color:${color}; font-weight:600;">${val >= 0 ? '+' : ''}${val.toFixed(1)}%</span>
              </div>
            `;
          }).join('');

          losersHtml = sortedAsc.slice(0, 5).map(q => {
            const cleanSym = q.symbol.replace('.NS', '').replace('.BO', '');
            const color = q.quote.changePct >= 0 ? 'var(--green)' : 'var(--red)';
            const val = q.quote.changePct || 0;
            return `
              <div class="sector-stock-badge" data-symbol="${q.symbol}" title="${q.name}" style="cursor:pointer; display:flex; justify-content:space-between; font-size:0.68rem; padding:2px 4px; border-radius:3px; background:rgba(255,255,255,0.04); margin-bottom:2px; transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='rgba(255,255,255,0.04)'">
                <span style="font-weight:700; text-decoration:underline;">${cleanSym}</span>
                <span style="color:${color}; font-weight:600;">${val >= 0 ? '+' : ''}${val.toFixed(1)}%</span>
              </div>
            `;
          }).join('');
        }
      }

      let stocksListHtml = '';
      if (window.API && window.API.STOCK_CATALOG) {
        const allSectorStocks = window.API.STOCK_CATALOG.filter(item => getEtfSectorName(item.sector) === s.name);
        if (allSectorStocks.length > 0) {
          stocksListHtml = `
            <div style="border-top:1px solid rgba(255,255,255,0.06); margin-top:8px; padding-top:6px;">
              <div style="font-size:0.58rem; color:var(--text-muted); font-weight:700; margin-bottom:4px; text-transform:uppercase; letter-spacing:0.03em;">Sector Stocks:</div>
              <div style="display:flex; flex-wrap:wrap; gap:4px;">
                ${allSectorStocks.map(item => {
                  const cleanSym = item.symbol.replace('.NS', '').replace('.BO', '');
                  return `<span class="sector-stock-tag" data-symbol="${item.symbol}" title="${item.name}" style="cursor:pointer; font-size:0.62rem; font-weight:700; color:var(--text-muted); background:rgba(255,255,255,0.04); padding:2px 5px; border-radius:3px; border:1px solid rgba(255,255,255,0.04); transition:all 0.15s ease;" onmouseover="this.style.color='var(--text-accent, #6366f1)'; this.style.background='rgba(99,102,241,0.08)'; this.style.borderColor='rgba(99,102,241,0.2)';" onmouseout="this.style.color='var(--text-muted)'; this.style.background='rgba(255,255,255,0.04)'; this.style.borderColor='rgba(255,255,255,0.04)';">${cleanSym}</span>`;
                }).join('')}
              </div>
            </div>
          `;
        }
      }

      return `
        <div class="sector-tile ${cls}" title="${s.name} Sector Heatmap" style="margin-bottom:8px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <div class="st-name" style="font-weight:700; font-size:0.78rem">${s.icon} ${s.name}</div>
            <div class="st-change" style="color:${changeColor}; font-weight:700; font-size:0.78rem">${fmtPct(s.change)}</div>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; border-top:1px solid rgba(255,255,255,0.08); padding-top:8px;">
            <div>
              <span style="color:var(--green); font-size:0.6rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; display:block; margin-bottom:4px;">Gainers</span>
              <div style="display:flex; flex-direction:column; gap:2px;">${gainersHtml}</div>
            </div>
            <div>
              <span style="color:var(--red); font-size:0.6rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; display:block; margin-bottom:4px;">Losers</span>
              <div style="display:flex; flex-direction:column; gap:2px;">${losersHtml}</div>
            </div>
          </div>
          ${stocksListHtml}
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
    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    const cSym = mode === 'US' ? '$' : '₹';

    let nexusBadge = '';
    const prof = localStorage.getItem('nexus_profile');
    if (prof && !result.error && scores?.composite) {
      const riskTag = Analysis.getAssetRiskTag(result);
      nexusBadge = `<span class="nexus-badge" style="font-size:0.62rem; padding:1.5px 5px; border-radius:3px; font-weight:700; margin-left:6px; background:rgba(59,130,246,0.12); color:#60a5fa; border:1px solid rgba(59,130,246,0.2);">${riskTag}</span>`;
    }

    return `
      <div class="watchlist-item ${isActive ? 'active' : ''} fade-in" data-symbol="${symbol}" onclick="App.selectStock('${symbol}')">
        <div class="wi-avatar">${initials}</div>
        <div class="wi-info">
          <div class="wi-symbol">${symbol.replace('.NS','').replace('.BO','')}${nexusBadge}</div>
          <div class="wi-name">${name}</div>
          <div class="wi-score-bar">
            <div class="wi-score-fill" style="width:${score}%;background:${fillColor}"></div>
          </div>
        </div>
        <div class="wi-right">
          <div class="wi-price ${colorClass(quote.changePct)}">${cSym}${fmt(quote.price, 1)}</div>
          <div class="wi-change ${colorClass(quote.changePct)}">${fmtPct(quote.changePct)}</div>
        </div>
        <button class="wi-remove" onclick="event.stopPropagation();App.removeStock('${symbol}')" title="Remove">✕</button>
      </div>
    `;
  }

  // ── Recommendation Card
  function renderRecCard(result) {
    const { symbol, name, quote, scores } = result;
    const { composite, fundamental, technicalSetup, momentum, sentiment, institutional } = scores;
    const fillClass = Analysis.scoreFillClass(composite.total);
    const badgeClass = Analysis.scoreBadgeClass(composite.ratingClass);
    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    const cSym = mode === 'US' ? '$' : '₹';

    let nexusBadge = '';
    const prof = localStorage.getItem('nexus_profile');
    if (prof && !result.error && scores?.composite) {
      const riskTag = Analysis.getAssetRiskTag(result);
      nexusBadge = `<span style="font-size:0.65rem; padding:2px 6px; border-radius:4px; font-weight:700; background:rgba(59,130,246,0.15); color:#60a5fa; border:1px solid rgba(59,130,246,0.3); margin-top:4px; display:inline-block;">🔮 ${riskTag}</span>`;
    }

    return `
      <div class="rec-card ${composite.ratingClass} fade-in" onclick="App.selectStock('${symbol}')">
        <div class="rc-top">
          <div class="rc-symbol-wrap">
            <div class="rc-symbol">${symbol.replace('.NS','').replace('.BO','')}${nexusBadge ? ' ' + nexusBadge : ''}</div>
            <div class="rc-name">${name}</div>
          </div>
          <div class="rating-badge ${badgeClass}">${composite.emoji} ${composite.rating}</div>
        </div>
        <div class="rc-price-row">
          <div class="rc-price ${colorClass(quote.changePct)}">${cSym}${fmt(quote.price, 1)}</div>
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
        <div class="rc-mini-stats" style="grid-template-columns: repeat(5, 1fr);">
          <div class="rc-mini-stat">
            <div class="rcms-label">Fund</div>
            <div class="rcms-val" style="color:${Analysis.scoreColor(fundamental.score,25)}">${fundamental.score}/25</div>
          </div>
          <div class="rc-mini-stat">
            <div class="rcms-label">Setup</div>
            <div class="rcms-val" style="color:${Analysis.scoreColor(technicalSetup.score,20)}">${technicalSetup.score}/20</div>
          </div>
          <div class="rc-mini-stat">
            <div class="rcms-label">Mom</div>
            <div class="rcms-val" style="color:${Analysis.scoreColor(momentum.score,20)}">${momentum.score}/20</div>
          </div>
          <div class="rc-mini-stat">
            <div class="rcms-label">Sent</div>
            <div class="rcms-val" style="color:${Analysis.scoreColor(sentiment.score,15)}">${sentiment.score}/15</div>
          </div>
          <div class="rc-mini-stat">
            <div class="rcms-label">Flows</div>
            <div class="rcms-val" style="color:${Analysis.scoreColor(institutional.score,20)}">${institutional.score}/20</div>
          </div>
        </div>
      </div>
    `;
  }

  // ── Detail Header
  function renderDetailHeader(result) {
    const { symbol, name, sector, quote, scores, tradeSetup } = result;
    const { composite, fundamental, technicalSetup, momentum, sentiment, institutional } = scores;
    const badgeClass = Analysis.scoreBadgeClass(composite.ratingClass);
    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    const cSym = mode === 'US' ? '$' : '₹';

    let sectorText = sector;
    const prof = localStorage.getItem('nexus_profile');
    if (prof && !result.error && scores?.composite) {
      const riskTag = Analysis.getAssetRiskTag(result);
      sectorText += ` | 🔮 ${riskTag}`;
    }

    document.getElementById('dh-symbol').textContent = symbol.replace('.NS','').replace('.BO','');
    document.getElementById('dh-name').textContent = name;
    document.getElementById('dh-sector').textContent = sectorText;
    document.getElementById('dh-price').textContent = `${cSym}${fmt(quote.price, 2)}`;
    document.getElementById('dh-change').textContent = fmtPct(quote.changePct);
    document.getElementById('dh-change').className = `dh-change ${colorClass(quote.changePct)}`;
    document.getElementById('dh-change-abs').textContent = `(${fmtPct(quote.change)})`;

    // Score breakdown
    document.getElementById('dh-total-score').textContent = composite.total;
    document.getElementById('dh-total-score').style.color = Analysis.scoreColor(composite.total, 100);
    document.getElementById('dh-rating').textContent = `${composite.emoji} ${composite.rating}`;
    document.getElementById('dh-rating').className = `rating-badge ${badgeClass}`;
    document.getElementById('dh-fund-score').textContent = fundamental.score + '/25';
    document.getElementById('dh-tech-score').textContent = technicalSetup.score + '/20';
    document.getElementById('dh-mom-score').textContent = momentum.score + '/20';
    document.getElementById('dh-sent-score').textContent = sentiment.score + '/15';
    document.getElementById('dh-inst-score').textContent = institutional.score + '/20';
  }

  // ── Fundamental Tab
  function renderFundamentals(result) {
    const { fund, scores, quote } = result;
    const f = fund;
    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    const isUS = mode === 'US';
    const cSym = isUS ? '$' : '₹';
    const div = isUS ? 1e6 : 1e7;
    const unit = isUS ? 'M' : 'Cr';

    const uniqueFYs = Array.from(new Set(
      result.earnings.quarterly.map(q => getFinancialYear(q.period))
    )).filter(fy => fy !== 'N/A');

    document.getElementById('tab-fundamental').innerHTML = `
      <div class="fundamental-grid">
        ${fundCard('P/E Ratio', fmt(f.pe, 1), f.forwardPE ? `Fwd: ${fmt(f.forwardPE,1)}` : '', peColor(f.pe))}
        ${fundCard('Industry P/E', f.industryPe ? fmt(f.industryPe, 1) : 'N/A', 'Sector Average', '')}
        ${fundCard('EPS', f.eps ? cSym + fmt(f.eps, 2) : 'N/A', 'Trailing 12M', '')}
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
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px">
          <div class="section-title" style="margin-bottom:0">🗓 Quarterly Table</div>
          <div class="quarter-filter-wrap" style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 0.8rem; color: var(--text-muted);">Year:</span>
            <select id="quarter-filter-select" class="dropdown-filter" style="background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-color); padding: 4px 8px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; outline: none; transition: var(--transition);">
              <option value="ALL">All</option>
              ${uniqueFYs.map(fy => `<option value="${fy}">${fy}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="overflow-x:auto">
          <table class="data-table">
            <thead><tr>
              <th>Period</th><th>Revenue (${cSym} ${unit})</th><th>Net Income (${cSym} ${unit})</th><th>EPS</th><th>YoY Rev</th>
            </tr></thead>
            <tbody>
              ${result.earnings.quarterly.map((q, i, arr) => {
                const prev = arr[i + 4];
                const yoy = prev && prev.revenue ? ((q.revenue - prev.revenue) / prev.revenue * 100) : null;
                const fy = getFinancialYear(q.period);
                return `<tr class="quarter-row" data-fy="${fy}">
                  <td>${q.period}</td>
                  <td>${cSym}${(q.revenue/div).toFixed(0)}</td>
                  <td class="${q.netIncome >= 0 ? 'pos' : 'neg'}">${cSym}${(q.netIncome/div).toFixed(0)}</td>
                  <td>${q.eps !== null ? cSym + fmt(q.eps, 2) : 'N/A'}</td>
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
              <th>Year</th><th>Revenue (${cSym} ${unit})</th><th>Net Income (${cSym} ${unit})</th><th>EPS</th><th>Rev Growth</th>
            </tr></thead>
            <tbody>
              ${result.earnings.annual.slice(0, 5).map((a, i, arr) => {
                const prev = arr[i + 1];
                const yoy = prev && prev.revenue ? ((a.revenue - prev.revenue) / prev.revenue * 100) : null;
                return `<tr>
                  <td>${a.period}</td>
                  <td>${cSym}${(a.revenue/div).toFixed(0)}</td>
                  <td class="${a.netIncome >= 0 ? 'pos' : 'neg'}">${cSym}${(a.netIncome/div).toFixed(0)}</td>
                  <td>${a.eps !== null ? cSym + fmt(a.eps, 2) : 'N/A'}</td>
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

      const filterSelect = document.getElementById('quarter-filter-select');
      if (filterSelect) {
        filterSelect.addEventListener('change', (e) => {
          const selectedFy = e.target.value;
          const rows = document.querySelectorAll('.quarter-row');
          rows.forEach(row => {
            if (selectedFy === 'ALL' || row.dataset.fy === selectedFy) {
              row.style.display = '';
            } else {
              row.style.display = 'none';
            }
          });
        });
      }
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
    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    const cSym = mode === 'US' ? '$' : '₹';

    const trendColor = techInds.trend === 'uptrend' ? 'var(--green)' : techInds.trend === 'downtrend' ? 'var(--red)' : 'var(--yellow)';
    const trendEmoji = techInds.trend === 'uptrend' ? '📈' : techInds.trend === 'downtrend' ? '📉' : '➡️';

    const srDaily = sr.daily || { pivot: sr.pivot, r1: sr.r1, r2: sr.r2, s1: sr.s1, s2: sr.s2 };
    const srWeekly = sr.weekly || srDaily;
    const srFourHour = sr.fourHour || srDaily;

    const levelSubItem = (type, val, color) => {
      const displayVal = val ? cSym + parseFloat(val).toFixed(2) : '—';
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; background:rgba(255,255,255,0.03); padding:6px 10px; border-radius:4px; border:1px solid rgba(255,255,255,0.05)">
          <span style="font-weight:600; color:var(--text-secondary)">${type}</span>
          <span style="font-weight:700; color:${color}">${displayVal}</span>
        </div>
      `;
    };

    let hideTargets = false;
    const profStr = localStorage.getItem('nexus_profile');
    if (profStr) {
      try {
        const prof = JSON.parse(profStr);
        const riskTag = Analysis.getAssetRiskTag(result);
        if (prof.riskAppetite === 'Aggressive' && riskTag === 'Core Portfolio Anchor') {
          hideTargets = true;
        }
      } catch (e) {}
    }

    let tradeSetupHtml = '';
    if (result.scores.composite.total >= 65 && !hideTargets) {
      tradeSetupHtml = `
        <div class="section-title" style="margin-bottom:12px">💰 Trade Setup (ATR-Based)</div>
        <div class="levels-grid" style="margin-bottom:20px">
          ${levelItem('Entry', currentPrice, 'Current Price', 'var(--text-accent)')}
          ${levelItem('Stop Loss', result.tradeSetup.stopLoss, '1.5× ATR below', 'var(--red)')}
          ${levelItem('Target 1', result.tradeSetup.target1, '2× ATR (quick)', '#22c55e')}
          ${levelItem('Target 2', result.tradeSetup.target2, '4× ATR (swing)', 'var(--green)')}
          ${levelItem('Target 3', result.tradeSetup.target3, 'R2 / Extension', '#06b6d4')}
          ${levelItem('R/R Ratio', result.tradeSetup.riskReward + 'x', 'Risk:Reward', result.tradeSetup.riskReward >= 2 ? 'var(--green)' : 'var(--yellow)')}
        </div>
      `;
    } else {
      const reclaimVal = techInds.sma20 ? cSym + parseFloat(techInds.sma20).toFixed(2) : '20 SMA';
      const supportValStr = sr.s1 ? cSym + parseFloat(sr.s1).toFixed(2) : 'major support';
      
      const bullishTrigger = `Reclaim ${reclaimVal} on > 1.5x average volume or a decisive Daily close above the Pivot range.`;
      const bearishRisk = `Breaching ${supportValStr} risks structural failure and triggers systemic freefall down to S2 or SMA200.`;
      
      let catalyst = '';
      if (scores.fundamental.score < 15) {
        catalyst += 'requires fundamental turnaround, YoY earnings margin recovery, or sector tailwinds to lift valuation metrics. ';
      }
      if (scores.institutional.score < 10) {
        catalyst += 'requires institutional FII/DII block purchase inflows to rebuild volume support. ';
      }
      if (scores.momentum.score < 10) {
        catalyst += 'requires RSI bullish divergence or MACD crossover to confirm momentum shift. ';
      }
      if (!catalyst) {
        catalyst = 'awaits breakout confirmation with volume surge before allocation.';
      }
      
      const strategicView = `Asset is currently in a defensive/consolidation phase. Scaling in is architecturally unjustified until catalysts trigger: ${catalyst}`;
      
      tradeSetupHtml = `
        <div class="section-title" style="margin-bottom:12px">🧬 Conditional Scenario Matrix (Non-Execution Watch Profile)</div>
        <div style="display:flex; flex-direction:column; gap:12px; margin-bottom:20px; background:var(--bg-elevated); padding:16px; border-radius:var(--radius-md); border:1px solid var(--border);">
          <div style="border-left:4px solid var(--yellow); padding-left:12px;">
            <div style="font-weight:700; font-size:0.8rem; color:var(--yellow); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">🐂 Bullish Activation Trigger</div>
            <div style="font-size:0.82rem; color:var(--text-primary); line-height:1.4;">${bullishTrigger}</div>
          </div>
          <div style="border-left:4px solid var(--red); padding-left:12px;">
            <div style="font-weight:700; font-size:0.8rem; color:var(--red); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">🐻 Bearish Breakdown Risk</div>
            <div style="font-size:0.82rem; color:var(--text-primary); line-height:1.4;">${bearishRisk}</div>
          </div>
          <div style="border-left:4px solid var(--blue); padding-left:12px;">
            <div style="font-weight:700; font-size:0.8rem; color:var(--blue); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px;">🧠 Strategic Architect View</div>
            <div style="font-size:0.82rem; color:var(--text-secondary); line-height:1.5; font-style:italic;">${strategicView}</div>
          </div>
        </div>
      `;
    }

    document.getElementById('tab-technical').innerHTML = `
      <div class="technical-grid">
        ${techIndicator('RSI (14)', fmt(momInds.rsi, 1), momInds.rsiSignal, rsiSignalClass(momInds.rsi))}
        ${techIndicator('MACD', fmt(momInds.macd, 3), momInds.macdCrossover ? '🔥 Bullish Crossover!' : momInds.macdBullish ? 'Bullish' : 'Bearish', momInds.macdBullish ? 'signal-bullish' : 'signal-bearish')}
        ${techIndicator('SMA 20', techInds.sma20 ? cSym + fmt(techInds.sma20, 1) : 'N/A', currentPrice > (techInds.sma20||0) ? 'Price Above ↑' : 'Price Below ↓', currentPrice > (techInds.sma20||0) ? 'signal-bullish' : 'signal-bearish')}
        ${techIndicator('SMA 50', techInds.sma50 ? cSym + fmt(techInds.sma50, 1) : 'N/A', currentPrice > (techInds.sma50||0) ? 'Price Above ↑' : 'Price Below ↓', currentPrice > (techInds.sma50||0) ? 'signal-bullish' : 'signal-bearish')}
        ${techIndicator('SMA 200', techInds.sma200 ? cSym + fmt(techInds.sma200, 1) : 'N/A', currentPrice > (techInds.sma200||0) ? 'Golden Zone ☀️' : 'Below 200 SMA', currentPrice > (techInds.sma200||0) ? 'signal-bullish' : 'signal-bearish')}
        ${techIndicator('ATR (14)', momInds.atr ? cSym + fmt(momInds.atr, 2) : 'N/A', 'Avg True Range (volatility)', 'signal-neutral')}
        ${techIndicator('Trend', `${trendEmoji} ${techInds.trend.charAt(0).toUpperCase() + techInds.trend.slice(1)}`, 'SMA crossover analysis', techInds.trend === 'uptrend' ? 'signal-bullish' : techInds.trend === 'downtrend' ? 'signal-bearish' : 'signal-neutral')}
        ${techIndicator('Vol Ratio', `${vd.latestRatio || 1}x`, vd.accumulation ? '🏦 Accumulation Signal' : vd.distribution ? '🏦 Distribution Signal' : 'Normal Activity', vd.latestRatio > 1.5 ? 'signal-bullish' : 'signal-neutral')}
      </div>

      <div class="section-title" style="margin-bottom:12px">🎯 Key Price Levels (Multi-Timeframe)</div>
      <div class="multi-timeframe-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 20px;">
        
        <!-- Daily Column -->
        <div class="timeframe-column" style="background: var(--bg-card); border: 1px solid var(--border); padding: 14px; border-radius: var(--radius-md); backdrop-filter: blur(10px);">
          <div style="font-weight: 700; font-size: 0.88rem; margin-bottom: 12px; color: var(--text-accent); text-align: center; border-bottom: 1px solid var(--border); padding-bottom: 8px;">☀️ Daily Levels (Classic)</div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${levelSubItem('R2', srDaily.r2, 'var(--red)')}
            ${levelSubItem('R1', srDaily.r1, 'var(--orange)')}
            ${levelSubItem('Pivot', srDaily.pivot, 'var(--yellow)')}
            ${levelSubItem('S1', srDaily.s1, '#22c55e')}
            ${levelSubItem('S2', srDaily.s2, 'var(--green)')}
          </div>
        </div>

        <!-- Weekly Column -->
        <div class="timeframe-column" style="background: var(--bg-card); border: 1px solid var(--border); padding: 14px; border-radius: var(--radius-md); backdrop-filter: blur(10px);">
          <div style="font-weight: 700; font-size: 0.88rem; margin-bottom: 12px; color: var(--text-accent); text-align: center; border-bottom: 1px solid var(--border); padding-bottom: 8px;">📅 Weekly Levels (Aggregated)</div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${levelSubItem('R2', srWeekly.r2, 'var(--red)')}
            ${levelSubItem('R1', srWeekly.r1, 'var(--orange)')}
            ${levelSubItem('Pivot', srWeekly.pivot, 'var(--yellow)')}
            ${levelSubItem('S1', srWeekly.s1, '#22c55e')}
            ${levelSubItem('S2', srWeekly.s2, 'var(--green)')}
          </div>
        </div>

        <!-- 4-Hour Column -->
        <div class="timeframe-column" style="background: var(--bg-card); border: 1px solid var(--border); padding: 14px; border-radius: var(--radius-md); backdrop-filter: blur(10px);">
          <div style="font-weight: 700; font-size: 0.88rem; margin-bottom: 12px; color: var(--text-accent); text-align: center; border-bottom: 1px solid var(--border); padding-bottom: 8px;">⚡ 4-Hour Levels (Pivot Approx)</div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${levelSubItem('R2', srFourHour.r2, 'var(--red)')}
            ${levelSubItem('R1', srFourHour.r1, 'var(--orange)')}
            ${levelSubItem('Pivot', srFourHour.pivot, 'var(--yellow)')}
            ${levelSubItem('S1', srFourHour.s1, '#22c55e')}
            ${levelSubItem('S2', srFourHour.s2, 'var(--green)')}
          </div>
        </div>

      </div>

      ${tradeSetupHtml}

      <div class="section-title" style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
        <span>📈 TradingView Interactive Chart</span>
        <span style="font-size:0.75rem; color:var(--text-muted); font-weight:normal;">Candlestick Feed</span>
      </div>
      <div class="chart-wrap" style="height:500px; margin-bottom:20px; border-radius:var(--radius-md); overflow:hidden; border:1px solid var(--border)">
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
    const isUS = (localStorage.getItem('stid_market_mode') || 'IN') === 'US';
    const cSym = isUS ? '$' : '₹';
    const isRatio = type.toLowerCase().includes('ratio') || type.toLowerCase().includes('r/r');
    const displayVal = price ? (isRatio ? (typeof price === 'string' ? price : parseFloat(price).toFixed(1) + 'x') : cSym + parseFloat(price).toFixed(1)) : '—';
    return `
      <div class="level-item">
        <div class="li-type">${type}</div>
        <div class="li-price" style="color:${color}">${displayVal}</div>
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

    const hasNews = news && news.length > 0;
    const majorNewsHtml = hasNews ? (() => {
      const major = news[0];
      const dotColor = major.sentiment === 'positive' ? 'var(--green)' : major.sentiment === 'negative' ? 'var(--red)' : 'var(--yellow)';
      const bgGradient = major.sentiment === 'positive' 
        ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(16, 185, 129, 0.02) 100%)' 
        : major.sentiment === 'negative' 
          ? 'linear-gradient(135deg, rgba(239, 68, 68, 0.12) 0%, rgba(239, 68, 68, 0.02) 100%)' 
          : 'linear-gradient(135deg, rgba(245, 158, 11, 0.12) 0%, rgba(245, 158, 11, 0.02) 100%)';
      const borderStroke = major.sentiment === 'positive' ? 'rgba(16, 185, 129, 0.25)' : major.sentiment === 'negative' ? 'rgba(239, 68, 68, 0.25)' : 'rgba(245, 158, 11, 0.25)';
      return `
        <div class="section-title" style="margin-bottom:12px">🔥 Major News</div>
        <div class="major-news-banner" onclick="window.open('${major.url}','_blank')" style="background:${bgGradient}; border: 1px solid ${borderStroke}; border-radius: 12px; padding: 18px; margin-bottom: 20px; cursor: pointer; transition: all 0.25s ease-in-out; position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 8px;">
          <div style="position: absolute; top: 0; right: 0; background: ${dotColor}; color: #111827; font-size: 0.65rem; font-weight: 700; padding: 4px 10px; border-bottom-left-radius: 8px; text-transform: uppercase; letter-spacing: 0.5px;">
            ${major.sentiment}
          </div>
          <div style="font-size: 1.05rem; font-weight: 600; line-height: 1.45; color: var(--text-color); margin-top: 4px; padding-right: 70px;">
            ${major.headline}
          </div>
          <div style="display: flex; align-items: center; gap: 8px; font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">
            <span style="font-weight: 600; color: var(--text-color);">${major.source}</span>
            <span>•</span>
            <span>${formatNewsDate(major.date, major.time)}</span>
          </div>
        </div>
      `;
    })() : '';
 
    const recentNewsHtml = hasNews ? news.slice(1).map(n => {
      const dotColor = n.sentiment === 'positive' ? 'var(--green)' : n.sentiment === 'negative' ? 'var(--red)' : 'var(--yellow)';
      return `
        <div class="news-item" onclick="window.open('${n.url}','_blank')">
          <div class="news-sentiment-dot" style="background:${dotColor}"></div>
          <div class="news-content">
            <div class="news-headline">${n.headline}</div>
            <div class="news-meta">
              <span>${n.source}</span>
              <span>•</span>
              <span>${formatNewsDate(n.date, n.time)}</span>
              <span style="color:${dotColor};font-weight:600">${n.sentiment.toUpperCase()}</span>
            </div>
          </div>
        </div>
      `;
    }).join('') : '<div style="color:var(--text-muted);font-size:0.85rem;padding:12px;">No recent news found for this ticker.</div>';

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
          <div class="sc-title">News & Sentiment Score</div>
          <div class="sc-value" style="color:${Analysis.scoreColor(scores.sentiment.score, 15)}">${scores.sentiment.score} / 15</div>
          <div class="sc-desc">NLP-derived sentiment plus Fear & Greed indexing.</div>
        </div>
      </div>

      ${majorNewsHtml}

      <div class="section-title" style="margin-bottom:12px">📰 Recent News</div>
      <div class="news-feed">
        ${recentNewsHtml}
      </div>

      <div class="section-title" style="margin-top:20px; margin-bottom:12px">🎯 Score Breakdown — News & Sentiment</div>
      ${renderScoreBreakdown(scores.sentiment.checklist)}
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
    const { indicators } = scores.technicalSetup;
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

      <div class="section-title" style="margin-top:20px; margin-bottom:12px">🎯 Score Breakdown — Institutional Flows</div>
      ${renderScoreBreakdown(scores.institutional.checklist)}
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

    // Compute keyless WhatsApp share link
    const cleanSymForWa = result.symbol.replace('.NS', '').replace('.BO', '');
    const isUsForWa = (localStorage.getItem('stid_market_mode') || 'IN') === 'US';
    const currencySym = isUsForWa ? '$' : '₹';
    const compScoreVal = composite.total;
    const rsi = scores.momentum?.indicators?.rsi || 50;
    const trend = scores.technicalSetup?.indicators?.trend || 'Sideways';

    let action = 'WATCH/HOLD';
    if (compScoreVal >= 80) action = 'STRONG BUY';
    else if (compScoreVal >= 65) action = 'BUY';
    else if (compScoreVal < 50) action = 'AVOID/SELL';

    const entry = `${currencySym}${quote.price.toFixed(2)}`;
    const sl = tradeSetup.stopLoss ? `${currencySym}${tradeSetup.stopLoss}` : 'N/A';
    const target1 = tradeSetup.target1 ? `${currencySym}${tradeSetup.target1}` : 'N/A';
    const targets = target1;

    const reasoning = `Score: ${compScoreVal}/100 | RSI: ${rsi.toFixed(1)} (${trend})`;
    
    // Strict Format: [TICKER] | [ACTION] | [ENTRY/EXIT] | [STOP LOSS] | [REASONING]
    let waMessage = `[${cleanSymForWa}] | [${action}] | [Entry ${entry} / Target ${targets}] | [Stop Loss ${sl}] | [${reasoning}]`;

    if (result.geminiCommentary) {
      const cleanCommentary = result.geminiCommentary.replace(/<[^>]*>/g, '').substring(0, 300);
      waMessage += `\n*AI Commentary Snippet:*\n_${cleanCommentary}..._\n`;
    }

    waMessage += `\n_Sent from SwingTrader Intelligence Dashboard_`;
    const waShareUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(waMessage)}`;

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
              <div class="sbd-bar-wrap"><div class="sbd-bar" style="width:${(scores.technicalSetup.score/20)*100}%;background:#3b82f6"></div></div>
              <div class="sbd-score" style="color:${Analysis.scoreColor(scores.technicalSetup.score,20)}">${scores.technicalSetup.score}</div>
              <div class="sbd-max">/20</div>
            </div>
            <div class="sbd-row">
              <div class="sbd-label">⚡ Momentum</div>
              <div class="sbd-bar-wrap"><div class="sbd-bar" style="width:${(scores.momentum.score/20)*100}%;background:#f59e0b"></div></div>
              <div class="sbd-score" style="color:${Analysis.scoreColor(scores.momentum.score,20)}">${scores.momentum.score}</div>
              <div class="sbd-max">/20</div>
            </div>
            <div class="sbd-row">
              <div class="sbd-label">🧠 News &amp; Sentiment</div>
              <div class="sbd-bar-wrap"><div class="sbd-bar" style="width:${(scores.sentiment.score/15)*100}%;background:#ec4899"></div></div>
              <div class="sbd-score" style="color:${Analysis.scoreColor(scores.sentiment.score,15)}">${scores.sentiment.score}</div>
              <div class="sbd-max">/15</div>
            </div>
            <div class="sbd-row">
              <div class="sbd-label">🏢 Institutional Flows</div>
              <div class="sbd-bar-wrap"><div class="sbd-bar" style="width:${(scores.institutional.score/20)*100}%;background:#8b5cf6"></div></div>
              <div class="sbd-score" style="color:${Analysis.scoreColor(scores.institutional.score,20)}">${scores.institutional.score}</div>
              <div class="sbd-max">/20</div>
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
        <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border); display:flex; justify-content:flex-end;">
          <a href="${waShareUrl}" target="_blank" rel="noopener noreferrer" style="background:#25d366; color:#fff; border:none; padding:6px 12px; border-radius:6px; font-weight:700; font-size:0.75rem; text-decoration:none; display:inline-flex; align-items:center; gap:6px; transition:opacity 0.2s;" onmouseover="this.style.opacity=0.9" onmouseout="this.style.opacity=1">
            <svg style="width:14px; height:14px; fill:currentColor;" viewBox="0 0 24 24"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.514 2.266 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.502-5.724-1.455L0 24zm6.59-11.585c-.124-.207-.46-.331-.967-.584s-2.99-1.474-3.454-1.643c-.464-.17-.803-.255-1.142.254-.339.51-.1.171.1.254.2.083.568.203.8.318.232.116.331.066.43-.133.1-.2.43-1.705.529-1.904.1-.2.2-.413.066-.665-.133-.252-.43-1.606-.8-1.955-.36-.34-.73-.292-.967-.306-.21-.013-.453-.016-.696-.016-.243 0-.64.091-.974.453-.334.362-1.272 1.243-1.272 3.033s1.302 3.516 1.485 3.76c.182.243 2.562 3.912 6.208 5.485.867.374 1.545.597 2.072.764.87.276 1.663.237 2.29.144.7-.104 2.152-.88 2.455-1.73.303-.85.303-1.58.212-1.73-.09-.15-.33-.24-.813-.492z"/></svg>
            Share via WhatsApp
          </a>
        </div>
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
    const { composite, fundamental, technicalSetup, momentum, sentiment, institutional } = scores;
    const sym = symbol.replace('.NS','').replace('.BO','');

    let text = `<strong style="color:var(--text-accent)">📊 Analysis for ${sym} (${name}):</strong><br><br>`;
    text += `Based on our multi-factor scoring model, <strong>${sym}</strong> received a composite score of <strong style="color:${Analysis.scoreColor(composite.total,100)}">${composite.total}/100</strong>, placing it in the <strong>${composite.emoji} ${composite.rating}</strong> category.<br><br>`;

    if (fundamental.score >= 18) text += `      ✅ <strong>Fundamentally Strong:</strong> The stock shows excellent financials with a high fundamental score of ${fundamental.score}/25. Top-line/bottom-line growth support the thesis.<br>`;
    else if (fundamental.score >= 12) text += `      🟡 <strong>Decent Fundamentals:</strong> Fundamental score of ${fundamental.score}/25 is average. Watch for quarterly catalyst shifts.<br>`;
    else text += `      🔴 <strong>Weak Fundamentals:</strong> Fundamental score of ${fundamental.score}/25 raises concerns. Exercise caution.<br>`;

    const techInds = technicalSetup.indicators;
    const momInds = momentum.indicators;
    if (momInds.macdCrossover) text += `      🔥 <strong>MACD Crossover:</strong> Fresh bullish MACD crossover detected — momentum is accelerating.<br>`;
    if (momInds.rsi < 35) text += `      ⚡ <strong>Oversold RSI (${momInds.rsi.toFixed(1)}):</strong> RSI in oversold zone — potential mean-reversion bounce.<br>`;
    else if (momInds.rsi > 65) text += `      ⚠️ <strong>RSI Elevated (${momInds.rsi.toFixed(1)}):</strong> RSI approaching overbought territory.<br>`;
    if (techInds.trend === 'uptrend') text += `      📈 <strong>Uptrend Intact:</strong> Price is above SMA20 & SMA50. Primary trend is bullish.<br>`;
    if (institutional.score >= 15) text += `      🏦 <strong>Institutional Flows:</strong> Strong FII/DII positioning or volume accumulation patterns detected.<br>`;

    const isUS = (localStorage.getItem('stid_market_mode') || 'IN') === 'US';
    const cSym = isUS ? '$' : '₹';

    let hideTargets = false;
    const profStr = localStorage.getItem('nexus_profile');
    if (profStr) {
      try {
        const prof = JSON.parse(profStr);
        const riskTag = Analysis.getAssetRiskTag(result);
        if (prof.riskAppetite === 'Aggressive' && riskTag === 'Core Portfolio Anchor') {
          hideTargets = true;
        }
      } catch (e) {}
    }

    if (composite.total >= 65 && !hideTargets) {
      text += `<br><strong style="color:var(--text-accent)">🎯 Swing Trade Setup:</strong><br>`;
      text += `• Entry: <strong>${cSym}${quote.price.toFixed(2)}</strong><br>`;
      text += `• Stop Loss: <strong style="color:var(--red)">${cSym}${tradeSetup.stopLoss}</strong><br>`;
      text += `• Target 1: <strong style="color:#22c55e">${cSym}${tradeSetup.target1}</strong> | Target 2: <strong style="color:var(--green)">${cSym}${tradeSetup.target2}</strong> | Target 3: <strong style="color:var(--cyan)">${cSym}${tradeSetup.target3}</strong><br>`;
      text += `• Risk/Reward Ratio: <strong style="color:${tradeSetup.riskReward >= 2 ? 'var(--green)' : 'var(--yellow)'}">${tradeSetup.riskReward}:1</strong><br>`;
    } else {
      text += `<br><strong style="color:var(--text-accent)">🧬 Watch Status Matrix:</strong><br>`;
      text += `• Activation Trigger: Reclaim SMA20 on high volume.<br>`;
      text += `• Execution Guidance: Target panels are hidden to prevent trend-fighting or premature execution. Watch for structure consolidation.<br>`;
    }

    return text;
  }

  // Helper to render markdown-like formatting in chat bubbles
  function formatChatMessage(text) {
    if (!text) return '';

    // Convert tickers to clickable links first, so we don't mess with HTML attributes
    let textWithLinks = text;
    if (window.API && window.API.STOCK_CATALOG) {
      const symbols = [];
      window.API.STOCK_CATALOG.forEach(stock => {
        symbols.push(stock.symbol);
        const base = stock.symbol.replace('.NS', '').replace('.BO', '');
        if (base.length > 2) {
          symbols.push(base);
        }
      });
      symbols.sort((a, b) => b.length - a.length);
      const escapedSymbols = symbols.map(s => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));
      const regex = new RegExp(`\\b(${escapedSymbols.join('|')})\\b`, 'gi');

      textWithLinks = text.replace(regex, (match) => {
        const matchUpper = match.toUpperCase();
        const stock = window.API.STOCK_CATALOG.find(s => 
          s.symbol.toUpperCase() === matchUpper || 
          s.symbol.replace('.NS', '').replace('.BO', '').toUpperCase() === matchUpper
        );
        if (stock) {
          return `<span class="chat-ticker-link" onclick="event.preventDefault();event.stopPropagation();App.selectStock('${stock.symbol}')" style="cursor:pointer;text-decoration:underline;font-weight:700;color:var(--text-accent, #6366f1)" title="Click to view ${stock.name}">${match}</span>`;
        }
        return match;
      });
    }

    // Bold: **text** -> <strong>text</strong>
    let html = textWithLinks.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
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
    const container = document.getElementById('detail-live-chart-container');
    if (!container) return;

    const currentLoadedSymbol = container.getAttribute('data-loaded-symbol');
    if (currentLoadedSymbol === tvSymbol && typeof TradingView !== 'undefined') {
      return;
    }
    if (typeof TradingView !== 'undefined') {
      container.setAttribute('data-loaded-symbol', tvSymbol);
    } else {
      container.removeAttribute('data-loaded-symbol');
    }

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
              ${(localStorage.getItem('stid_market_mode') || 'IN') === 'US' ? '$' : '₹'}${fmt(result.quote.price, 2)}
            </div>
            <div style="font-size:0.75rem; font-weight:600;" class="${colorClass(result.quote.changePct)}">
              ${fmtPct(result.quote.changePct)} (${result.quote.change >= 0 ? '+' : ''}${fmt(result.quote.change, 2)})
            </div>
          </div>
        </div>

        <div class="chart-widget-wrap" style="height:480px; border-radius:var(--radius-md); overflow:hidden; border:1px solid var(--border); background:var(--bg-card); position:relative;">
          <div id="tradingview_widget_main" style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:#0d1220;">
            <div style="display:flex; flex-direction:column; align-items:center; gap:12px;">
              <div class="spinner"></div>
              <span style="font-size:0.75rem; color:var(--text-muted)">Loading interactive TradingView terminal...</span>
            </div>
          </div>
        </div>

        <!-- Koyfin Historical Score Chart -->
        <div class="score-timeline-wrap" style="height:220px; border-radius:var(--radius-md); border:1px solid var(--border); background:rgba(13, 18, 32, 0.5); padding:12px; position:relative; display:flex; flex-direction:column; gap:6px;">
          <div style="font-size:0.7rem; color:var(--text-secondary); font-weight:700; text-transform:uppercase; letter-spacing:0.05em; display:flex; justify-content:space-between; align-items:center;">
            <span>⏱️ HISTORICAL COMPOSITE SCORE (LOOKBACK TRAJECTORY)</span>
            <span id="score-regime-hint" style="font-size:0.65rem; color:var(--text-accent); font-weight:700;">Bull Regime Multipliers Active</span>
          </div>
          <div style="flex:1; position:relative; min-height: 160px;">
            <canvas id="chart-historical-score" style="width:100%; height:100%;"></canvas>
          </div>
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
            "MASimple@tv-basicstudies", // SMA
            "MAExp@tv-basicstudies",    // EMA
            "BB@tv-basicstudies",       // Bollinger Bands
            "RSI@tv-basicstudies",      // RSI
            "MACD@tv-basicstudies"      // MACD
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
    }, 150);
  }

  async function renderPerformanceDashboard() {
    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    const cSym = mode === 'US' ? '$' : '₹';
    const container = document.getElementById('performance-section-container');
    if (!container) return;

    // Show loading spinner
    container.innerHTML = `
      <div style="display:flex; justify-content:center; align-items:center; padding:48px;">
        <div class="spinner"></div>
      </div>
    `;

    try {
      // Fetch recommendations, settings, and performance statistics in parallel
      const [recs, settings, stats] = await Promise.all([
        API.fetchRecommendations(mode),
        API.fetchSettings(),
        API.fetchPerformanceStats()
      ]);

      const totalPicks = recs.length;
      const activePicks = recs.filter(r => r.status === 'ACTIVE').length;
      const winPicks = recs.filter(r => r.status === 'WIN').length;
      const lossPicks = recs.filter(r => r.status === 'LOSS').length;
      const completedPicks = totalPicks - activePicks;
      const winRate = completedPicks > 0 ? Math.round((winPicks / completedPicks) * 100) : 100;
      const simulatedROI = (winPicks * 10.5) - (lossPicks * 4.8);

      const roiClass = simulatedROI >= 0 ? 'text-green' : 'text-red';
      const roiSign = simulatedROI >= 0 ? '+' : '';

      container.innerHTML = `
        <div class="performance-dashboard-wrap" style="display:flex; flex-direction:column; gap:24px; color:var(--text-primary)">
          
          <!-- Immutable Signal Log Section -->
          <div style="background:var(--bg-card); border:1px solid var(--border); padding:20px; border-radius:var(--radius-md); display:flex; flex-direction:column; gap:16px;">
            <div style="font-weight:700; font-size:1rem; color:var(--text-accent); border-bottom:1px solid var(--border); padding-bottom:8px; display:flex; align-items:center; gap:8px;">
              <span>🛡️ Institutional Signal Log Statistics (Immutable Strong Buy Signals)</span>
            </div>
            
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:16px;">
              <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border); padding:16px; border-radius:var(--radius-md); text-align:center;">
                <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; margin-bottom:8px">📊 Active Signals</div>
                <div style="font-size:1.8rem; font-weight:800; color:var(--text-accent)">${stats.active_count}</div>
                <div style="font-size:0.7rem; color:var(--text-secondary); margin-top:4px">Monitoring targets/stops</div>
              </div>
              <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border); padding:16px; border-radius:var(--radius-md); text-align:center;">
                <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; margin-bottom:8px">📉 Settled Signals</div>
                <div style="font-size:1.8rem; font-weight:800; color:var(--text-accent)">${stats.settled_count}</div>
                <div style="font-size:0.7rem; color:var(--text-secondary); margin-top:4px">Resolved signal history</div>
              </div>
              <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border); padding:16px; border-radius:var(--radius-md); text-align:center;">
                <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; margin-bottom:8px">🎯 Signal Win Rate</div>
                <div style="font-size:1.8rem; font-weight:800; color:#10b981">${stats.win_rate}%</div>
                <div style="font-size:0.7rem; color:var(--text-secondary); margin-top:4px">${stats.target_hit_count} Targets | ${stats.stop_loss_hit_count} Stops Hit</div>
              </div>
            </div>
          </div>

          <!-- Recommendations Performance Section -->
          <div style="background:var(--bg-card); border:1px solid var(--border); padding:20px; border-radius:var(--radius-md); display:flex; flex-direction:column; gap:16px;">
            <div style="font-weight:700; font-size:1rem; color:var(--text-accent); border-bottom:1px solid var(--border); padding-bottom:8px; display:flex; align-items:center; gap:8px;">
              <span>📈 Simulated Picks Performance (Recommendations)</span>
            </div>
            
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:16px;">
              <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border); padding:16px; border-radius:var(--radius-md); text-align:center;">
                <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; margin-bottom:8px">📊 Total Picks</div>
                <div style="font-size:1.8rem; font-weight:800; color:var(--text-accent)">${totalPicks}</div>
                <div style="font-size:0.7rem; color:var(--text-secondary); margin-top:4px">${activePicks} Active | ${completedPicks} Settled</div>
              </div>
              <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border); padding:16px; border-radius:var(--radius-md); text-align:center;">
                <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; margin-bottom:8px">🎯 Win Rate</div>
                <div style="font-size:1.8rem; font-weight:800; color:#10b981">${winRate}%</div>
                <div style="font-size:0.7rem; color:var(--text-secondary); margin-top:4px">${winPicks} Wins | ${lossPicks} Losses</div>
              </div>
              <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border); padding:16px; border-radius:var(--radius-md); text-align:center;">
                <div style="font-size:0.75rem; color:var(--text-muted); text-transform:uppercase; font-weight:600; margin-bottom:8px">📈 Simulated ROI</div>
                <div style="font-size:1.8rem; font-weight:800; color:${simulatedROI >= 0 ? '#10b981' : '#ef4444'}">${roiSign}${simulatedROI.toFixed(1)}%</div>
                <div style="font-size:0.7rem; color:var(--text-secondary); margin-top:4px">Based on target hits vs SL triggers</div>
              </div>
            </div>
          </div>

          <!-- Webhook Alert Settings Config -->
          <div style="background:var(--bg-card); border:1px solid var(--border); padding:20px; border-radius:var(--radius-md); display:flex; flex-direction:column; gap:16px;">
            <div style="font-weight:700; font-size:1rem; color:var(--text-accent); border-bottom:1px solid var(--border); padding-bottom:8px; display:flex; align-items:center; gap:8px;">
              <span>🔔 Real-Time Webhook Configurations</span>
            </div>
            
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:20px;">
              <!-- Telegram Column -->
              <div style="display:flex; flex-direction:column; gap:12px; background:rgba(255,255,255,0.02); padding:14px; border-radius:var(--radius-sm); border:1px solid rgba(255,255,255,0.04)">
                <label style="display:flex; align-items:center; gap:8px; font-weight:600; font-size:0.85rem; cursor:pointer;">
                  <input type="checkbox" id="sett-tg-enabled" ${settings.telegram_enabled ? 'checked' : ''} style="cursor:pointer">
                  ✈️ Telegram Channel Alerts
                </label>
                <div style="display:flex; flex-direction:column; gap:4px">
                  <span style="font-size:0.7rem; color:var(--text-secondary)">Telegram Chat / Channel ID</span>
                  <input type="text" id="sett-tg-chat-id" value="${settings.telegram_chat_id || ''}" placeholder="-100xxxxxxxxx" style="background:var(--bg-body); border:1px solid var(--border); padding:8px; border-radius:4px; font-size:0.8rem; color:var(--text-primary)">
                </div>
                <div style="display:flex; flex-direction:column; gap:4px">
                  <span style="font-size:0.7rem; color:var(--text-secondary)">Telegram Bot Token (for real alerts)</span>
                  <input type="password" id="sett-tg-bot-token" value="${settings.telegram_bot_token || ''}" placeholder="botTokenxxxxxx:xxxxxx" style="background:var(--bg-body); border:1px solid var(--border); padding:8px; border-radius:4px; font-size:0.8rem; color:var(--text-primary)">
                </div>
              </div>

              <!-- WhatsApp Column -->
              <div style="display:flex; flex-direction:column; gap:12px; background:rgba(255,255,255,0.02); padding:14px; border-radius:var(--radius-sm); border:1px solid rgba(255,255,255,0.04)">
                <label style="display:flex; align-items:center; gap:8px; font-weight:600; font-size:0.85rem; cursor:pointer;">
                  <input type="checkbox" id="sett-wa-enabled" ${settings.whatsapp_enabled ? 'checked' : ''} style="cursor:pointer">
                  💬 WhatsApp Premium Signals
                </label>
                <div style="display:flex; flex-direction:column; gap:4px">
                  <span style="font-size:0.7rem; color:var(--text-secondary)">Phone Number (with Country Code)</span>
                  <input type="text" id="sett-wa-phone" value="${settings.whatsapp_phone || ''}" placeholder="+919876543210" style="background:var(--bg-body); border:1px solid var(--border); padding:8px; border-radius:4px; font-size:0.8rem; color:var(--text-primary)">
                </div>
                <div style="display:flex; flex-direction:column; gap:4px">
                  <span style="font-size:0.7rem; color:var(--text-secondary)">WhatsApp CallMeBot API Key</span>
                  <input type="password" id="sett-wa-apikey" value="${settings.whatsapp_apikey || ''}" placeholder="ApiKeyXXXXXX" style="background:var(--bg-body); border:1px solid var(--border); padding:8px; border-radius:4px; font-size:0.8rem; color:var(--text-primary)">
                </div>
              </div>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; border-top:1px solid var(--border); padding-top:12px;">
              <button id="btn-save-perf-settings" class="btn-primary" style="padding:8px 16px; font-size:0.8rem; border-radius: 4px; border: none; cursor: pointer; background: var(--text-accent); color: #fff;">💾 Save Webhook Configs</button>
              
              <!-- Send Test Signal Simulation -->
              <div style="display:flex; align-items:center; gap:8px;">
                <select id="sim-test-symbol" style="background:var(--bg-body); border:1px solid var(--border); padding:6px; border-radius:4px; font-size:0.8rem; color:var(--text-primary)">
                  ${recs.slice(0, 5).map(r => `<option value="${r.symbol}">${r.symbol.replace('.NS','').replace('.BO','')}</option>`).join('') || `<option value="RELIANCE.NS">RELIANCE</option><option value="AAPL">AAPL</option>`}
                </select>
                <button id="btn-trigger-test-signal" class="filter-btn" style="padding:6px 12px; font-size:0.8rem; background:rgba(6,182,212,0.15); border:1px solid #06b6d4; color:#06b6d4; cursor:pointer;">⚡ Send Test Signal</button>
              </div>
            </div>

            <!-- Terminal-like Console Log -->
            <div id="sim-console-log-wrap" style="display:none; flex-direction:column; gap:6px; margin-top:8px;">
              <div style="font-size:0.7rem; font-family:monospace; color:var(--text-secondary)">LOG TERMINAL OUTPUT:</div>
              <pre id="sim-console-log" style="background:#090d16; border:1px solid rgba(255,255,255,0.08); padding:12px; border-radius:4px; font-family:monospace; font-size:0.75rem; color:#10b981; overflow-x:auto; margin:0; line-height:1.4; max-height:220px; text-align:left;"></pre>
            </div>
          </div>

          <!-- Logged Picks Table -->
          <div style="background:var(--bg-card); border:1px solid var(--border); padding:20px; border-radius:var(--radius-md); overflow:hidden;">
            <div style="font-weight:700; font-size:1rem; color:var(--text-accent); border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:16px;">
              📋 Screened Swing Trade Logs
            </div>
            
            <div class="table-container" style="overflow-x:auto;">
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:0.8rem;">
                <thead>
                  <tr style="border-bottom:1px solid var(--border); color:var(--text-muted)">
                    <th style="padding:10px 8px;">Ticker</th>
                    <th style="padding:10px 8px;">Rating</th>
                    <th style="padding:10px 8px;">Entry Price</th>
                    <th style="padding:10px 8px;">Stop Loss</th>
                    <th style="padding:10px 8px;">Target 1 / 2</th>
                    <th style="padding:10px 8px;">Status</th>
                    <th style="padding:10px 8px; text-align:right;">Date Added</th>
                  </tr>
                </thead>
                <tbody>
                  ${recs.length === 0 ? `
                    <tr>
                      <td colspan="7" style="padding:24px; text-align:center; color:var(--text-muted)">No recommendations logged yet.</td>
                    </tr>
                  ` : recs.map(r => {
                      let statusBadgeColor = 'var(--yellow)';
                      if (r.status === 'WIN') statusBadgeColor = '#10b981';
                      if (r.status === 'LOSS') statusBadgeColor = '#ef4444';
                      
                      const dateStr = r.created_at ? new Date(r.created_at).toLocaleDateString() : 'N/A';
                      
                      return `
                        <tr style="border-bottom:1px solid rgba(255,255,255,0.03);">
                          <td style="padding:12px 8px; font-weight:700; color:var(--text-primary)">${r.symbol.replace('.NS','').replace('.BO','')}</td>
                          <td style="padding:12px 8px;"><span class="badge-${r.rating.includes('STRONG') ? 'strong-buy' : r.rating.includes('BUY') ? 'buy' : 'hold'}" style="font-size:0.65rem; padding:2px 6px; border-radius:3px;">${r.rating}</span></td>
                          <td style="padding:12px 8px;">${cSym}${parseFloat(r.price).toFixed(2)}</td>
                          <td style="padding:12px 8px; color:#ef4444; font-weight:600;">${cSym}${parseFloat(r.stop_loss).toFixed(2)}</td>
                          <td style="padding:12px 8px; color:#10b981; font-weight:600;">${cSym}${parseFloat(r.target_1).toFixed(2)} / ${cSym}${parseFloat(r.target_2).toFixed(2)}</td>
                          <td style="padding:12px 8px;"><span style="color:${statusBadgeColor}; font-weight:700; font-size:0.75rem;">● ${r.status}</span></td>
                          <td style="padding:12px 8px; text-align:right; color:var(--text-muted)">${dateStr}</td>
                        </tr>
                      `;
                    }).join('')}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      `;

      // Attach event listeners
      document.getElementById('btn-save-perf-settings').addEventListener('click', async () => {
        const tgEnabled = document.getElementById('sett-tg-enabled').checked;
        const tgChatId = document.getElementById('sett-tg-chat-id').value;
        const tgBotToken = document.getElementById('sett-tg-bot-token').value;
        const waEnabled = document.getElementById('sett-wa-enabled').checked;
        const waPhone = document.getElementById('sett-wa-phone').value;
        const waApiKey = document.getElementById('sett-wa-apikey').value;

        const updatedSettings = await API.saveSettings({
          telegram_enabled: tgEnabled,
          telegram_chat_id: tgChatId,
          telegram_bot_token: tgBotToken,
          whatsapp_enabled: waEnabled,
          whatsapp_phone: waPhone,
          whatsapp_apikey: waApiKey
        });

        UI.toast('Webhook configurations saved successfully!', 'success');
      });

      document.getElementById('btn-trigger-test-signal').addEventListener('click', async () => {
        const testSym = document.getElementById('sim-test-symbol').value;
        const tgChatId = document.getElementById('sett-tg-chat-id').value;
        const waPhone = document.getElementById('sett-wa-phone').value;
        const tgBotToken = document.getElementById('sett-tg-bot-token').value;
        const waApiKey = document.getElementById('sett-wa-apikey').value;

        const consoleWrap = document.getElementById('sim-console-log-wrap');
        const consoleLog = document.getElementById('sim-console-log');
        
        consoleWrap.style.display = 'flex';
        consoleLog.innerHTML = 'Connecting to webhook endpoints...';
        
        const response = await API.sendTestSignal(testSym, tgChatId, waPhone, tgBotToken, waApiKey);
        if (response && response.status === 'success') {
          consoleLog.innerHTML = `[SUCCESS] Webhook Dispatched:\n` + JSON.stringify(response.payload, null, 2);
          UI.toast('Webhook signal dispatched!', 'success');
        } else {
          consoleLog.innerHTML = `[ERROR] Failed to dispatch webhook signal. Check server logs.`;
          UI.toast('Signal dispatch failed', 'error');
        }
      });

    } catch (e) {
      console.error(e);
      container.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-muted);">
          <span>⚠️</span>
          <div>Failed to load performance report: ${e.message}</div>
        </div>
      `;
    }
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

  function renderPortfolioSection(data) {
    const disconnectedPane = document.getElementById('portfolio-disconnected-pane');
    const connectedPane = document.getElementById('portfolio-connected-pane');
    if (!disconnectedPane || !connectedPane) return;

    if (!data || !data.connected) {
      disconnectedPane.style.display = 'block';
      connectedPane.style.display = 'none';
      return;
    }

    disconnectedPane.style.display = 'none';
    connectedPane.style.display = 'block';

    const brokerBadge = document.getElementById('portfolio-connected-broker');
    if (brokerBadge) brokerBadge.innerText = data.brokerName || 'BROKER';

    const costEl = document.getElementById('portfolio-total-cost');
    const valEl = document.getElementById('portfolio-total-value');
    if (costEl) costEl.innerText = '₹' + fmt(data.summary.totalCost);
    if (valEl) valEl.innerText = '₹' + fmt(data.summary.totalValue);

    const pnlEl = document.getElementById('portfolio-total-pnl');
    if (pnlEl) {
      const pnlSign = data.summary.totalPnl >= 0 ? '+' : '';
      pnlEl.innerText = `${pnlSign}₹${fmt(data.summary.totalPnl)} (${pnlSign}${data.summary.totalPnlPercent.toFixed(2)}%)`;
      pnlEl.style.color = data.summary.totalPnl >= 0 ? '#34d399' : '#f87171';
    }

    const scoreEl = document.getElementById('portfolio-health-score');
    if (scoreEl) {
      scoreEl.innerText = data.summary.portfolioScore;
      if (data.summary.portfolioScore >= 75) scoreEl.style.color = '#34d399';
      else if (data.summary.portfolioScore >= 50) scoreEl.style.color = '#fbbf24';
      else scoreEl.style.color = '#f87171';
    }

    const alertBox = document.getElementById('portfolio-alert-box');
    const alertText = document.getElementById('portfolio-alert-text');
    if (alertBox && alertText) {
      if (data.summary.exitAlertCount > 0) {
        alertBox.style.background = 'rgba(248,113,113,0.1)';
        alertBox.style.borderColor = 'rgba(248,113,113,0.2)';
        alertBox.style.color = '#f87171';
        alertBox.querySelector('span').innerText = '⚠️';
        alertText.innerText = `${data.summary.exitAlertCount} stock(s) breached stop-loss or are weak. Action recommended!`;
      } else {
        alertBox.style.background = 'rgba(52,211,153,0.1)';
        alertBox.style.borderColor = 'rgba(52,211,153,0.2)';
        alertBox.style.color = '#34d399';
        alertBox.querySelector('span').innerText = '✅';
        alertText.innerText = 'All setups healthy. No urgent action required.';
      }
    }

    const tbody = document.getElementById('portfolio-holdings-tbody');
    if (tbody) {
      if (!data.holdings || data.holdings.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:20px; color:var(--text-muted);">No holdings synced. Add stocks to your broker account first!</td></tr>`;
        return;
      }

      tbody.innerHTML = data.holdings.map(h => {
        const pnlSign = h.pnl >= 0 ? '+' : '';
        const pnlColor = h.pnl >= 0 ? '#34d399' : '#f87171';
        
        let verdictColor = '#94a3b8';
        let verdictBg = 'rgba(148,163,184,0.15)';
        if (h.verdict === 'ADD / BUY') {
          verdictColor = '#34d399';
          verdictBg = 'rgba(52,211,153,0.15)';
        } else if (h.verdict === 'HOLD') {
          verdictColor = '#fbbf24';
          verdictBg = 'rgba(251,191,36,0.15)';
        } else if (h.verdict.startsWith('EXIT')) {
          verdictColor = '#f87171';
          verdictBg = 'rgba(248,113,113,0.15)';
        }
        
        let scoreColor = '#34d399';
        if (h.score < 50) scoreColor = '#f87171';
        else if (h.score < 75) scoreColor = '#fbbf24';

        return `
          <tr style="border-bottom:1px solid rgba(255,255,255,0.03);">
            <td style="font-weight:700; color:var(--text-primary); cursor:pointer;" onclick="App.selectStock('${h.symbol}')">
              ${h.symbol.replace('.NS', '').replace('.BO', '')}
            </td>
            <td>${h.quantity}</td>
            <td>₹${fmt(h.averageBuyPrice)}</td>
            <td>₹${fmt(h.currentPrice)}</td>
            <td>₹${fmt(h.cost)}</td>
            <td>₹${fmt(h.value)}</td>
            <td style="color:${pnlColor}; font-weight:700;">
              ${pnlSign}₹${fmt(h.pnl)} (${pnlSign}${h.pnlPercent.toFixed(2)}%)
            </td>
            <td style="font-weight:700; color:${scoreColor}">${h.score}</td>
            <td>
              <span style="display:inline-block; padding:3px 8px; border-radius:12px; font-size:0.7rem; font-weight:800; color:${verdictColor}; background:${verdictBg};">
                ${h.verdict}
              </span>
            </td>
            <td style="font-size:0.75rem; color:var(--text-muted); text-align:left; max-width:240px; white-space:normal; line-height:1.3;">
              ${h.verdictDetails}
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  return {
    toast, renderMarketTickers, renderMarketIndicesPanel, renderFearGreed, renderSectorHeatmap,
    renderWatchlistItem, renderRecCard, renderDetailHeader,
    renderFundamentals, renderTechnicals, renderSentiment,
    renderInstitutional, renderOverview, renderSearchResults, renderInvyMessage,
    renderLiveChart, setDetailLoading, fmt, fmtCr, fmtVol, fmtPct, colorClass,
    renderPerformanceDashboard, renderPortfolioSection
  };
})();


window.UI = UI;
