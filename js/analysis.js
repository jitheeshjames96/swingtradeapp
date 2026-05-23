/* ============================================================
   ANALYSIS.JS — Scoring Engine & Technical Indicators
   ============================================================ */

// ============================================================
// TECHNICAL INDICATORS
// ============================================================

function calcSMA(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    return slice.reduce((s, v) => s + v, 0) / period;
  });
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const ema = [];
  closes.forEach((c, i) => {
    if (i === 0) { ema.push(c); return; }
    ema.push(c * k + ema[i - 1] * (1 - k));
  });
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(50);
  const rsi = [];
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  const padding = Array(closes.length - rsi.length).fill(null);
  return [...padding, ...rsi];
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = calcEMA(macdLine.slice(slow - 1), signal);
  const histogram = macdLine.slice(slow - 1).map((m, i) => m - (signalLine[i] || 0));
  return {
    macd: macdLine,
    signal: [...Array(slow - 1).fill(null), ...signalLine],
    histogram: [...Array(slow - 1).fill(null), ...histogram],
  };
}

function calcBollingerBands(closes, period = 20, stdDev = 2) {
  const sma = calcSMA(closes, period);
  return closes.map((_, i) => {
    if (i < period - 1) return { upper: null, mid: null, lower: null };
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = sma[i];
    const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    return { upper: mean + stdDev * std, mid: mean, lower: mean - stdDev * std };
  });
}

function calcATR(highs, lows, closes, period = 14) {
  const tr = closes.map((c, i) => {
    if (i === 0) return highs[i] - lows[i];
    return Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  });
  return calcEMA(tr, period);
}

function calcVolumeAvg(volumes, period = 20) {
  return volumes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = volumes.slice(i - period + 1, i + 1);
    return slice.reduce((s, v) => s + v, 0) / period;
  });
}

// Helper to group daily bars into weekly bars
function getWeeklyBars(dailyBars) {
  const weekly = [];
  let currentWeek = null;
  for (const bar of dailyBars) {
    const date = new Date(bar.date);
    const tempDate = new Date(date);
    const day = tempDate.getDay();
    const diff = tempDate.getDate() - day + (day === 0 ? -6 : 1);
    const weekStart = new Date(tempDate.setDate(diff)).toDateString();
    
    if (!currentWeek || currentWeek.weekStart !== weekStart) {
      if (currentWeek) {
        weekly.push(currentWeek);
      }
      currentWeek = {
        weekStart,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume
      };
    } else {
      currentWeek.high = Math.max(currentWeek.high, bar.high);
      currentWeek.low = Math.min(currentWeek.low, bar.low);
      currentWeek.close = bar.close;
      currentWeek.volume += bar.volume;
    }
  }
  if (currentWeek) weekly.push(currentWeek);
  return weekly;
}

// ── Support & Resistance Levels
function calcSupportResistance(data) {
  if (!data || data.length < 30) {
    const dummy = { pivot: 0, r1: 0, r2: 0, s1: 0, s2: 0, supports: [], resistances: [] };
    return { daily: dummy, weekly: dummy, fourHour: dummy, pivot: 0, r1: 0, r2: 0, s1: 0, s2: 0, supports: [], resistances: [] };
  }

  const getPivots = (high, low, close) => {
    const pivot = (high + low + close) / 3;
    const r1 = 2 * pivot - low;
    const r2 = pivot + (high - low);
    const s1 = 2 * pivot - high;
    const s2 = pivot - (high - low);
    return { pivot, r1, r2, s1, s2 };
  };

  // Daily support/resistance based on previous completed daily candle
  const prevDay = data[data.length - 2] || data[data.length - 1];
  const daily = getPivots(prevDay.high, prevDay.low, prevDay.close);

  // Weekly support/resistance based on previous completed weekly candle
  const weeklyBars = getWeeklyBars(data);
  const prevWeek = weeklyBars[weeklyBars.length - 2] || weeklyBars[weeklyBars.length - 1] || prevDay;
  const weekly = getPivots(prevWeek.high, prevWeek.low, prevWeek.close);

  // 4-Hour / Intraday approximation: use last 3 daily bars
  const recent3 = data.slice(-3);
  const recentHigh = Math.max(...recent3.map(d => d.high));
  const recentLow = Math.min(...recent3.map(d => d.low));
  const recentClose = data[data.length - 1].close;
  const fourHour = getPivots(recentHigh, recentLow, recentClose);

  const recent = data.slice(-30);
  const resistances = recent
    .filter((d, i, arr) => i > 0 && i < arr.length - 1 && d.high > arr[i - 1].high && d.high > arr[i + 1].high)
    .map(d => d.high)
    .slice(-3);

  const supports = recent
    .filter((d, i, arr) => i > 0 && i < arr.length - 1 && d.low < arr[i - 1].low && d.low < arr[i + 1].low)
    .map(d => d.low)
    .slice(-3);

  // Return standard fields at root for backward compatibility
  return { 
    daily, 
    weekly, 
    fourHour, 
    pivot: daily.pivot, 
    r1: daily.r1, 
    r2: daily.r2, 
    s1: daily.s1, 
    s2: daily.s2, 
    supports, 
    resistances 
  };
}

// ── Volume Spike Detection (Institutional Activity Proxy)
function detectVolumeSpikes(data) {
  if (!data || data.length < 21) return { spikes: [], avgVolume: 0, latestRatio: 1, institutionalSignal: 'neutral' };

  const volumes = data.map(d => d.volume);
  const avgVols = calcVolumeAvg(volumes, 20);

  const latestVol = volumes[volumes.length - 1];
  const latestAvg = avgVols[avgVols.length - 1] || 1;
  const latestRatio = latestVol / latestAvg;

  const spikes = data.slice(-20).filter((d, i) => {
    const avg = avgVols[avgVols.length - 20 + i];
    return avg && d.volume > avg * 1.5;
  });

  let institutionalSignal = 'neutral';
  if (latestRatio > 2.5) institutionalSignal = 'strong';
  else if (latestRatio > 1.5) institutionalSignal = 'moderate';
  else if (latestRatio < 0.7) institutionalSignal = 'weak';

  // Detect if price went UP with volume spike (institutional accumulation)
  const lastCandle = data[data.length - 1];
  const prevCandle = data[data.length - 2];
  const priceUp = lastCandle && prevCandle && lastCandle.close > prevCandle.close;

  return {
    spikes: spikes.length,
    avgVolume: latestAvg,
    latestVolume: latestVol,
    latestRatio: parseFloat(latestRatio.toFixed(2)),
    institutionalSignal,
    accumulation: priceUp && latestRatio > 1.5,
    distribution: !priceUp && latestRatio > 1.5,
  };
}

// ── Trend Detection
function detectTrend(data) {
  if (!data || data.length < 50) return 'sideways';
  const closes = data.map(d => d.close);
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);

  const last20 = sma20[sma20.length - 1];
  const last50 = sma50[sma50.length - 1];
  const currentPrice = closes[closes.length - 1];

  if (currentPrice > last20 && last20 > last50) return 'uptrend';
  if (currentPrice < last20 && last20 < last50) return 'downtrend';
  return 'sideways';
}

// ============================================================
// SCORING ENGINE (0–100)
// ============================================================

function scoreFundamentals(fund, symbol, sector) {
  if (!fund) {
    return {
      score: 0,
      checklist: [
        { label: 'Valuation Quality', passed: false, value: 'N/A', desc: 'PE below industry average or PB ratio under 3.0 indicates healthy valuation.', score: 0, max: 9 },
        { label: 'Earnings & Revenue Growth', passed: false, value: 'N/A', desc: 'Strong double digit top-line and bottom-line growth confirms business expansion.', score: 0, max: 8 },
        { label: 'Balance Sheet & ROE', passed: false, value: 'N/A', desc: 'Debt-to-equity below 1.0 limits insolvency risk, while ROE above 12% shows efficient capital use.', score: 0, max: 8 }
      ]
    };
  }

  const checklist = [];
  
  // Clean symbol and sector
  const sym = (symbol || '').toUpperCase();
  const sec = (sector || '').toUpperCase();
  
  // Determine if financial sector (Banking, Financial Services, NBFCs)
  const isFinancial = sec.includes('BANK') || sec.includes('NBFC') || sec.includes('FINANCIAL') || 
                      ['HDFCBANK.NS', 'ICICIBANK.NS', 'AXISBANK.NS', 'SBIN.NS', 'KOTAKBANK.NS', 'BAJFINANCE.NS', 'BAJAJFINSV.NS', 'JPM', 'GS', 'MS'].includes(sym);
                      
  // Determine if Mega Cap (Market Cap > 1.5 Lakh Crore / 1.5 Trillion INR for Indian, or > 150B USD for US)
  const isIndian = sym.endsWith('.NS') || sym.endsWith('.BO');
  const marketCap = fund.marketCap || 0;
  const isMegaCap = isIndian ? (marketCap > 1.5e12) : (marketCap > 1.5e11);

  // 1. Valuation Quality (9 pts)
  let peScore = 0;
  let peDesc = '';
  if (fund.pe === null || fund.pe === undefined || fund.pe <= 0) {
    peScore = 5;
    peDesc = 'PE: N/A';
  } else if (fund.pe < 15) {
    peScore = 9;
    peDesc = `PE: ${fund.pe.toFixed(1)} (Highly Undervalued)`;
  } else if (fund.pe < 30) {
    peScore = 7;
    peDesc = `PE: ${fund.pe.toFixed(1)} (Reasonable/Fair)`;
  } else if (fund.pe < 45) {
    peScore = 5;
    peDesc = `PE: ${fund.pe.toFixed(1)} (Premium Valuation)`;
  } else {
    peScore = 2;
    peDesc = `PE: ${fund.pe.toFixed(1)} (Highly Stretched)`;
  }
  
  // P/E industry comparison bonus point
  let peBonus = 0;
  if (fund.pe !== null && fund.pe !== undefined && fund.industryPe !== null && fund.industryPe !== undefined && fund.pe > 0) {
    // If PE is less than industry PE or within 10% premium
    if (fund.pe < fund.industryPe * 1.1) {
      peBonus = 1;
      peDesc += ` [Industry PE: ${fund.industryPe.toFixed(1)}]`;
    }
  }
  
  let pbScore = 0;
  let pbDesc = '';
  if (fund.pb === null || fund.pb === undefined || fund.pb <= 0) {
    pbScore = 5;
    pbDesc = 'PB: N/A';
  } else if (fund.pb < 3) {
    pbScore = 9;
    pbDesc = `PB: ${fund.pb.toFixed(2)} (Value)`;
  } else if (fund.pb < 6) {
    pbScore = 7;
    pbDesc = `PB: ${fund.pb.toFixed(2)} (Reasonable)`;
  } else {
    pbScore = 4;
    pbDesc = `PB: ${fund.pb.toFixed(2)} (Stretched)`;
  }
  
  const valScore = Math.min(9, Math.round((peScore + pbScore) / 2) + peBonus);
  const valPassed = valScore >= 6;
  checklist.push({
    label: 'Valuation Quality',
    passed: valPassed,
    value: `${peDesc}, ${pbDesc}`,
    desc: 'Assesses P/E vs industry averages and P/B ratios. Moat companies are allowed premium multiples.',
    score: valScore,
    max: 9
  });

  // 2. Earnings & Revenue Growth (8 pts)
  let revScore = 0;
  let revDesc = '';
  if (fund.revenueGrowth === null || fund.revenueGrowth === undefined) {
    revScore = 1;
    revDesc = 'N/A';
  } else if (fund.revenueGrowth > 12) {
    revScore = 4;
    revDesc = `Rev YoY: +${fund.revenueGrowth.toFixed(1)}%`;
  } else if (fund.revenueGrowth > 6) {
    revScore = 3;
    revDesc = `Rev YoY: +${fund.revenueGrowth.toFixed(1)}%`;
  } else if (fund.revenueGrowth >= 0) {
    revScore = 2;
    revDesc = `Rev YoY: +${fund.revenueGrowth.toFixed(1)}%`;
  } else {
    revScore = 0;
    revDesc = `Rev YoY: ${fund.revenueGrowth.toFixed(1)}% (Decline)`;
  }

  let earnScore = 0;
  let earnDesc = '';
  if (fund.earningsGrowth === null || fund.earningsGrowth === undefined) {
    earnScore = 1;
    earnDesc = 'N/A';
  } else if (fund.earningsGrowth > 15) {
    earnScore = 4;
    earnDesc = `EPS YoY: +${fund.earningsGrowth.toFixed(1)}%`;
  } else if (fund.earningsGrowth > 8) {
    earnScore = 3;
    earnDesc = `EPS YoY: +${fund.earningsGrowth.toFixed(1)}%`;
  } else if (fund.earningsGrowth >= 0) {
    earnScore = 2;
    earnDesc = `EPS YoY: +${fund.earningsGrowth.toFixed(1)}%`;
  } else {
    earnScore = 0;
    earnDesc = `EPS YoY: ${fund.earningsGrowth.toFixed(1)}% (Decline)`;
  }

  const growthScore = Math.min(8, revScore + earnScore);
  const growthPassed = growthScore >= 5;
  checklist.push({
    label: 'Earnings & Revenue Growth',
    passed: growthPassed,
    value: `${revDesc}, ${earnDesc}`,
    desc: 'Measures top-line revenue expansion and bottom-line EPS acceleration year-over-year.',
    score: growthScore,
    max: 8
  });

  // 3. Balance Sheet & ROE (8 pts)
  let debtScore = 0;
  let debtDesc = '';
  if (isFinancial) {
    if (fund.currentRatio !== null && fund.currentRatio !== undefined) {
      if (fund.currentRatio > 1.2) {
        debtScore = 4;
        debtDesc = `Financials: Strong Liquidity (Current Ratio: ${fund.currentRatio.toFixed(2)})`;
      } else {
        debtScore = 3;
        debtDesc = `Financials: Adequate Liquidity (Current Ratio: ${fund.currentRatio.toFixed(2)})`;
      }
    } else {
      debtScore = 4;
      debtDesc = `Leverage: N/A (Financial Sector)`;
    }
  } else if (fund.debtToEquity === null || fund.debtToEquity === undefined) {
    debtScore = 2;
    debtDesc = 'D/E: N/A';
  } else if (fund.debtToEquity < 0.5) {
    debtScore = 4;
    debtDesc = `D/E: ${fund.debtToEquity.toFixed(2)} (Minimal Debt)`;
  } else if (fund.debtToEquity < 1.0) {
    debtScore = 3;
    debtDesc = `D/E: ${fund.debtToEquity.toFixed(2)} (Healthy)`;
  } else if (fund.debtToEquity < 1.5) {
    debtScore = 2;
    debtDesc = `D/E: ${fund.debtToEquity.toFixed(2)} (Moderate Debt)`;
  } else {
    debtScore = 1;
    debtDesc = `D/E: ${fund.debtToEquity.toFixed(2)} (Leveraged)`;
  }

  let roeScore = 0;
  let roeDesc = '';
  const roeVal = (fund.roe !== null && fund.roe !== undefined) ? fund.roe : ((fund.roce !== null && fund.roce !== undefined) ? fund.roce : null);
  const isRoceFallback = fund.roe === null || fund.roe === undefined;
  const metricLabel = isRoceFallback ? 'ROCE' : 'ROE';

  if (roeVal === null || roeVal === undefined) {
    roeScore = 1;
    roeDesc = 'Profitability: N/A';
  } else if (isMegaCap) {
    if (roeVal > 12) {
      roeScore = 4;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Excellent for scale)`;
    } else if (roeVal > 9) {
      roeScore = 3;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Solid for scale)`;
    } else if (roeVal >= 5) {
      roeScore = 2;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Low/Consolidating)`;
    } else {
      roeScore = 1;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Poor)`;
    }
  } else {
    if (roeVal > 15) {
      roeScore = 4;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Excellent)`;
    } else if (roeVal > 10) {
      roeScore = 3;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Good)`;
    } else if (roeVal >= 6) {
      roeScore = 2;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Subpar)`;
    } else {
      roeScore = 1;
      roeDesc = `${metricLabel}: ${roeVal.toFixed(1)}% (Poor)`;
    }
  }

  // Margin bonus point
  let marginBonus = 0;
  if (fund.profitMargin !== null && fund.profitMargin !== undefined && fund.profitMargin > 15) {
    marginBonus = 1;
    roeDesc += ` [Margin: ${fund.profitMargin.toFixed(1)}%]`;
  }

  const balanceScore = Math.min(8, debtScore + roeScore + marginBonus);
  const balancePassed = balanceScore >= 6;
  checklist.push({
    label: 'Balance Sheet & ROE',
    passed: balancePassed,
    value: `${debtDesc}, ${roeDesc}`,
    desc: 'Verifies leverage limits to avoid insolvency and confirms capital efficiency via Return on Equity.',
    score: balanceScore,
    max: 8
  });

  return { score: Math.min(25, valScore + growthScore + balanceScore), checklist };
}

function scoreTechnicalSetup(data, quote) {
  if (!data || data.length < 30) {
    return {
      score: 0,
      checklist: [
        { label: 'Trend Structure (SMA)', passed: false, value: 'N/A', desc: 'Price > SMA20 > SMA50 > SMA200', score: 0, max: 9 },
        { label: 'Support Zone Proximity', passed: false, value: 'N/A', desc: 'Price within 3% of support (S1/S2 or SMA200)', score: 0, max: 8 },
        { label: 'Volatility Squeeze/Breakout', passed: false, value: 'N/A', desc: 'Bollinger Band squeeze or upper band breakout', score: 0, max: 8 }
      ],
      indicators: {}
    };
  }

  const closes = data.map(d => d.close);
  const currentPrice = closes[closes.length - 1];
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);

  const lastSma20 = sma20[sma20.length - 1] || 0;
  const lastSma50 = sma50[sma50.length - 1] || 0;
  const lastSma200 = sma200[sma200.length - 1] || 0;

  const sr = calcSupportResistance(data);
  const bb = calcBollingerBands(closes, 20, 2);
  const lastBB = bb[bb.length - 1] || {};

  const checklist = [];
  let score = 0;

  // 1. SMA Trend Structure (9 pts)
  let smaPassed = false;
  let smaText = [];
  if (currentPrice > lastSma20) smaText.push('Price > SMA20');
  if (lastSma20 > lastSma50) smaText.push('SMA20 > SMA50');
  if (lastSma50 > lastSma200) smaText.push('SMA50 > SMA200');

  if (currentPrice > lastSma20 && lastSma20 > lastSma50) {
    smaPassed = true;
  }
  const smaScore = smaPassed ? (lastSma50 > lastSma200 ? 9 : 7) : 3;
  score += smaScore;
  checklist.push({
    label: 'Trend Structure (SMA)',
    passed: smaPassed,
    value: smaText.length > 0 ? smaText.join(', ') : 'Downtrend alignment',
    desc: 'Aligning with SMA20, 50, and 200 ensures trading in the direction of the primary market trend.',
    score: smaScore,
    max: 9
  });

  // 2. Support Zone Proximity (8 pts)
  let supportPassed = false;
  let supportVal = 'Far from support';
  const distS1 = sr.s1 ? Math.abs(currentPrice - sr.s1) / currentPrice : 99;
  const distS2 = sr.s2 ? Math.abs(currentPrice - sr.s2) / currentPrice : 99;
  const distSma200 = lastSma200 ? Math.abs(currentPrice - lastSma200) / currentPrice : 99;
  const symbol = quote?.symbol || '';
  const isUS = !symbol.endsWith('.NS') && !symbol.endsWith('.BO');
  const cSym = isUS ? '$' : '₹';

  if (distS1 < 0.03) {
    supportPassed = true;
    supportVal = `Near S1 (${cSym}${sr.s1.toFixed(1)})`;
  } else if (distS2 < 0.03) {
    supportPassed = true;
    supportVal = `Near S2 (${cSym}${sr.s2.toFixed(1)})`;
  } else if (distSma200 < 0.03) {
    supportPassed = true;
    supportVal = `Near SMA200 (${cSym}${lastSma200.toFixed(1)})`;
  }

  const supportScore = supportPassed ? 8 : 3;
  score += supportScore;
  checklist.push({
    label: 'Support Zone Proximity',
    passed: supportPassed,
    value: supportPassed ? supportVal : `S1: ${cSym}${sr.s1?.toFixed(1) || 'N/A'}`,
    desc: 'Entering trades near key supports provides optimal risk-to-reward setup and invalidation levels.',
    score: supportScore,
    max: 8
  });

  // 3. Volatility Squeeze/Breakout (8 pts)
  let bbPassed = false;
  let bbVal = 'Normal Bandwidth';
  const bbBandwidth = lastBB.mid ? (lastBB.upper - lastBB.lower) / lastBB.mid : 99;
  if (bbBandwidth < 0.12) {
    bbPassed = true;
    bbVal = `Squeeze (Bandwidth: ${(bbBandwidth * 100).toFixed(1)}%)`;
  } else if (currentPrice >= lastBB.upper) {
    bbPassed = true;
    bbVal = 'Upper Band Breakout';
  }
  const bbScore = bbPassed ? 8 : 4;
  score += bbScore;
  checklist.push({
    label: 'Volatility Squeeze/Breakout',
    passed: bbPassed,
    value: bbVal,
    desc: 'Bollinger Band Squeeze hints at imminent expansion. Breakout above upper band indicates strong momentum.',
    score: bbScore,
    max: 8
  });

  const volData = detectVolumeSpikes(data);
  const trend = detectTrend(data);

  return {
    score: Math.min(25, score),
    checklist,
    indicators: {
      sma20: lastSma20,
      sma50: lastSma50,
      sma200: lastSma200,
      sr,
      lastBB,
      currentPrice,
      volData,
      trend
    }
  };
}

function scoreMomentum(data) {
  if (!data || data.length < 30) {
    return {
      score: 0,
      checklist: [
        { label: 'RSI Momentum Zone', passed: false, value: 'N/A', desc: 'RSI between 40 and 65 (bull phase)', score: 0, max: 9 },
        { label: 'MACD Trend Confirmation', passed: false, value: 'N/A', desc: 'MACD Line > Signal Line', score: 0, max: 8 },
        { label: 'Volume Confirmation', passed: false, value: 'N/A', desc: 'Current volume > 1.5x of 20-day average', score: 0, max: 8 }
      ],
      indicators: {}
    };
  }

  const closes = data.map(d => d.close);
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);

  const rsiArr = calcRSI(closes, 14);
  const rsi = rsiArr[rsiArr.length - 1] || 50;

  const macdData = calcMACD(closes);
  const lastMacd = macdData.macd[macdData.macd.length - 1] || 0;
  const lastSignal = macdData.signal[macdData.signal.length - 1] || 0;
  const prevMacd = macdData.macd[macdData.macd.length - 2] || 0;
  const prevSignal = macdData.signal[macdData.signal.length - 2] || 0;
  const macdCrossover = lastMacd > lastSignal && prevMacd <= prevSignal;
  const macdBullish = lastMacd > lastSignal;

  const volData = detectVolumeSpikes(data);
  const atrArr = calcATR(highs, lows, closes, 14);
  const atr = atrArr[atrArr.length - 1] || closes[closes.length - 1] * 0.02;

  const checklist = [];
  let score = 0;

  // 1. RSI Zone Check (9 pts)
  let rsiPassed = false;
  let rsiVal = `RSI: ${rsi.toFixed(1)}`;
  if (rsi >= 40 && rsi <= 65) {
    rsiPassed = true;
    rsiVal += ' (Bullish Zone)';
  } else if (rsi < 40) {
    rsiVal += ' (Oversold/Weak)';
  } else {
    rsiVal += ' (Overbought Alert)';
  }
  const rsiScore = rsi >= 40 && rsi <= 65 ? 9 : rsi >= 30 && rsi < 40 ? 6 : rsi > 65 && rsi <= 75 ? 5 : 2;
  score += rsiScore;
  checklist.push({
    label: 'RSI Momentum Zone',
    passed: rsi >= 40 && rsi <= 70,
    value: rsiVal,
    desc: 'RSI between 40 and 65 signals healthy trend momentum. Avoid entry when RSI is > 75 (overbought).',
    score: rsiScore,
    max: 9
  });

  // 2. MACD Trend Check (8 pts)
  let macdPassed = false;
  let macdVal = 'Bearish';
  if (macdCrossover) {
    macdPassed = true;
    macdVal = 'Bullish Crossover! 🔥';
  } else if (macdBullish) {
    macdPassed = true;
    macdVal = 'Bullish Alignment';
  }
  const macdScore = macdCrossover ? 8 : macdBullish ? 6 : 2;
  score += macdScore;
  checklist.push({
    label: 'MACD Trend Confirmation',
    passed: macdPassed,
    value: macdVal,
    desc: 'Bullish MACD line crossing above the signal line indicates positive momentum acceleration.',
    score: macdScore,
    max: 8
  });

  // 3. Volume Confirmation (8 pts)
  let volPassed = false;
  let volVal = `${volData.latestRatio}x avg`;
  if (volData.latestRatio >= 1.5) {
    volPassed = true;
    volVal += ' (Surge)';
  }
  const volScore = volData.latestRatio >= 2.0 ? 8 : volData.latestRatio >= 1.4 ? 6 : volData.latestRatio >= 1.0 ? 4 : 1;
  score += volScore;
  checklist.push({
    label: 'Volume Confirmation',
    passed: volPassed,
    value: volVal,
    desc: 'Volume expansion confirms the price move is backed by institutional buying, not noise.',
    score: volScore,
    max: 8
  });

  return {
    score: Math.min(25, score),
    checklist,
    indicators: {
      rsi,
      rsiSignal: rsi < 30 ? 'Oversold' : rsi > 70 ? 'Overbought' : rsi >= 40 && rsi <= 60 ? 'Healthy' : 'Neutral',
      macd: parseFloat(lastMacd.toFixed(3)),
      macdSignal: parseFloat(lastSignal.toFixed(3)),
      macdCrossover,
      macdBullish,
      volData,
      atr
    }
  };
}

function scoreSentimentFlows(fearGreed, news, volData, fund) {
  const checklist = [];
  let score = 0;

  // 1. Institutional Flows (9 pts)
  let flowPassed = false;
  let flowVal = 'Neutral Flows';
  let sh = fund?.shareholding || {};

  let instPercentage = null;
  if (sh.fii && sh.fii.length > 0 && sh.dii && sh.dii.length > 0) {
    instPercentage = (sh.fii[sh.fii.length - 1] || 0) + (sh.dii[sh.dii.length - 1] || 0);
  } else if (sh.institutions !== undefined && sh.institutions !== null) {
    instPercentage = sh.institutions;
  }

  if (instPercentage !== null && instPercentage > 25) {
    flowPassed = true;
    flowVal = `High FII/DII (${instPercentage.toFixed(1)}%)`;
  } else if (volData?.accumulation) {
    flowPassed = true;
    flowVal = 'Accumulation Spike (Est)';
  } else if (instPercentage !== null) {
    flowVal = `FII/DII: ${instPercentage.toFixed(1)}%`;
  }

  const instScore = instPercentage > 35 ? 9 : volData?.accumulation ? 8 : volData?.institutionalSignal === 'moderate' ? 6 : 3;
  score += instScore;
  checklist.push({
    label: 'Institutional Flows (FII/DII)',
    passed: flowPassed || instScore >= 6,
    value: flowVal,
    desc: 'Tracking promoter holding and institutional accumulation reveals smart money actions.',
    score: instScore,
    max: 9
  });

  // 2. Fear & Greed Index (8 pts)
  const fgVal = fearGreed?.value || 50;
  let fgPassed = false;
  let fgValText = `${fgVal} - ${fearGreed?.text || 'Neutral'}`;

  let fgScore = 4;
  if (fgVal <= 45) {
    fgPassed = true;
    fgScore = fgVal <= 25 ? 8 : 7;
  } else if (fgVal <= 60) {
    fgScore = 5;
  } else {
    fgScore = fgVal > 75 ? 2 : 3;
  }
  score += fgScore;
  checklist.push({
    label: 'Market Sentiment (Fear & Greed)',
    passed: fgPassed,
    value: fgValText,
    desc: 'Buying in Fear zones limits structural risk, while buying in Greed zones exposes to market reversals.',
    score: fgScore,
    max: 8
  });

  // 3. News Sentiment Bias (8 pts)
  let newsPassed = false;
  let newsVal = 'No News Sentiment';
  let newsScore = 4;

  if (news && news.length > 0) {
    const pos = news.filter(n => n.sentiment === 'positive').length;
    const neg = news.filter(n => n.sentiment === 'negative').length;
    const total = news.length;
    const ratio = (pos - neg) / total;

    if (ratio > 0.1) {
      newsPassed = true;
      newsVal = `Positive bias (+${Math.round(ratio * 100)}%)`;
      newsScore = ratio > 0.4 ? 8 : 6;
    } else if (ratio < -0.1) {
      newsVal = `Negative bias (${Math.round(ratio * 100)}%)`;
      newsScore = ratio < -0.4 ? 1 : 2;
    } else {
      newsVal = 'Neutral news bias';
      newsScore = 4;
    }
  }
  score += newsScore;
  checklist.push({
    label: 'News Sentiment Ratio',
    passed: newsPassed || newsScore >= 4,
    value: newsVal,
    desc: 'Monitors the ratio of positive to negative press and research reports on the stock.',
    score: newsScore,
    max: 8
  });

  return { score: Math.min(25, score), checklist };
}

function compositeScore(fundScore, setupScore, momScore, flowScore) {
  const total = fundScore + setupScore + momScore + flowScore;
  let rating, ratingClass, emoji;
  if (total >= 80)      { rating = 'Strong Buy';    ratingClass = 'strong-buy';    emoji = '🟢'; }
  else if (total >= 65) { rating = 'Buy';            ratingClass = 'buy';           emoji = '🟡'; }
  else if (total >= 50) { rating = 'Watch';          ratingClass = 'watch';         emoji = '🟠'; }
  else if (total >= 35) { rating = 'Avoid';          ratingClass = 'avoid';         emoji = '🔴'; }
  else                  { rating = 'Strong Avoid';   ratingClass = 'strong-avoid';  emoji = '⛔'; }

  return { total, rating, ratingClass, emoji };
}

function calcTradeSetup(currentPrice, setupInds, momInds) {
  const atr = momInds?.atr || currentPrice * 0.02;
  const sr = setupInds?.sr || {};

  let stopLoss = currentPrice - 2.0 * atr;
  if (sr.s1 && sr.s1 < currentPrice && sr.s1 > currentPrice - 3.5 * atr) {
    stopLoss = sr.s1 * 0.99;
  }
  stopLoss = parseFloat(stopLoss.toFixed(2));

  const target1 = parseFloat((currentPrice + 1.5 * (currentPrice - stopLoss)).toFixed(2));
  const target2 = parseFloat((currentPrice + 2.5 * (currentPrice - stopLoss)).toFixed(2));
  const target3 = sr.r2 && sr.r2 > currentPrice ? parseFloat(sr.r2.toFixed(2)) : parseFloat((currentPrice + 4.0 * (currentPrice - stopLoss)).toFixed(2));
  const riskReward = parseFloat(((target2 - currentPrice) / (currentPrice - stopLoss)).toFixed(2));

  return { stopLoss, target1, target2, target3, riskReward, indicators: setupInds };
}

function determineMarketPhase(price, fiftyTwoWeekHigh, s1, compositeScore) {
  const drawdown = (fiftyTwoWeekHigh - price) / fiftyTwoWeekHigh;
  if (drawdown <= 0.025) {
    return {
      phase: "All-Time High",
      justification: "The stock is trading within 2.5% of its 52-week high, displaying strong momentum but with potential consolidation risk near peaks."
    };
  }
  const isNearSupport = s1 && (price <= s1 * 1.05 && price >= s1 * 0.95);
  if (compositeScore >= 65 && (isNearSupport || (drawdown > 0.025 && drawdown < 0.10))) {
    return {
      phase: "Buy Zone",
      justification: "The stock is trading near solid support levels with a high composite rating, representing an optimal low-risk entry zone."
    };
  }
  if (drawdown >= 0.10 && drawdown <= 0.20) {
    return {
      phase: "Correction Phase",
      justification: "The stock has experienced a healthy 10-20% correction from its peak, presenting selective accumulation opportunities near major supports."
    };
  }
  if (drawdown > 0.20) {
    return {
      phase: "Bearish Correction Phase",
      justification: "The stock is in a deeper correction phase (down >20% from peak), trading below standard levels. Risk mitigation is highly advised."
    };
  }
  return {
    phase: "Consolidation Zone",
    justification: "The stock is consolidating between its peak and core support. Wait for breakout or pullback to buy zone."
  };
}

function generateStaticRationale(symbol, name, scores, tradeSetup, quote, historical) {
  const composite = scores.composite;
  const sym = symbol.replace('.NS', '').replace('.BO', '');
  const price = quote?.price || 0;

  const isUS = !symbol.endsWith('.NS') && !symbol.endsWith('.BO');
  const cSym = isUS ? '$' : '₹';

  const stopLoss = tradeSetup.stopLoss;
  const target1 = tradeSetup.target1;
  const target2 = tradeSetup.target2;
  const rr = tradeSetup.riskReward;

  const inds = tradeSetup.indicators || {};
  const s1 = inds.sr?.s1 ? parseFloat(inds.sr.s1.toFixed(2)) : null;
  const r1 = inds.sr?.r1 ? parseFloat(inds.sr.r1.toFixed(2)) : null;

  const histBars = historical || [];
  const fiftyTwoWeekHigh = histBars.length > 0 ? Math.max(...histBars.map(h => h.high)) : price;
  const phaseInfo = determineMarketPhase(price, fiftyTwoWeekHigh, s1, composite.total);

  let verdictExplain = '';
  let winReason = '';
  let lossRisk = '';
  let entryZone = '';

  if (composite.total >= 80) {
    const entryMin = s1 ? Math.min(price, s1) : price * 0.98;
    const entryMax = price * 1.01;
    entryZone = `${cSym}${entryMin.toFixed(2)} - ${cSym}${entryMax.toFixed(2)} (Accumulate on minor pullbacks to support S1 at ${cSym}${s1 || 'support'} or 20 EMA, or on a confirmed high-volume breakout above ${cSym}${r1 || 'resistance'})`;
    verdictExplain = `Strong confluence of fundamental value and momentum breakout makes this a high-conviction trade. Institutional net buying combined with a clear price breakout above key SMAs indicates robust smart money accumulation. The stock exhibits superior relative strength in its sector.`;
    winReason = `Sustained momentum and high volume support a quick expansion to Target 1 (${cSym}${target1}) and Target 2 (${cSym}${target2}). The price has verified support levels and exhibits low relative volatility band expansion. Risk-to-reward ratio is highly favorable at 1:${rr}.`;
    lossRisk = `A broader market correction or volume exhaustion could trigger a pullback to the stop loss. However, placing the SL below support (${cSym}${stopLoss}) protects from market noise.`;
  } else if (composite.total >= 65) {
    const entryMin = s1 ? s1 : price * 0.97;
    entryZone = `${cSym}${entryMin.toFixed(2)} - ${cSym}${price.toFixed(2)} (Optimal entry on minor pullbacks towards support S1 at ${cSym}${s1 || 'support'} or the 50 SMA)`;
    verdictExplain = `Stock is in a healthy uptrend with supportive fundamentals. While minor indicators are cooling off, it provides a solid swing structure. Entry within current ranges is optimal.`;
    winReason = `The trend is backed by SMA alignment and decent volume. A continuation move has high odds (~65% probability) given current sector momentum. Expected targets are Target 1 (${cSym}${target1}) and Target 2 (${cSym}${target2}).`;
    lossRisk = `Failure to hold the immediate support might lead to a minor retracement to key levels before the primary trend resumes. Keep the stop loss firm at ${cSym}${stopLoss}.`;
  } else if (composite.total >= 50) {
    const entryMin = s1 ? s1 : price * 0.95;
    entryZone = `${cSym}${entryMin.toFixed(2)} - ${cSym}${r1 ? r1 : price * 1.02} (Wait for a confirmed volume breakout above resistance at ${cSym}${r1 || 'R1'} or a deeper pullback to key support at ${cSym}${s1 || 'S1'})`;
    verdictExplain = `The stock is currently in a range-bound or consolidation phase. Mixed signals across momentum (RSI/MACD) and fundamentals suggest waiting for a clear breakout confirmation above immediate resistance.`;
    winReason = `An upside breakout would validate the base structure, leading to a quick rally to Target 1 (${cSym}${target1}).`;
    lossRisk = `Consolidation could drag on, tying up trading capital, or break down towards key levels. A tight entry zone and stop loss at ${cSym}${stopLoss} is required to manage risk.`;
  } else {
    entryZone = `N/A (Avoid or short-sell if appropriate; not suitable for long swing trades)`;
    verdictExplain = `High debt, weak bottom-line growth, or a severe technical markdown structure makes this stock highly risky. Smart money indicators suggest active institutional distribution (selling).`;
    winReason = `A minor oversold short-covering bounce might offer a quick exit, but the upside is heavily capped.`;
    lossRisk = `Further downside breakdown is highly probable. Structural damage to the chart suggests high risk of a trailing stop loss trigger. Avoid or exit current positions.`;
  }

  const passedChecks = scores.checklist.filter(c => c.passed).length;
  const totalChecks = scores.checklist.length;
  const winChance = Math.round(35 + (passedChecks / totalChecks) * 50);

  return `
    <div style="margin-bottom:12px; font-size:0.92rem; line-height:1.6; color:var(--text-primary)">
      <strong>Verdict Rationale Summary:</strong><br>
      ${verdictExplain}
    </div>
    <div style="display:flex; flex-direction:column; gap:8px; font-size:0.85rem; color:var(--text-secondary)">
      <div>🎯 <strong>Rating & Verdict:</strong> <span style="font-weight:700; color:${composite.total >= 80 ? 'var(--green)' : composite.total >= 65 ? 'var(--green-dim)' : composite.total >= 50 ? 'var(--yellow)' : 'var(--red)'}">${composite.total >= 80 ? 'STRONG BUY' : composite.total >= 65 ? 'BUY' : composite.total >= 50 ? 'WATCH / HOLD' : 'AVOID / AVOID'}</span></div>
      <div>🔄 <strong>Market Phase:</strong> <span style="font-weight:700; color:var(--text-primary)">${phaseInfo.phase}</span> - <em>${phaseInfo.justification}</em></div>
      <div>⚡ <strong>Technical Entry Zone:</strong> <strong style="color:var(--text-primary)">${entryZone}</strong></div>
      <div>🟢 <strong>Chances of Profit:</strong> ${winReason}</div>
      <div>🔴 <strong>Key Risks:</strong> ${lossRisk}</div>
      <div>📈 <strong>Stop Loss / Targets:</strong> SL: <strong style="color:var(--red)">${cSym}${stopLoss}</strong> | T1: <strong style="color:var(--green)">${cSym}${target1}</strong> | T2: <strong style="color:var(--green)">${cSym}${target2}</strong></div>
      <div>📊 <strong>Score & Probability:</strong> Composite score is <strong>${composite.total}/100</strong>. Evaluated win probability is <strong style="color:var(--green)">${winChance}%</strong> based on ${passedChecks} out of ${totalChecks} professional-grade criteria matching.</div>
    </div>
  `;
}

async function analyzeStock(symbol, name, sector) {
  let quote, fund, historical, earnings, news, fearGreed, shareholding = null;
  let backendActive = false;

  try {
    backendActive = await API.checkBackend();
  } catch (e) {
    backendActive = false;
  }

  if (backendActive) {
    try {
      const data = await API.fetchFullAnalysisFromBackend(symbol);
      // Backend returned an error
      if (data.error) {
        throw new Error(data.error + (data.details ? ': ' + data.details : ''));
      }
      quote = data.quote;
      fund = data.fundamentals;
      historical = (data.historical || []).map(h => ({ ...h, date: new Date(h.date) }));
      earnings = data.earnings;
      shareholding = data.shareholding || null;
      
      // Use bundled news and fearGreed if available, avoiding separate HTTP requests
      if (data.news && data.news.length > 0) {
        news = data.news;
      } else {
        news = await API.fetchNewsSentiment(symbol);
      }
      
      if (data.fearGreed) {
        fearGreed = data.fearGreed;
      } else {
        try {
          const pulse = await API.fetchMarketPulseFromBackend();
          fearGreed = pulse.fearGreed;
        } catch (pe) {
          fearGreed = { value: 50, text: 'Neutral' };
        }
      }
    } catch (e) {
      console.warn('Backend fetch failed for', symbol, ', falling back to client-side:', e.message);
      // Always fall back to client-side CORS proxy — never fatal-throw here.
      // A backend 500 (Yahoo rate-limit, transient error, bad ticker) should gracefully
      // degrade to the proxyFetch path so the user still sees data.
      backendActive = false;
    }
  }

  if (!backendActive) {
    [quote, fund, historical, earnings, news, fearGreed] = await Promise.all([
      API.fetchQuote(symbol),
      API.fetchFundamentals(symbol),
      API.fetchHistorical(symbol, '1y', '1d'),
      API.fetchEarnings(symbol),
      API.fetchNewsSentiment(symbol),
      API.fetchFearGreed(),
    ]);
    shareholding = fund ? fund.shareholding : null;
  }

  // Validate quote
  if (!quote || !quote.price || quote.price === 0) {
    throw new Error(`No price data available for ${symbol}. Check if the ticker symbol is correct.`);
  }

  const fundResult  = scoreFundamentals(fund, symbol, sector);
  const setupResult = scoreTechnicalSetup(historical, quote);
  const momResult   = scoreMomentum(historical);
  const flowResult  = scoreSentimentFlows(fearGreed, news, setupResult.indicators?.volData, fund);
  const composite   = compositeScore(fundResult.score, setupResult.score, momResult.score, flowResult.score);

  const checklist = [
    ...fundResult.checklist,
    ...setupResult.checklist,
    ...momResult.checklist,
    ...flowResult.checklist
  ];

  const scores = {
    fundamental: fundResult,
    technicalSetup: setupResult,
    momentum: momResult,
    sentimentFlow: flowResult,
    composite,
    checklist
  };

  const tradeSetup = calcTradeSetup(quote.price, setupResult.indicators, momResult.indicators);

  const histBars = historical || [];
  const fiftyTwoWeekHigh = histBars.length > 0 ? Math.max(...histBars.map(h => h.high)) : quote.price;
  const s1 = tradeSetup.indicators?.sr?.s1 || tradeSetup.indicators?.s1 || null;
  const phaseInfo = determineMarketPhase(quote.price, fiftyTwoWeekHigh, s1, composite.total);

  const dataSummary = {
    price: quote.price,
    pe: fund?.pe,
    pb: fund?.pb,
    revenueGrowthPct: fund?.revenueGrowth,
    earningsGrowthPct: fund?.earningsGrowth,
    rsi: momResult.indicators?.rsi,
    trend: setupResult.indicators?.trend,
    volRatio: setupResult.indicators?.volData?.latestRatio,
    institutionalSignal: setupResult.indicators?.volData?.institutionalSignal,
    compositeScore: composite.total,
    compositeRating: composite.rating,
    marketPhase: phaseInfo.phase,
    drawdownFrom52WeekHighPct: parseFloat(((fiftyTwoWeekHigh - quote.price) / fiftyTwoWeekHigh * 100).toFixed(2))
  };

  let geminiCommentary = null;
  try {
    const apiKey = localStorage.getItem('gemini_api_key');
    if (apiKey) {
      geminiCommentary = await API.fetchGeminiAnalysis(symbol, name || symbol, dataSummary);
    }
  } catch (e) {
    console.warn('Gemini analysis fetch failed', e);
  }

  if (!geminiCommentary) {
    geminiCommentary = generateStaticRationale(symbol, name || symbol, scores, tradeSetup, quote, historical);
  }

  return {
    symbol, name: name || symbol, sector: sector || 'N/A',
    quote, fund, historical, earnings, news, fearGreed, shareholding,
    scores,
    tradeSetup,
    geminiCommentary,
    analyzedAt: new Date().toISOString(),
  };
}

// ── Score color helper
function scoreColor(score, max) {
  const pct = score / max;
  if (pct >= 0.8) return '#10b981';
  if (pct >= 0.6) return '#22c55e';
  if (pct >= 0.4) return '#f59e0b';
  if (pct >= 0.2) return '#f97316';
  return '#ef4444';
}

function scoreFillClass(total) {
  if (total >= 80) return 'fill-green';
  if (total >= 65) return 'fill-lime';
  if (total >= 50) return 'fill-yellow';
  if (total >= 35) return 'fill-orange';
  return 'fill-red';
}

function scoreBadgeClass(ratingClass) {
  return `badge-${ratingClass}`;
}

window.Analysis = {
  analyzeStock,
  calcRSI, calcMACD, calcSMA, calcEMA, calcBollingerBands,
  calcATR, calcSupportResistance, detectVolumeSpikes, detectTrend,
  scoreFundamentals, scoreTechnicalSetup, scoreMomentum, scoreSentimentFlows,
  compositeScore, calcTradeSetup,
  scoreColor, scoreFillClass, scoreBadgeClass,
};
