/* ============================================================
   APP.JS — Main Application Controller
   ============================================================ */

const App = (() => {

  // ── State
  const state = {
    watchlist: [],          // Array of { symbol, name, sector }
    results: new Map(),     // symbol → full analysis result
    activeSymbol: null,
    activeTab: 'overview',
    loading: new Set(),
    fearGreed: null,
    sectors: [],
    indices: [],
  };

  const DEFAULT_WATCHLIST = [
    { symbol: 'RELIANCE.NS',  name: 'Reliance Industries',      sector: 'Energy' },
    { symbol: 'TCS.NS',       name: 'Tata Consultancy Services', sector: 'IT' },
    { symbol: 'HDFCBANK.NS',  name: 'HDFC Bank',                sector: 'Banking' },
    { symbol: 'INFY.NS',      name: 'Infosys Ltd',              sector: 'IT' },
    { symbol: 'TATAMOTORS.NS',name: 'Tata Motors',              sector: 'Auto' },
    { symbol: 'ETERNAL.NS',   name: 'Eternal Limited (Zomato)', sector: 'Consumer' },
  ];

  // Indian NSE stock suffixes — bare tickers we auto-fix to .NS
  const KNOWN_INDIAN_BASES = new Set([
    'RELIANCE','TCS','INFY','HDFCBANK','ICICIBANK','WIPRO','TATAMOTORS','TATASTEEL',
    'ADANIENT','BAJFINANCE','SBIN','SUNPHARMA','HINDUNILVR','AXISBANK','MARUTI',
    'ETERNAL','BAJAJFINSV','KOTAKBANK','LT','ASIANPAINT','HCLTECH','ULTRACEMCO',
    'POWERGRID','NTPC','NESTLEIND','TITAN','TATAPOWER','DRREDDY','CIPLA',
    'ONGC','COALINDIA','TECHM','DIVISLAB','BPCL','GRASIM','HEROMOTOCO','JSWSTEEL',
    'HINDALCO','BRITANNIA','EICHERMOT','APOLLOHOSP','BAJAJ-AUTO','INDUSINDBK',
    'TRENT','SIEMENS','HAVELLS','PIDILITIND','VOLTAS','BHARTIARTL','M&M',
  ]);

  const WATCHLIST_VERSION = 3; // bump to force-reset stale localStorage

  // ── LocalStorage helpers
  function saveWatchlist() {
    try {
      localStorage.setItem('stid_watchlist', JSON.stringify(state.watchlist));
      localStorage.setItem('stid_watchlist_version', String(WATCHLIST_VERSION));
    } catch(e) {}
  }
  function loadWatchlist() {
    try {
      const version = parseInt(localStorage.getItem('stid_watchlist_version') || '0');
      const saved = localStorage.getItem('stid_watchlist');
      
      if (saved && version >= WATCHLIST_VERSION) {
        const parsed = JSON.parse(saved);
        // Auto-fix bare Indian tickers: RELIANCE → RELIANCE.NS, etc.
        return parsed.map(item => {
          let sym = (item.symbol || '').trim().toUpperCase();
          // If bare uppercase with no dot/caret, check if it's a known Indian ticker
          if (!sym.includes('.') && !sym.startsWith('^')) {
            if (KNOWN_INDIAN_BASES.has(sym)) {
              sym = sym + '.NS';
            }
          }
          return { ...item, symbol: sym };
        });
      } else if (saved && version < WATCHLIST_VERSION) {
        // Stale version: migrate old entries to .NS where needed
        console.log('Migrating watchlist from version', version, 'to', WATCHLIST_VERSION);
        const parsed = JSON.parse(saved);
        const migrated = parsed.map(item => {
          let sym = (item.symbol || '').trim().toUpperCase();
          if (!sym.includes('.') && !sym.startsWith('^')) {
            sym = sym + '.NS'; // Aggressively append .NS to any bare Indian-style ticker
          }
          return { ...item, symbol: sym };
        });
        // Save migrated version
        try {
          localStorage.setItem('stid_watchlist', JSON.stringify(migrated));
          localStorage.setItem('stid_watchlist_version', String(WATCHLIST_VERSION));
        } catch(e) {}
        return migrated;
      }
    } catch(e) {}
    return DEFAULT_WATCHLIST;
  }

  let googleClientId = '';

  // Google SSO Callback
  async function handleGoogleLoginCallback(response) {
    const credential = response.credential;
    localStorage.setItem('google_sso_token', credential);
    
    const errorMsgEl = document.getElementById('login-error-msg');
    if (errorMsgEl) errorMsgEl.style.display = 'none';

    try {
      // Verify login with backend
      const backendUrl = API.getBackendUrl();
      const res = await fetch(`${backendUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${credential}`
        }
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'You are not authorized to access this app.');
      }
      
      // Hide overlay
      const overlay = document.getElementById('login-overlay');
      if (overlay) overlay.style.display = 'none';
      
      // Show logout button
      const btnLogout = document.getElementById('btn-logout');
      if (btnLogout) btnLogout.style.display = 'inline-block';
      
      UI.toast('Signed in successfully!', 'success');
      
      // Start loading sequence
      await finishInit();
      
    } catch (err) {
      localStorage.removeItem('google_sso_token');
      if (errorMsgEl) {
        errorMsgEl.innerText = `Sign-in failed: ${err.message}`;
        errorMsgEl.style.display = 'block';
      }
      UI.toast(err.message, 'error');
    }
  }

  async function finishInit() {
    showWatchlistSkeleton();
    await loadMarketData();
    await loadAllWatchlistStocks();
    if (state.watchlist.length > 0) {
      selectStock(state.watchlist[0].symbol);
    }
  }

  // ── Init
  async function init() {
    Charts.initChartDefaults();
    state.watchlist = loadWatchlist();
    bindEvents();
    
    // Fetch SSO configuration
    const config = await API.fetchAuthConfig();
    googleClientId = config.googleClientId;

    if (googleClientId) {
      const token = localStorage.getItem('google_sso_token');
      
      // Setup Google Identity Services button
      if (typeof google !== 'undefined') {
        google.accounts.id.initialize({
          client_id: googleClientId,
          callback: handleGoogleLoginCallback
        });
        
        google.accounts.id.renderButton(
          document.getElementById('google-signin-btn'),
          { theme: 'filled_blue', size: 'large', text: 'signin_with', width: 250 }
        );
      } else {
        console.error('Google Identity Services script not loaded');
      }

      if (token) {
        // We have a token saved, let's verify it by hitting /api/auth/login
        try {
          const backendUrl = API.getBackendUrl();
          const res = await fetch(`${backendUrl}/api/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            }
          });
          
          if (!res.ok) {
            throw new Error('Token expired or invalid');
          }
          
          // Token is valid!
          const btnLogout = document.getElementById('btn-logout');
          if (btnLogout) btnLogout.style.display = 'inline-block';
          
          await finishInit();
        } catch (e) {
          console.warn('Session verification failed, requesting re-login:', e.message);
          localStorage.removeItem('google_sso_token');
          document.getElementById('login-overlay').style.display = 'flex';
        }
      } else {
        // No token, show login screen
        document.getElementById('login-overlay').style.display = 'flex';
      }
    } else {
      // SSO not configured, standard boot
      await finishInit();
    }
  }

  // ── Event Bindings
  function bindEvents() {
    // Search input
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      let debounceTimer;
      searchInput.addEventListener('input', e => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const q = e.target.value.trim();
          if (q.length > 0) UI.renderSearchResults(API.searchStocks(q));
          else document.getElementById('search-dropdown')?.classList.remove('show');
        }, 200);
      });
      searchInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          document.getElementById('search-dropdown')?.classList.remove('show');
          searchInput.value = '';
        } else if (e.key === 'Enter') {
          const q = searchInput.value.trim().toUpperCase();
          if (q.length > 0) {
            addStock(q, q, 'N/A');
          }
        }
      });
    }

    // Close dropdown on outside click
    document.addEventListener('click', e => {
      if (!e.target.closest('.topbar-search')) {
        document.getElementById('search-dropdown')?.classList.remove('show');
      }
      if (!e.target.closest('#btn-settings') && !e.target.closest('#settings-dropdown')) {
        document.getElementById('settings-dropdown').style.display = 'none';
      }
    });

    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Refresh market data button
    const refreshBtn = document.getElementById('btn-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        const icon = refreshBtn.querySelector('.refresh-icon');
        if (icon) icon.classList.add('spinning');
        await loadMarketData();
        if (icon) icon.classList.remove('spinning');
        UI.toast('Market data refreshed!', 'success');
      });
    }

    // Add stock button (manual ticker entry)
    const addBtn = document.getElementById('btn-add-manual');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const input = document.getElementById('search-input');
        if (input && input.value.trim()) {
          const sym = input.value.trim().toUpperCase();
          addStock(sym, sym, 'N/A');
          input.value = '';
        }
      });
    }

    // Settings Toggle
    const btnSettings = document.getElementById('btn-settings');
    const settingsDropdown = document.getElementById('settings-dropdown');
    const apiKeyInput = document.getElementById('api-key-input');
    const backendUrlInput = document.getElementById('backend-url-input');
    
    if (btnSettings && settingsDropdown) {
      btnSettings.addEventListener('click', e => {
        e.stopPropagation();
        const isShown = settingsDropdown.style.display === 'block';
        settingsDropdown.style.display = isShown ? 'none' : 'block';
        if (!isShown) {
          if (apiKeyInput) {
            apiKeyInput.value = localStorage.getItem('gemini_api_key') || '';
          }
          if (backendUrlInput) {
            backendUrlInput.value = localStorage.getItem('swing_backend_url') || '';
          }
        }
      });
    }

    const btnSettingsCancel = document.getElementById('btn-settings-cancel');
    if (btnSettingsCancel && settingsDropdown) {
      btnSettingsCancel.addEventListener('click', () => {
        settingsDropdown.style.display = 'none';
      });
    }

    // Reset Watchlist button: clears localStorage and reloads with clean defaults
    const btnResetWatchlist = document.getElementById('btn-reset-watchlist');
    if (btnResetWatchlist) {
      btnResetWatchlist.addEventListener('click', () => {
        if (!confirm('This will reset your watchlist to the default stocks. Continue?')) return;
        localStorage.removeItem('stid_watchlist');
        localStorage.removeItem('stid_watchlist_version');
        settingsDropdown.style.display = 'none';
        UI.toast('Watchlist reset! Reloading...', 'success');
        setTimeout(() => window.location.reload(), 800);
      });
    }

    const btnSettingsSave = document.getElementById('btn-settings-save');
    if (btnSettingsSave && settingsDropdown) {
      btnSettingsSave.addEventListener('click', () => {
        if (apiKeyInput) {
          const key = apiKeyInput.value.trim();
          if (key) {
            localStorage.setItem('gemini_api_key', key);
            UI.toast('Gemini API Key saved!', 'success');
          } else {
            localStorage.removeItem('gemini_api_key');
            UI.toast('Gemini API Key removed.', 'info');
          }
        }

        if (backendUrlInput) {
          const url = backendUrlInput.value.trim();
          if (url) {
            localStorage.setItem('swing_backend_url', url);
            API.setBackendUrl(url);
            UI.toast('Backend URL updated!', 'success');
          } else {
            localStorage.removeItem('swing_backend_url');
            API.setBackendUrl('');
            UI.toast('Backend URL reset to default.', 'info');
          }
        }

        settingsDropdown.style.display = 'none';
        // Reload analysis for current active symbol if present to apply the backend changes
        if (state.activeSymbol) {
          selectStock(state.activeSymbol);
        }
      });
    }

    // Invy Chat Toggle
    const invyChatToggle = document.getElementById('invy-chat-toggle');
    const invyChatDrawer = document.getElementById('invy-chat-drawer');
    const invyChatClose = document.getElementById('invy-chat-close');
    
    if (invyChatToggle && invyChatDrawer) {
      invyChatToggle.addEventListener('click', () => {
        invyChatDrawer.classList.add('show');
        invyChatDrawer.setAttribute('aria-hidden', 'false');
        document.getElementById('invy-chat-input')?.focus();
      });
    }

    if (invyChatClose && invyChatDrawer) {
      invyChatClose.addEventListener('click', () => {
        invyChatDrawer.classList.remove('show');
        invyChatDrawer.setAttribute('aria-hidden', 'true');
      });
    }

    // Invy Chat Submit
    const invyChatSend = document.getElementById('invy-chat-send');
    const invyChatInput = document.getElementById('invy-chat-input');
    
    if (invyChatSend && invyChatInput) {
      invyChatSend.addEventListener('click', () => handleInvySend());
      invyChatInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleInvySend();
        }
      });
    }

    // Google SSO Sign Out
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', () => {
        localStorage.removeItem('google_sso_token');
        UI.toast('Signed out successfully', 'info');
        setTimeout(() => {
          window.location.reload();
        }, 800);
      });
    }
  }

  // ── Load market-wide data (indices, F&G, sectors)
  async function loadMarketData() {
    try {
      let indices, fearGreed, sectors;
      let backendActive = false;

      try {
        backendActive = await API.checkBackend();
      } catch (e) {
        backendActive = false;
      }

      if (backendActive) {
        try {
          const pulse = await API.fetchMarketPulseFromBackend();
          indices = pulse.indices;
          fearGreed = pulse.fearGreed;
        } catch (e) {
          console.warn('Backend pulse fetch failed, using fallback', e.message);
          backendActive = false;
        }
      }

      if (!backendActive) {
        indices = await API.fetchMarketIndices();
        fearGreed = await API.fetchFearGreed();
      }

      sectors = await API.fetchSectorPerformance();

      state.indices = indices;
      state.fearGreed = fearGreed;
      state.sectors = sectors;
      UI.renderMarketTickers(indices);
      UI.renderFearGreed(fearGreed);
      UI.renderSectorHeatmap(sectors);
    } catch (e) {
      console.warn('loadMarketData error:', e);
    }
  }

  // ── Load all watchlist stocks
  async function loadAllWatchlistStocks() {
    updateWatchlistUI();
    const promises = state.watchlist.map(({ symbol, name, sector }) =>
      analyzeAndStore(symbol, name, sector)
    );
    await Promise.allSettled(promises);
    updateWatchlistUI();
    updateRecommendations();
  }

  // ── Analyse a single stock and store
  async function analyzeAndStore(symbol, name, sector) {
    if (state.loading.has(symbol)) return;
    state.loading.add(symbol);
    
    // Helper: auto-retry with .NS suffix for bare Indian-style tickers
    const retryWithNS = async (sym, nm, sec) => {
      if (sym.includes('.') || sym.startsWith('^')) return null; // already has suffix or is index
      const nsSym = sym + '.NS';
      console.log(`Auto-retrying ${sym} → ${nsSym}`);
      try {
        const nsResult = await Analysis.analyzeStock(nsSym, nm, sec);
        if (nsResult && !nsResult.error && nsResult.quote && nsResult.quote.price > 0) {
          // Silently update watchlist entry to correct symbol
          const idx = state.watchlist.findIndex(w => w.symbol === sym);
          if (idx !== -1) {
            state.watchlist[idx].symbol = nsSym;
            if (!state.watchlist[idx].name || state.watchlist[idx].name === sym) {
              state.watchlist[idx].name = nsResult.quote.longName || nsSym;
            }
            saveWatchlist();
          }
          state.results.delete(sym);
          state.results.set(nsSym, nsResult);
          return nsResult;
        }
      } catch (retryErr) {
        console.warn(`Retry ${nsSym} failed:`, retryErr.message);
      }
      return null;
    };

    try {
      let result = await Analysis.analyzeStock(symbol, name, sector);
      // Also check for zero price on success (ZOMATO.NS-style redirects)
      if (result && result.quote && result.quote.price === 0 && !symbol.includes('.') && !symbol.startsWith('^')) {
        const retried = await retryWithNS(symbol, name, sector);
        if (retried) {
          state.loading.delete(symbol);
          updateWatchlistUI();
          updateRecommendations();
          return retried;
        }
      }
      state.results.set(symbol, result);
    } catch (e) {
      console.warn(`Analysis failed for ${symbol}:`, e.message);
      // For bare Indian tickers (no suffix) — try .NS BEFORE giving up
      if (!symbol.includes('.') && !symbol.startsWith('^')) {
        const retried = await retryWithNS(symbol, name, sector);
        if (retried) {
          state.loading.delete(symbol);
          updateWatchlistUI();
          updateRecommendations();
          return retried;
        }
      }
      // All attempts failed — store error sentinel so UI doesn't show infinite skeleton
      state.results.set(symbol, {
        symbol, name: name || symbol, sector: sector || 'N/A',
        error: true, errorMessage: e.message,
        quote: { symbol, price: 0, change: 0, changePct: 0 },
        scores: { composite: { total: 0, rating: 'Error' }, checklist: [] },
        tradeSetup: {}
      });
    } finally {
      state.loading.delete(symbol);
    }
    updateWatchlistUI();
    updateRecommendations();
    return state.results.get(symbol);
  }

  // ── Add stock to watchlist
  async function addStock(symbol, name, sector) {
    symbol = symbol.toUpperCase();
    if (state.watchlist.find(w => w.symbol === symbol)) {
      UI.toast(`${symbol} is already in watchlist`, 'info');
      document.getElementById('search-dropdown')?.classList.remove('show');
      const inp = document.getElementById('search-input');
      if (inp) inp.value = '';
      return;
    }
    // For Indian stocks without suffix, try adding .NS
    if (!symbol.includes('.') && !symbol.startsWith('^')) {
      // Check if it looks like Indian stock name
    }
    state.watchlist.push({ symbol, name: name || symbol, sector: sector || 'N/A' });
    saveWatchlist();
    document.getElementById('search-dropdown')?.classList.remove('show');
    const inp = document.getElementById('search-input');
    if (inp) inp.value = '';
    UI.toast(`Added ${symbol} to watchlist`, 'success');
    updateWatchlistUI();
    await analyzeAndStore(symbol, name || symbol, sector || 'N/A');
    updateRecommendations();
  }

  // ── Remove stock from watchlist
  function removeStock(symbol) {
    state.watchlist = state.watchlist.filter(w => w.symbol !== symbol);
    state.results.delete(symbol);
    saveWatchlist();
    if (state.activeSymbol === symbol) {
      state.activeSymbol = null;
      document.getElementById('detail-panel')?.classList.remove('show');
    }
    updateWatchlistUI();
    updateRecommendations();
    UI.toast(`Removed ${symbol}`, 'info');
  }

  // ── Select stock to show in detail panel
  async function selectStock(symbol) {
    state.activeSymbol = symbol;
    updateWatchlistUI();

    // Show detail panel
    const panel = document.getElementById('detail-panel');
    if (panel) {
      panel.classList.add('show');
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Show loading overlay
    UI.setDetailLoading(true);

    let result = state.results.get(symbol);
    if (!result) {
      const wl = state.watchlist.find(w => w.symbol === symbol);
      result = await analyzeAndStore(symbol, wl?.name, wl?.sector);
    }

    UI.setDetailLoading(false);

    if (!result) {
      UI.toast('Failed to load data for ' + symbol, 'error');
      return;
    }

    // Render all sections
    UI.renderDetailHeader(result);
    switchTab(state.activeTab || 'overview', result);
  }

  // ── Switch tab
  function switchTab(tabId, result) {
    state.activeTab = tabId;

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-content').forEach(tc => {
      tc.classList.toggle('active', tc.id === 'tab-' + tabId);
    });

    const r = result || state.results.get(state.activeSymbol);
    if (!r) return;

    switch (tabId) {
      case 'overview':      UI.renderOverview(r); break;
      case 'live-chart':    UI.renderLiveChart(r); break;
      case 'fundamental':   UI.renderFundamentals(r); break;
      case 'technical':     UI.renderTechnicals(r); break;
      case 'sentiment':     UI.renderSentiment(r); break;
      case 'institutional': UI.renderInstitutional(r); break;
    }
  }

  // ── Update watchlist sidebar
  function updateWatchlistUI() {
    const container = document.getElementById('watchlist-items');
    if (!container) return;

    if (state.watchlist.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="es-icon">🔍</div>
          <div class="es-title">No stocks yet</div>
          <div class="es-desc">Search and add stocks above</div>
        </div>`;
      return;
    }

    container.innerHTML = state.watchlist.map(({ symbol, name, sector }) => {
      const result = state.results.get(symbol);
      const isLoading = state.loading.has(symbol);
      if (!result && isLoading) {
        // Loading skeleton — only shown while actively loading
        return `
          <div class="watchlist-item" data-symbol="${symbol}">
            <div class="wi-avatar">${symbol.replace('.NS','').replace('.BO','').slice(0,3)}</div>
            <div class="wi-info">
              <div class="wi-symbol">${symbol.replace('.NS','').replace('.BO','')}</div>
              <div class="skeleton skel-line w-60" style="height:10px;margin-top:4px"></div>
              <div class="wi-score-bar" style="margin-top:8px">
                <div class="wi-score-fill skeleton" style="width:60%;background:none"></div>
              </div>
            </div>
            <div>
              <div class="skeleton skel-line" style="width:60px;height:16px"></div>
              <div class="skeleton skel-line" style="width:40px;height:10px;margin-top:4px"></div>
            </div>
          </div>`;
      }
      if (!result) {
        // Not loading and no result = never started (shouldn't happen) — show minimal placeholder
        return `
          <div class="watchlist-item" data-symbol="${symbol}">
            <div class="wi-avatar" style="background:var(--danger-light,#7f1d1d)">${symbol.replace('.NS','').replace('.BO','').slice(0,3)}</div>
            <div class="wi-info">
              <div class="wi-symbol">${symbol.replace('.NS','').replace('.BO','')}</div>
              <div style="font-size:10px;color:var(--text-muted)">Tap to load</div>
            </div>
          </div>`;
      }
      if (result.error) {
        // Failed to load — show error state with remove option
        const shortSym = symbol.replace('.NS','').replace('.BO','');
        return `
          <div class="watchlist-item error-state" data-symbol="${symbol}" style="opacity:0.7">
            <div class="wi-avatar" style="background:#7f1d1d;font-size:10px">⚠️</div>
            <div class="wi-info">
              <div class="wi-symbol" style="color:var(--danger,#ef4444)">${shortSym}</div>
              <div style="font-size:10px;color:var(--text-muted)">Invalid ticker — <a href="#" onclick="App.removeStock('${symbol}');return false;" style="color:#f87171">Remove</a></div>
            </div>
          </div>`;
      }
      return UI.renderWatchlistItem(result, result.symbol === state.activeSymbol);
    }).join('');
  }

  // ── Update recommendations grid
  function updateRecommendations() {
    const container = document.getElementById('recommendations-grid');
    if (!container) return;

    // Include all results except error states
    const validResults = Array.from(state.results.values()).filter(r => !r.error && r.scores && r.scores.composite);
    const loadingCount = state.loading.size;
    
    if (validResults.length === 0 && loadingCount > 0) {
      // Still loading, show skeleton cards matching watchlist count
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="es-icon">📊</div>
          <div class="es-title">Analysing stocks...</div>
          <div class="es-desc">Fetching live market data for ${loadingCount} stock${loadingCount !== 1 ? 's' : ''}...</div>
        </div>`;
      return;
    }
    
    if (validResults.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="es-icon">🔍</div>
          <div class="es-title">No data available</div>
          <div class="es-desc">Add stocks to your watchlist to see recommendations</div>
        </div>`;
      return;
    }

    // Sort by composite score descending (show partial results while others still load)
    const sorted = validResults.sort((a, b) => b.scores.composite.total - a.scores.composite.total);
    let html = sorted.map(r => UI.renderRecCard(r)).join('');
    
    // Append loading placeholder cards for any still-loading stocks
    if (loadingCount > 0) {
      html += Array(loadingCount).fill(0).map(() => `
        <div class="rec-card skeleton-card" style="background:var(--card-bg);border-radius:16px;padding:24px;min-height:200px;opacity:0.5">
          <div class="skeleton" style="height:20px;width:60%;border-radius:6px;margin-bottom:12px"></div>
          <div class="skeleton" style="height:14px;width:80%;border-radius:6px;margin-bottom:8px"></div>
          <div class="skeleton" style="height:14px;width:50%;border-radius:6px"></div>
        </div>`).join('');
    }
    
    container.innerHTML = html;
  }

  // ── Watchlist skeleton on init
  function showWatchlistSkeleton() {
    const container = document.getElementById('watchlist-items');
    if (!container) return;
    container.innerHTML = Array(5).fill(0).map(() => `
      <div class="watchlist-item">
        <div class="wi-avatar skeleton"></div>
        <div class="wi-info">
          <div class="skeleton skel-line w-80" style="height:13px"></div>
          <div class="skeleton skel-line w-60" style="height:10px;margin-top:4px"></div>
          <div class="wi-score-bar" style="margin-top:8px">
            <div class="skeleton" style="height:3px;width:70%;border-radius:3px"></div>
          </div>
        </div>
        <div>
          <div class="skeleton skel-line" style="width:60px;height:16px"></div>
          <div class="skeleton skel-line" style="width:40px;height:10px;margin-top:4px"></div>
        </div>
      </div>`).join('');
  }

  // ── Invy Chat Handlers
  let chatHistory = [];

  async function handleInvySend() {
    const inputEl = document.getElementById('invy-chat-input');
    if (!inputEl) return;
    
    const msg = inputEl.value.trim();
    if (!msg) return;

    // Clear input
    inputEl.value = '';

    // Render user message in UI
    UI.renderInvyMessage('user', msg);

    // Render typing status / loader
    const messagesContainer = document.getElementById('invy-chat-messages');
    if (!messagesContainer) return;
    
    const typingIndicator = document.createElement('div');
    typingIndicator.className = 'invy-message assistant typing-indicator-msg';
    typingIndicator.innerHTML = `
      <div class="msg-sender">Invy AI</div>
      <div class="msg-text" style="color:var(--text-muted)">Invy is analyzing market data...</div>
    `;
    messagesContainer.appendChild(typingIndicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // Get active stock context if user is querying about a stock or if one is active
    let currentStockContext = null;
    if (state.activeSymbol) {
      const activeResult = state.results.get(state.activeSymbol);
      if (activeResult) {
        currentStockContext = activeResult;
      }
    }

    try {
      // Call sendInvyChatMessage
      const response = await API.sendInvyChatMessage(chatHistory, msg, currentStockContext);
      
      // Remove typing indicator
      typingIndicator.remove();

      // Render Invy response in UI
      UI.renderInvyMessage('assistant', response);

      // Append to local history
      chatHistory.push({
        role: 'user',
        parts: [{ text: msg }]
      });
      chatHistory.push({
        role: 'model',
        parts: [{ text: response }]
      });

      // Cap history to 6 messages (3 turns)
      if (chatHistory.length > 6) {
        chatHistory = chatHistory.slice(chatHistory.length - 6);
      }
    } catch (error) {
      typingIndicator.remove();
      UI.renderInvyMessage('assistant', `⚠️ **Error:** ${error.message}`);
      UI.toast(error.message, 'error');
    }
  }

  // Expose public API
  return { init, addStock, removeStock, selectStock, switchTab };
})();

window.App = App;

// ── Boot on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  App.init().catch(console.error);

  // ── Auto-refresh: refresh market data every 5 minutes and watchlist quotes every 3 minutes
  setInterval(() => {
    // Silently refresh market indices + Fear/Greed in background
    if (typeof App !== 'undefined') {
      API.checkBackend().then(backendActive => {
        if (backendActive) {
          API.fetchMarketPulseFromBackend().then(pulse => {
            if (pulse) {
              if (pulse.indices) UI.renderMarketTickers(pulse.indices);
              if (pulse.fearGreed) UI.renderFearGreed(pulse.fearGreed);
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  }, 5 * 60 * 1000); // every 5 minutes

  // Update the last-updated clock every minute
  const updateClock = () => {
    const el = document.getElementById('last-updated-time');
    if (el) {
      const now = new Date();
      el.textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    }
  };
  updateClock();
  setInterval(updateClock, 60 * 1000);
});
