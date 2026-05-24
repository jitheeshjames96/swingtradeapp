/* ============================================================
   CHARTS.JS — Chart.js based rendering
   ============================================================ */

// Register Chart.js plugins globally (called after Chart.js loads)
function initChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.padding = 16;
}

// ── Store chart instances for cleanup
const _charts = {};

function destroyChart(id) {
  if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
}

function getOrCreate(canvasId) {
  const el = document.getElementById(canvasId);
  if (!el) return null;
  destroyChart(canvasId);
  return el.getContext('2d');
}

// ── Price Line Chart
function renderPriceChart(canvasId, historical, symbol) {
  const ctx = getOrCreate(canvasId);
  if (!ctx) return;

  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  const isUS = mode === 'US';
  const cSym = isUS ? '$' : '₹';
  const fmtLoc = isUS ? 'en-US' : 'en-IN';

  const data = historical.slice(-90); // Last 90 trading days
  const labels = data.map(d => d.date.toLocaleDateString(fmtLoc, { month: 'short', day: 'numeric' }));
  const closes = data.map(d => d.close);
  const volumes = data.map(d => d.volume);

  const sr = Analysis.calcSupportResistance(historical) || {};
  const annotations = {};
  if (sr.s1) {
    annotations.s1Line = {
      type: 'line',
      yMin: sr.s1,
      yMax: sr.s1,
      borderColor: 'rgba(16, 185, 129, 0.65)',
      borderWidth: 1.5,
      borderDash: [6, 4],
      label: {
        display: true,
        content: `S1: ${cSym}${sr.s1.toFixed(1)}`,
        position: 'start',
        backgroundColor: 'rgba(16, 185, 129, 0.85)',
        color: '#fff',
        font: { size: 8, weight: '600' },
        padding: { top: 2, bottom: 2, left: 4, right: 4 }
      }
    };
  }
  if (sr.r1) {
    annotations.r1Line = {
      type: 'line',
      yMin: sr.r1,
      yMax: sr.r1,
      borderColor: 'rgba(239, 68, 68, 0.65)',
      borderWidth: 1.5,
      borderDash: [6, 4],
      label: {
        display: true,
        content: `R1: ${cSym}${sr.r1.toFixed(1)}`,
        position: 'start',
        backgroundColor: 'rgba(239, 68, 68, 0.85)',
        color: '#fff',
        font: { size: 8, weight: '600' },
        padding: { top: 2, bottom: 2, left: 4, right: 4 }
      }
    };
  }

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(59,130,246,0.3)');
  gradient.addColorStop(1, 'rgba(59,130,246,0)');

  _charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: symbol,
        data: closes,
        borderColor: '#3b82f6',
        backgroundColor: gradient,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a2235',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: ctx => ` ${cSym}${ctx.parsed.y.toLocaleString(fmtLoc, { minimumFractionDigits: 2 })}`,
          },
        },
        annotation: {
          annotations
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 8, font: { size: 10 } },
        },
        y: {
          position: 'right',
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { font: { size: 10 }, callback: v => cSym + v.toLocaleString(fmtLoc) },
        },
      },
    },
  });
}

// ── RSI Chart
function renderRSIChart(canvasId, historical) {
  const ctx = getOrCreate(canvasId);
  if (!ctx) return;

  const closes = historical.slice(-90).map(d => d.close);
  const rsiValues = Analysis.calcRSI(closes, 14).filter(v => v !== null);
  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  const fmtLoc = mode === 'US' ? 'en-US' : 'en-IN';
  const labels = historical.slice(-rsiValues.length).map(d =>
    d.date.toLocaleDateString(fmtLoc, { month: 'short', day: 'numeric' })
  );

  _charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'RSI',
        data: rsiValues,
        borderColor: '#8b5cf6',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a2235',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          callbacks: { label: ctx => ` RSI: ${ctx.parsed.y.toFixed(1)}` },
        },
        annotation: {
          annotations: {
            ob: { type: 'line', yMin: 70, yMax: 70, borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, borderDash: [4, 4] },
            os: { type: 'line', yMin: 30, yMax: 30, borderColor: 'rgba(16,185,129,0.4)', borderWidth: 1, borderDash: [4, 4] },
            channel: {
              type: 'box',
              yMin: 30,
              yMax: 70,
              backgroundColor: 'rgba(139, 92, 246, 0.05)',
              borderWidth: 0
            }
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6, font: { size: 10 } } },
        y: {
          min: 0, max: 100,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { font: { size: 10 }, stepSize: 25 },
        },
      },
    },
  });
}

// ── MACD Chart
function renderMACDChart(canvasId, historical) {
  const ctx = getOrCreate(canvasId);
  if (!ctx) return;

  const closes = historical.slice(-90).map(d => d.close);
  const macdData = Analysis.calcMACD(closes, 12, 26, 9);
  const macdLine = macdData.macd.filter((_, i) => i >= 25);
  const signalLine = macdData.signal.filter(v => v !== null);
  const histogram = macdData.histogram.filter(v => v !== null);
  const len = Math.min(macdLine.length, signalLine.length, histogram.length);

  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  const fmtLoc = mode === 'US' ? 'en-US' : 'en-IN';
  const labels = historical.slice(-len).map(d =>
    d.date.toLocaleDateString(fmtLoc, { month: 'short', day: 'numeric' })
  );

  _charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'line', label: 'MACD', data: macdLine.slice(-len),
          borderColor: '#3b82f6', borderWidth: 2, pointRadius: 0, tension: 0.3, order: 1,
        },
        {
          type: 'line', label: 'Signal', data: signalLine.slice(-len),
          borderColor: '#f97316', borderWidth: 2, pointRadius: 0, tension: 0.3, order: 2,
        },
        {
          type: 'bar', label: 'Histogram', data: histogram.slice(-len),
          backgroundColor: (() => {
            const histSlice = histogram.slice(-len);
            return histSlice.map((v, i) => {
              if (i === 0) return v >= 0 ? 'rgba(16, 185, 129, 0.8)' : 'rgba(239, 68, 68, 0.8)';
              const prev = histSlice[i - 1];
              if (v >= 0) {
                return v > prev ? 'rgba(16, 185, 129, 0.8)' : 'rgba(16, 185, 129, 0.35)';
              } else {
                return v < prev ? 'rgba(239, 68, 68, 0.8)' : 'rgba(239, 68, 68, 0.35)';
              }
            });
          })(),
          order: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: { backgroundColor: '#1a2235', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1 },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6, font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 10 } } },
      },
    },
  });
}

// ── Volume Chart
function renderVolumeChart(canvasId, historical) {
  const ctx = getOrCreate(canvasId);
  if (!ctx) return;

  const data = historical.slice(-60);
  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  const fmtLoc = mode === 'US' ? 'en-US' : 'en-IN';
  const labels = data.map(d => d.date.toLocaleDateString(fmtLoc, { month: 'short', day: 'numeric' }));
  const volumes = data.map(d => d.volume);
  const avgVols = Analysis.calcSMA(volumes, 20);

  _charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Volume',
          data: volumes,
          backgroundColor: data.map((d, i) => {
            const prev = data[i - 1];
            if (!prev) return 'rgba(59,130,246,0.5)';
            return d.close >= prev.close ? 'rgba(16,185,129,0.5)' : 'rgba(239,68,68,0.5)';
          }),
          order: 2,
        },
        {
          type: 'line', label: 'Avg Volume (20)', data: avgVols,
          borderColor: '#f59e0b', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false, order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          backgroundColor: '#1a2235',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          callbacks: { label: ctx => ` ${(ctx.parsed.y / 1e6).toFixed(2)}M` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { font: { size: 10 }, callback: v => (v / 1e6).toFixed(1) + 'M' },
        },
      },
    },
  });
}

// ── Earnings Bar Chart
function renderEarningsChart(canvasId, earningsData) {
  const ctx = getOrCreate(canvasId);
  if (!ctx) return;

  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  const isUS = mode === 'US';
  const cSym = isUS ? '$' : '₹';
  const div = isUS ? 1e6 : 1e7;
  const unit = isUS ? 'M' : 'Cr';

  const quarterly = earningsData.quarterly.slice(0, 8).reverse();
  const labels = quarterly.map(q => q.period);
  const revenue = quarterly.map(q => q.revenue / div);
  const netIncome = quarterly.map(q => q.netIncome / div);

  _charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `Revenue (${cSym} ${unit})`,
          data: revenue,
          backgroundColor: 'rgba(59,130,246,0.6)',
          borderColor: '#3b82f6',
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: `Net Income (${cSym} ${unit})`,
          data: netIncome,
          backgroundColor: 'rgba(16,185,129,0.6)',
          borderColor: '#10b981',
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          backgroundColor: '#1a2235',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          callbacks: { label: ctx => ` ${cSym}${ctx.parsed.y.toFixed(0)} ${unit}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { font: { size: 10 }, callback: v => cSym + v.toFixed(0) + unit },
        },
      },
    },
  });
}

// ── Annual Revenue Chart
function renderAnnualEarningsChart(canvasId, earningsData) {
  const ctx = getOrCreate(canvasId);
  if (!ctx) return;

  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  const isUS = mode === 'US';
  const cSym = isUS ? '$' : '₹';
  const div = isUS ? 1e6 : 1e7;
  const unit = isUS ? 'M' : 'Cr';

  const annual = earningsData.annual.slice(0, 5).reverse();
  const labels = annual.map(a => a.period);
  const revenue = annual.map(a => a.revenue / div);
  const netIncome = annual.map(a => a.netIncome / div);

  _charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `Revenue (${cSym} ${unit})`,
          data: revenue,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.15)',
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
          pointRadius: 5,
          pointBackgroundColor: '#3b82f6',
        },
        {
          label: `Net Income (${cSym} ${unit})`,
          data: netIncome,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,0.1)',
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
          pointRadius: 5,
          pointBackgroundColor: '#10b981',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: {
          backgroundColor: '#1a2235',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          callbacks: { label: ctx => ` ${cSym}${ctx.parsed.y.toFixed(0)} ${unit}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { font: { size: 10 }, callback: v => cSym + v.toFixed(0) + unit },
        },
      },
    },
  });
}

// ── Radar Score Chart
function renderRadarChart(canvasId, scores) {
  const ctx = getOrCreate(canvasId);
  if (!ctx) return;

  _charts[canvasId] = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: ['Fundamentals', 'Technical Setup', 'Momentum', 'Sentiment', 'Institutional'],
      datasets: [{
        label: 'Score',
        data: [
          (scores.fundamental.score / 25) * 100,
          (scores.technicalSetup.score / 20) * 100,
          (scores.momentum.score / 20) * 100,
          (scores.sentiment.score / 15) * 100,
          (scores.institutional.score / 20) * 100,
        ],
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.2)',
        borderWidth: 2,
        pointBackgroundColor: '#3b82f6',
        pointRadius: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1a2235' } },
      scales: {
        r: {
          min: 0, max: 100,
          grid: { color: 'rgba(255,255,255,0.06)' },
          angleLines: { color: 'rgba(255,255,255,0.06)' },
          pointLabels: { font: { size: 10, weight: '600' }, color: '#94a3b8' },
          ticks: { display: false, stepSize: 25 },
        },
      },
    },
  });
}

// ── Bollinger Bands Chart
function renderBBChart(canvasId, historical) {
  const ctx = getOrCreate(canvasId);
  if (!ctx) return;

  const data = historical.slice(-60);
  const closes = data.map(d => d.close);
  const bb = Analysis.calcBollingerBands(closes, 20, 2);
  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  const fmtLoc = mode === 'US' ? 'en-US' : 'en-IN';
  const labels = data.map(d => d.date.toLocaleDateString(fmtLoc, { month: 'short', day: 'numeric' }));

  _charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Upper Band', data: bb.map(b => b.upper), borderColor: 'rgba(239,68,68,0.5)', borderWidth: 1, borderDash: [4,4], pointRadius: 0, fill: false },
        { label: 'Middle (SMA20)', data: bb.map(b => b.mid), borderColor: '#f59e0b', borderWidth: 1.5, pointRadius: 0, fill: false },
        { label: 'Lower Band', data: bb.map(b => b.lower), borderColor: 'rgba(16,185,129,0.5)', borderWidth: 1, borderDash: [4,4], pointRadius: 0, fill: '-2', backgroundColor: 'rgba(59, 130, 246, 0.04)' },
        { label: 'Price', data: closes, borderColor: '#3b82f6', borderWidth: 2, pointRadius: 0, fill: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: { backgroundColor: '#1a2235', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1 },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
        y: { position: 'right', grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 10 } } },
      },
    },
  });
}

// ── Shareholding Chart
function renderShareholdingChart(canvasId, shareholding) {
  const ctx = getOrCreate(canvasId);
  if (!ctx) return;

  if (!shareholding || (!shareholding.quarters && !shareholding.insiders && !shareholding.institutions)) {
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.fillText('No shareholding data available', ctx.canvas.width / 2, ctx.canvas.height / 2);
    return;
  }

  const isTrend = shareholding.quarters && shareholding.quarters.length > 0;

  if (isTrend) {
    const labels = shareholding.quarters.slice(-6);
    const len = labels.length;
    const promoters = (shareholding.promoters || []).slice(-len);
    const fii = (shareholding.fii || []).slice(-len);
    const dii = (shareholding.dii || []).slice(-len);
    const publicData = (shareholding.public || []).slice(-len);

    _charts[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Promoters', data: promoters, backgroundColor: '#10b981' },
          { label: 'FIIs', data: fii, backgroundColor: '#3b82f6' },
          { label: 'DIIs', data: dii, backgroundColor: '#8b5cf6' },
          { label: 'Public', data: publicData, backgroundColor: '#f59e0b' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top', labels: { font: { size: 10 } } },
          tooltip: {
            backgroundColor: '#1a2235',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}%` }
          }
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 9 } } },
          y: { stacked: true, max: 100, grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { font: { size: 9 }, callback: v => v + '%' } }
        }
      }
    });
  } else {
    const labels = ['Insiders', 'Institutions', 'Public'];
    const data = [
      shareholding.insiders || 0,
      shareholding.institutions || 0,
      shareholding.public || 0
    ];

    const nonEmptyData = [];
    const nonEmptyLabels = [];
    const colors = [];
    const colorMap = { 'Insiders': '#10b981', 'Institutions': '#3b82f6', 'Public': '#f59e0b' };
    
    labels.forEach((label, idx) => {
      if (data[idx] > 0) {
        nonEmptyData.push(data[idx]);
        nonEmptyLabels.push(label);
        colors.push(colorMap[label]);
      }
    });

    _charts[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: nonEmptyLabels,
        datasets: [{
          data: nonEmptyData,
          backgroundColor: colors,
          borderColor: '#0e1320',
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top', labels: { font: { size: 10 } } },
          tooltip: {
            backgroundColor: '#1a2235',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed.toFixed(2)}%` }
          }
        },
        cutout: '65%'
      }
    });
  }
}

function renderHistoricalScoreChart(symbol) {
  const canvasId = 'chart-historical-score';
  const ctx = getOrCreate(canvasId);
  if (!ctx) return;

  const result = window.App?.state?.results?.get(symbol);
  if (!result) return;

  const customWeights = window.App?.state?.weights;
  const activeRegime = window.App?.state?.activeRegime;

  const historicalSeries = Analysis.getHistoricalScoreSeries(result, customWeights, activeRegime);
  if (!historicalSeries || historicalSeries.length === 0) {
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.fillText('Insufficient historical data for score trajectory', ctx.canvas.width / 2, ctx.canvas.height / 2);
    return;
  }

  // Slice last 90 trading days or all if less
  const data = historicalSeries.slice(-90);
  const mode = localStorage.getItem('stid_market_mode') || 'IN';
  const fmtLoc = mode === 'US' ? 'en-US' : 'en-IN';
  const labels = data.map(d => new Date(d.date).toLocaleDateString(fmtLoc, { month: 'short', day: 'numeric' }));
  const scores = data.map(d => d.score);

  // Update regime hint in UI
  const regimeHint = document.getElementById('score-regime-hint');
  if (regimeHint) {
    if (activeRegime === 'bear') {
      regimeHint.textContent = 'Bear Regime Overrides Active (Value boosted, Momentum penalized)';
      regimeHint.style.color = 'var(--red)';
    } else {
      regimeHint.textContent = 'Bull Regime Multipliers Active';
      regimeHint.style.color = 'var(--green)';
    }
  }

  const gradient = ctx.createLinearGradient(0, 0, 0, 200);
  gradient.addColorStop(0, 'rgba(59, 130, 246, 0.2)');
  gradient.addColorStop(1, 'rgba(59, 130, 246, 0)');

  _charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Composite Score',
        data: scores,
        borderColor: '#3b82f6',
        backgroundColor: gradient,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a2235',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          callbacks: {
            label: ctx => ` Score: ${ctx.parsed.y.toFixed(1)} / 100`
          }
        },
        annotation: {
          annotations: {
            buyZone: {
              type: 'box',
              yMin: 70,
              yMax: 100,
              backgroundColor: 'rgba(16, 185, 129, 0.08)',
              borderWidth: 0
            },
            neutralZone: {
              type: 'box',
              yMin: 50,
              yMax: 70,
              backgroundColor: 'rgba(245, 158, 11, 0.05)',
              borderWidth: 0
            },
            avoidZone: {
              type: 'box',
              yMin: 0,
              yMax: 50,
              backgroundColor: 'rgba(239, 68, 68, 0.08)',
              borderWidth: 0
            },
            buyLine: {
              type: 'line',
              yMin: 70,
              yMax: 70,
              borderColor: 'rgba(16, 185, 129, 0.25)',
              borderWidth: 1,
              borderDash: [5, 5]
            },
            avoidLine: {
              type: 'line',
              yMin: 50,
              yMax: 50,
              borderColor: 'rgba(239, 68, 68, 0.25)',
              borderWidth: 1,
              borderDash: [5, 5]
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 8, font: { size: 9 } }
        },
        y: {
          min: 0,
          max: 100,
          position: 'right',
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { font: { size: 9 }, stepSize: 20 }
        }
      }
    }
  });
}

window.renderHistoricalScoreChart = renderHistoricalScoreChart;

window.Charts = {
  initChartDefaults,
  renderPriceChart, renderRSIChart, renderMACDChart, renderVolumeChart,
  renderEarningsChart, renderAnnualEarningsChart, renderRadarChart, renderBBChart,
  renderShareholdingChart, renderHistoricalScoreChart, destroyChart,
};
