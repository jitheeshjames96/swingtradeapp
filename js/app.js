/* ============================================================
   APP.JS — Main Application Controller
   ============================================================ */

const App = (() => {  // ── State
  const state = {
    marketMode: localStorage.getItem('stid_market_mode') || 'IN',
    watchlist: [],          // Array of { symbol, name, sector }
    results: new Map(),     // symbol → full analysis result
    catalogResults: new Map(), // symbol → analysis result for catalog scan
    activeSymbol: null,
    activeTab: 'overview',
    loading: new Set(),
    fearGreed: null,
    sectors: [],
    indices: [],
    marketSummary: null,    // { gainers, losers, sectors }
    recFilter: 'all',       // Selected recommendations filter: 'all', 'strong-buy', 'buy', 'watch', 'avoid'
    catalogScanInProgress: false, // True while fetching all catalog stocks
    catalogScanProgress: 0, // Number of catalog stocks analyzed so far
    isAuthenticated: false,
    pendingSelectSymbol: null,
    pendingAction: null,
    capFilter: 'all',
  };

  function updateAuthButtons() {
    const btnLogin = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogin && btnLogout) {
      if (state.isAuthenticated) {
        btnLogin.style.display = 'none';
        btnLogout.style.display = 'inline-block';
        if (localStorage.getItem('google_sso_token') === 'DEMO_BYPASS') {
          btnLogout.textContent = 'Exit Demo Mode';
        } else {
          btnLogout.textContent = '🚪 Sign Out';
        }
      } else {
        btnLogin.style.display = 'inline-block';
        btnLogout.style.display = 'none';
      }
    }
  }


  const DEFAULT_WATCHLIST_IN = [
    { symbol: 'RELIANCE.NS',  name: 'Reliance Industries',      sector: 'Energy' },
    { symbol: 'TCS.NS',       name: 'Tata Consultancy Services', sector: 'IT' },
    { symbol: 'HDFCBANK.NS',  name: 'HDFC Bank',                sector: 'Banking' },
    { symbol: 'INFY.NS',      name: 'Infosys Ltd',              sector: 'IT' },
    { symbol: 'BAJAJFINSV.NS',name: 'Bajaj Finserv',            sector: 'NBFC' },
    { symbol: 'ETERNAL.NS',   name: 'Eternal Limited (Zomato)', sector: 'Consumer' },
  ];

  const DEFAULT_WATCHLIST_US = [
    { symbol: 'AAPL',         name: 'Apple Inc.',               sector: 'Technology' },
    { symbol: 'MSFT',         name: 'Microsoft Corp.',          sector: 'Technology' },
    { symbol: 'GOOGL',        name: 'Alphabet Inc.',            sector: 'Technology' },
    { symbol: 'AMZN',         name: 'Amazon.com Inc.',          sector: 'Consumer' },
    { symbol: 'TSLA',         name: 'Tesla Inc.',               sector: 'Auto' },
    { symbol: 'NVDA',         name: 'NVIDIA Corp.',             sector: 'Technology' },
  ];

  // Indian NSE stock suffixes — bare tickers we auto-fix to .NS
  // Note: TATAMOTORS.NS not included — Yahoo Finance dropped it post-demerger
  const KNOWN_INDIAN_BASES = new Set([
    'RELIANCE','TCS','INFY','HDFCBANK','ICICIBANK','WIPRO',
    'ADANIENT','BAJFINANCE','SBIN','SUNPHARMA','HINDUNILVR','AXISBANK','MARUTI',
    'ETERNAL','BAJAJFINSV','KOTAKBANK','LT','ASIANPAINT','HCLTECH','ULTRACEMCO',
    'POWERGRID','NTPC','NESTLEIND','TITAN','TATAPOWER','DRREDDY','CIPLA',
    'ONGC','COALINDIA','TECHM','DIVISLAB','BPCL','GRASIM','HEROMOTOCO','JSWSTEEL',
    'HINDALCO','BRITANNIA','EICHERMOT','APOLLOHOSP','INDUSINDBK',
    'TRENT','SIEMENS','HAVELLS','PIDILITIND','VOLTAS','BHARTIARTL',
  ]);

  const WATCHLIST_VERSION = 4; // v4: removed TATAMOTORS.NS (Yahoo Finance dropped it post-demerger)

  // ── LocalStorage helpers
  function saveWatchlist() {
    try {
      const key = `stid_watchlist_${state.marketMode}`;
      const verKey = `stid_watchlist_version_${state.marketMode}`;
      localStorage.setItem(key, JSON.stringify(state.watchlist));
      localStorage.setItem(verKey, String(WATCHLIST_VERSION));
    } catch(e) {}
  }
  function loadWatchlist() {
    try {
      // Legacy watchlist migration:
      const legacySaved = localStorage.getItem('stid_watchlist');
      if (legacySaved) {
        localStorage.setItem('stid_watchlist_IN', legacySaved);
        const legacyVer = localStorage.getItem('stid_watchlist_version');
        if (legacyVer) localStorage.setItem('stid_watchlist_version_IN', legacyVer);
        localStorage.removeItem('stid_watchlist');
        localStorage.removeItem('stid_watchlist_version');
        console.log('Migrating legacy watchlist to stid_watchlist_IN');
      }

      const key = `stid_watchlist_${state.marketMode}`;
      const verKey = `stid_watchlist_version_${state.marketMode}`;
      const version = parseInt(localStorage.getItem(verKey) || '0');
      const saved = localStorage.getItem(key);
      
      if (saved && version >= WATCHLIST_VERSION) {
        const parsed = JSON.parse(saved);
        if (state.marketMode === 'IN') {
          return parsed.map(item => {
            let sym = (item.symbol || '').trim().toUpperCase();
            if (!sym.includes('.') && !sym.startsWith('^')) {
              if (KNOWN_INDIAN_BASES.has(sym)) {
                sym = sym + '.NS';
              }
            }
            return { ...item, symbol: sym };
          });
        }
        return parsed;
      } else if (saved && version < WATCHLIST_VERSION) {
        console.log('Migrating watchlist from version', version, 'to', WATCHLIST_VERSION);
        const parsed = JSON.parse(saved);
        const migrated = parsed.map(item => {
          let sym = (item.symbol || '').trim().toUpperCase();
          if (state.marketMode === 'IN' && !sym.includes('.') && !sym.startsWith('^')) {
            sym = sym + '.NS';
          }
          return { ...item, symbol: sym };
        });
        try {
          localStorage.setItem(key, JSON.stringify(migrated));
          localStorage.setItem(verKey, String(WATCHLIST_VERSION));
        } catch(e) {}
        return migrated;
      }
    } catch(e) {}
    return state.marketMode === 'US' ? DEFAULT_WATCHLIST_US : DEFAULT_WATCHLIST_IN;
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
      const res = await API.fetchWithTimeout(`${backendUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${credential}`
        },
        timeout: 5000
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'You are not authorized to access this app.');
      }
      
      // Hide overlay
      const overlay = document.getElementById('login-overlay');
      if (overlay) overlay.style.display = 'none';
      
      state.isAuthenticated = true; // Set authenticated!
      updateAuthButtons();
      
      UI.toast('Signed in successfully!', 'success');
      
      // Reload watchlist with full authenticated analysis
      await loadAllWatchlistStocks();
      
      // Resume pending action if present
      if (state.pendingSelectSymbol) {
        const sym = state.pendingSelectSymbol;
        state.pendingSelectSymbol = null;
        await selectStock(sym);
      } else if (state.pendingAction === 'showPerformance') {
        state.pendingAction = null;
        const btnPicks = document.getElementById('btn-show-picks');
        const btnPerf = document.getElementById('btn-show-performance');
        const picksSect = document.getElementById('picks-section-container');
        const perfSect = document.getElementById('performance-section-container');
        if (btnPicks && btnPerf && picksSect && perfSect) {
          btnPicks.classList.remove('active');
          btnPerf.classList.add('active');
          picksSect.style.display = 'none';
          perfSect.style.display = 'block';
        }
        UI.renderPerformanceDashboard();
      } else if (state.watchlist.length > 0) {
        selectStock(state.watchlist[0].symbol);
      }
      
    } catch (err) {
      localStorage.removeItem('google_sso_token');
      state.isAuthenticated = false;
      if (errorMsgEl) {
        errorMsgEl.innerText = `Sign-in failed: ${err.message}`;
        errorMsgEl.style.display = 'block';
      }
      UI.toast(err.message, 'error');
    }
  }

  async function finishInit() {
    updateAuthButtons();
    showWatchlistSkeleton();
    await loadMarketData();
    await loadAllWatchlistStocks();
    if (state.isAuthenticated && state.watchlist.length > 0) {
      selectStock(state.watchlist[0].symbol);
    }
  }

  async function setMarketMode(mode) {
    if (state.marketMode === mode) return;
    state.marketMode = mode;
    localStorage.setItem('stid_market_mode', mode);
    
    API.setMarketMode(mode);
    
    // Update button visual states
    const btnIn = document.getElementById('btn-market-in');
    const btnUs = document.getElementById('btn-market-us');
    if (btnIn) btnIn.classList.toggle('active', mode === 'IN');
    if (btnUs) btnUs.classList.toggle('active', mode === 'US');
    
    // Reset state & detail panel
    state.results.clear();
    state.catalogResults.clear();
    state.activeSymbol = null;
    const detailPanel = document.getElementById('detail-panel');
    if (detailPanel) detailPanel.classList.remove('show');
    
    // Load new watchlist
    state.watchlist = loadWatchlist();
    
    UI.toast(`Switched to ${mode === 'US' ? 'US Stocks' : 'Indian Stocks'}`, 'success');
    
    await finishInit();
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
          const res = await API.fetchWithTimeout(`${backendUrl}/api/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`
            },
            timeout: 5000
          });
          
          if (!res.ok) {
            throw new Error('Token expired or invalid');
          }
          
          // Token is valid!
          state.isAuthenticated = true;
          const btnLogout = document.getElementById('btn-logout');
          if (btnLogout) btnLogout.style.display = 'inline-block';
          
          await finishInit();
        } catch (e) {
          console.warn('Session verification failed, requesting re-login:', e.message);
          localStorage.removeItem('google_sso_token');
          state.isAuthenticated = false;
          await finishInit();
        }
      } else {
        // No token, start in preview/guest mode
        state.isAuthenticated = false;
        await finishInit();
      }
    } else {
      // SSO not configured, standard boot
      state.isAuthenticated = true;
      await finishInit();
    }
  }

  // ── Event Bindings
  function bindEvents() {
    // Market Switcher buttons
    const btnIn = document.getElementById('btn-market-in');
    const btnUs = document.getElementById('btn-market-us');
    if (btnIn) {
      btnIn.classList.toggle('active', state.marketMode === 'IN');
      btnIn.addEventListener('click', () => setMarketMode('IN'));
    }
    if (btnUs) {
      btnUs.classList.toggle('active', state.marketMode === 'US');
      btnUs.addEventListener('click', () => setMarketMode('US'));
    }

    // Search input
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.addEventListener('focus', () => {
        if (!state.isAuthenticated) {
          searchInput.blur();
          document.getElementById('login-overlay').style.display = 'flex';
        }
      });

      let debounceTimer;
      searchInput.addEventListener('input', e => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const q = e.target.value.trim();
          if (q.length > 0) {
            try {
              const results = await API.searchStocks(q);
              UI.renderSearchResults(results);
            } catch (err) {
              console.error('Failed to search stocks:', err);
            }
          } else {
            document.getElementById('search-dropdown')?.classList.remove('show');
          }
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
        const dd = document.getElementById('settings-dropdown');
        if (dd) dd.style.display = 'none';
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
        localStorage.removeItem(`stid_watchlist_${state.marketMode}`);
        localStorage.removeItem(`stid_watchlist_version_${state.marketMode}`);
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
        if (!state.isAuthenticated) {
          document.getElementById('login-overlay').style.display = 'flex';
          return;
        }
        invyChatDrawer.classList.add('show');
        invyChatDrawer.setAttribute('aria-hidden', 'false');
        document.body.classList.add('chat-open');
        document.getElementById('invy-chat-input')?.focus();
      });
    }

    if (invyChatClose && invyChatDrawer) {
      invyChatClose.addEventListener('click', () => {
        invyChatDrawer.classList.remove('show');
        invyChatDrawer.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('chat-open');
      });
    }

    // Google SSO Login Close Button
    const loginClose = document.getElementById('login-close');
    if (loginClose) {
      loginClose.addEventListener('click', () => {
        document.getElementById('login-overlay').style.display = 'none';
        state.pendingSelectSymbol = null;
        state.pendingAction = null;
      });
    }

    // Toggle Picks and Performance Report
    const btnShowPicks = document.getElementById('btn-show-picks');
    const btnShowPerformance = document.getElementById('btn-show-performance');
    const picksSection = document.getElementById('picks-section-container');
    const performanceSection = document.getElementById('performance-section-container');

    if (btnShowPicks && btnShowPerformance && picksSection && performanceSection) {
      btnShowPicks.addEventListener('click', () => {
        btnShowPicks.classList.add('active');
        btnShowPerformance.classList.remove('active');
        picksSection.style.display = 'block';
        performanceSection.style.display = 'none';
      });

      btnShowPerformance.addEventListener('click', () => {
        if (!state.isAuthenticated) {
          state.pendingAction = 'showPerformance';
          document.getElementById('login-overlay').style.display = 'flex';
          return;
        }
        btnShowPicks.classList.remove('active');
        btnShowPerformance.classList.add('active');
        picksSection.style.display = 'none';
        performanceSection.style.display = 'block';
        UI.renderPerformanceDashboard();
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

    // Google SSO Sign In/Out
    const btnLogin = document.getElementById('btn-login');
    if (btnLogin) {
      btnLogin.addEventListener('click', () => {
        const overlay = document.getElementById('login-overlay');
        if (overlay) overlay.style.display = 'flex';
      });
    }

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

    // Continue in Demo Mode Bypass
    const btnBypass = document.getElementById('btn-bypass-sso');
    if (btnBypass) {
      btnBypass.addEventListener('click', async () => {
        localStorage.setItem('google_sso_token', 'DEMO_BYPASS');
        state.isAuthenticated = true;
        const overlay = document.getElementById('login-overlay');
        if (overlay) overlay.style.display = 'none';
        
        updateAuthButtons();
        
        UI.toast('Entered Demo Mode successfully!', 'success');
        
        // Reload watchlist and data
        await loadAllWatchlistStocks();
        
        // Resume pending actions
        if (state.pendingSelectSymbol) {
          const sym = state.pendingSelectSymbol;
          state.pendingSelectSymbol = null;
          await selectStock(sym);
        } else if (state.pendingAction === 'showPerformance') {
          state.pendingAction = null;
          const btnPicks = document.getElementById('btn-show-picks');
          const btnPerf = document.getElementById('btn-show-performance');
          const picksSect = document.getElementById('picks-section-container');
          const perfSect = document.getElementById('performance-section-container');
          if (btnPicks && btnPerf && picksSect && perfSect) {
            btnPicks.classList.remove('active');
            btnPerf.classList.add('active');
            picksSect.style.display = 'none';
            perfSect.style.display = 'block';
          }
          UI.renderPerformanceDashboard();
        } else if (state.watchlist.length > 0) {
          selectStock(state.watchlist[0].symbol);
        }
      });
    }

    // Capitalization Filter buttons
    document.querySelectorAll('.cap-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.cap-btn').forEach(b => {
          b.classList.remove('active');
          b.style.background = 'none';
          b.style.border = '1px solid transparent';
          b.style.color = 'var(--text-muted)';
          b.style.fontWeight = '600';
        });
        btn.classList.add('active');
        btn.style.background = 'rgba(99,102,241,0.15)';
        btn.style.border = '1px solid rgba(99,102,241,0.3)';
        btn.style.color = 'var(--text-accent)';
        btn.style.fontWeight = '700';

        state.capFilter = btn.dataset.cap;
        updateRecommendations();
      });
    });
  }

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

      // Fetch market summary (which contains sectors with leaders/laggards, gainers, losers)
      let summaryData = null;
      try {
        summaryData = await API.fetchMarketSummary();
      } catch (err) {
        console.warn('Failed to fetch market summary:', err.message);
      }

      if (summaryData && summaryData.sectors && summaryData.sectors.length > 0) {
        sectors = summaryData.sectors;
        state.marketSummary = summaryData;
      } else {
        // Fallback sectors if marketSummary failed
        sectors = await API.fetchSectorPerformance();
        state.marketSummary = null;
      }

      state.indices = indices;
      state.fearGreed = fearGreed;
      state.sectors = sectors;
      UI.renderMarketTickers(indices);
      UI.renderMarketIndicesPanel(indices);
      UI.renderFearGreed(fearGreed);
      UI.renderSectorHeatmap(sectors, state.results);
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

  // ── Background catalog scan: fetch and score all Indian catalog stocks for global top-10 picks
  async function loadCatalogScans(filterContext) {
    if (state.catalogScanInProgress) return;
    state.catalogScanInProgress = true;
    state.catalogScanProgress = 0;

    const catalog = API.STOCK_CATALOG.filter(s => s.symbol.endsWith('.NS'));
    const BATCH_SIZE = 4;

    for (let i = 0; i < catalog.length; i += BATCH_SIZE) {
      const batch = catalog.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(async ({ symbol, name, sector }) => {
        if (state.catalogResults.has(symbol)) return; // already scanned
        try {
          const result = await Analysis.analyzeStock(symbol, name, sector);
          if (result && !result.error && result.scores && result.quote && result.quote.price > 0) {
            state.catalogResults.set(symbol, result);
          }
        } catch (e) {
          // Silently skip failed stocks in catalog scan
        }
        state.catalogScanProgress++;
      }));

      // After each batch, refresh the UI if user is still on a filter view
      if (state.recFilter !== 'all') {
        updateRecommendations();
      }
    }

    state.catalogScanInProgress = false;
    if (state.recFilter !== 'all') {
      updateRecommendations();
    }
  }

  // ── Analyse a single stock and store
  async function analyzeAndStore(symbol, name, sector) {
    if (state.loading.has(symbol)) return;
    state.loading.add(symbol);
    updateWatchlistUI(); // Show skeleton immediately so UI doesn’t freeze on “Tap to load”
    
    if (!state.isAuthenticated) {
      try {
        const quote = await API.fetchQuote(symbol);
        state.results.set(symbol, {
          symbol,
          name: name || symbol,
          sector: sector || 'N/A',
          quote: quote || { price: 0, change: 0, changePct: 0 },
          scores: { composite: { total: 0, rating: 'Lock' } },
          tradeSetup: {}
        });
      } catch (err) {
        state.results.set(symbol, {
          symbol, name: name || symbol, sector: sector || 'N/A',
          error: true, errorMessage: err.message,
          quote: { symbol, price: 0, change: 0, changePct: 0 },
          scores: { composite: { total: 0, rating: 'Error' } },
          tradeSetup: {}
        });
      } finally {
        state.loading.delete(symbol);
      }
      updateWatchlistUI();
      updateRecommendations();
      return state.results.get(symbol);
    }
    
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
    if (!state.isAuthenticated) {
      document.getElementById('login-overlay').style.display = 'flex';
      return;
    }
    symbol = symbol.toUpperCase().trim();
    if (state.marketMode === 'IN' && !symbol.includes('.') && !symbol.startsWith('^')) {
      symbol = symbol + '.NS';
    }
    if (state.watchlist.find(w => w.symbol === symbol)) {
      UI.toast(`${symbol} is already in watchlist`, 'info');
      document.getElementById('search-dropdown')?.classList.remove('show');
      const inp = document.getElementById('search-input');
      if (inp) inp.value = '';
      return;
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
    if (!state.isAuthenticated) {
      state.pendingSelectSymbol = symbol;
      document.getElementById('login-overlay').style.display = 'flex';
      return;
    }
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
      let wl = state.watchlist.find(w => w.symbol === symbol);
      if (!wl && window.API && window.API.STOCK_CATALOG) {
        wl = window.API.STOCK_CATALOG.find(w => w.symbol === symbol);
      }
      result = await analyzeAndStore(symbol, wl?.name || symbol, wl?.sector || 'N/A');
    }

    UI.setDetailLoading(false);

    if (!result) {
      UI.toast('Failed to load data for ' + symbol, 'error');
      return;
    }

    // Render all sections
    UI.renderDetailHeader(result);
    
    // Show chart container and render chart
    const chartContainer = document.getElementById('detail-live-chart-container');
    if (chartContainer) {
      chartContainer.style.display = 'block';
    }
    UI.renderLiveChart(result);

    if (state.activeTab === 'live-chart') {
      state.activeTab = 'overview';
    }
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

    const activeFilter = state.recFilter || 'all';

    // Include all results except error states, restricted to watchlist stocks
    const watchlistSymbols = new Set(state.watchlist.map(w => w.symbol));
    const validResults = Array.from(state.results.values()).filter(r => !r.error && r.scores && r.scores.composite && watchlistSymbols.has(r.symbol));
    const loadingCount = state.loading.size;
    
    // Render rankings
    const gainersList = document.getElementById('top-gainers-list');
    const losersList = document.getElementById('top-losers-list');
    if (gainersList && losersList) {
      let summaryGainers = state.marketSummary?.gainers;
      let summaryLosers = state.marketSummary?.losers;

      if (state.capFilter && state.capFilter !== 'all' && state.marketSummary?.allQuotes) {
        const filtered = state.marketSummary.allQuotes.filter(q => q.cap === state.capFilter);
        summaryGainers = [...filtered]
          .filter(q => typeof q.changePct === 'number' && q.changePct > 0)
          .sort((a, b) => b.changePct - a.changePct)
          .slice(0, 5)
          .map(q => ({
            symbol: q.symbol,
            name: q.name,
            quote: { price: q.price, change: q.change, changePct: q.changePct }
          }));

        summaryLosers = [...filtered]
          .filter(q => typeof q.changePct === 'number' && q.changePct < 0)
          .sort((a, b) => a.changePct - b.changePct)
          .slice(0, 5)
          .map(q => ({
            symbol: q.symbol,
            name: q.name,
            quote: { price: q.price, change: q.change, changePct: q.changePct }
          }));
      }

      if (summaryGainers && summaryLosers && (summaryGainers.length > 0 || summaryLosers.length > 0)) {
        gainersList.innerHTML = summaryGainers.map(r => {
          const sym = r.symbol.replace('.NS', '').replace('.BO', '');
          const val = r.quote?.changePct ?? 0;
          return `
            <div class="ranking-item" onclick="App.selectStock('${r.symbol}')" style="cursor:pointer">
              <span class="ranking-symbol">${sym}</span>
              <span class="ranking-name" title="${r.name}">${r.name}</span>
              <span class="ranking-pct positive">+${val.toFixed(2)}%</span>
            </div>
          `;
        }).join('');

        losersList.innerHTML = summaryLosers.map(r => {
          const sym = r.symbol.replace('.NS', '').replace('.BO', '');
          const val = r.quote?.changePct ?? 0;
          const sign = val >= 0 ? '+' : '';
          return `
            <div class="ranking-item" onclick="App.selectStock('${r.symbol}')" style="cursor:pointer">
              <span class="ranking-symbol">${sym}</span>
              <span class="ranking-name" title="${r.name}">${r.name}</span>
              <span class="ranking-pct negative">${sign}${val.toFixed(2)}%</span>
            </div>
          `;
        }).join('');
      } else if (validResults.length === 0) {
        gainersList.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:6px 0">Waiting for data...</div>`;
        losersList.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:6px 0">Waiting for data...</div>`;
      } else {
        // Fallback to active watchlist if summary is empty
        let fallbackQuotes = [...validResults];
        if (state.capFilter && state.capFilter !== 'all') {
          fallbackQuotes = fallbackQuotes.filter(q => q.cap === state.capFilter);
        }

        const fallbackGainers = [...fallbackQuotes]
          .filter(q => (q.quote?.changePct || 0) > 0)
          .sort((a, b) => (b.quote?.changePct || 0) - (a.quote?.changePct || 0))
          .slice(0, 5);
        const fallbackLosers = [...fallbackQuotes]
          .filter(q => (q.quote?.changePct || 0) < 0)
          .sort((a, b) => (a.quote?.changePct || 0) - (b.quote?.changePct || 0))
          .slice(0, 5);

        if (fallbackGainers.length === 0) {
          gainersList.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:6px 0">No gainers found</div>`;
        } else {
          gainersList.innerHTML = fallbackGainers.map(r => {
            const sym = r.symbol.replace('.NS', '').replace('.BO', '');
            const val = r.quote?.changePct ?? 0;
            return `
              <div class="ranking-item" onclick="App.selectStock('${r.symbol}')" style="cursor:pointer">
                <span class="ranking-symbol">${sym}</span>
                <span class="ranking-name" title="${r.name}">${r.name}</span>
                <span class="ranking-pct positive">+${val.toFixed(2)}%</span>
              </div>
            `;
          }).join('');
        }

        if (fallbackLosers.length === 0) {
          losersList.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:6px 0">No losers found</div>`;
        } else {
          losersList.innerHTML = fallbackLosers.map(r => {
            const sym = r.symbol.replace('.NS', '').replace('.BO', '');
            const val = r.quote?.changePct ?? 0;
            const sign = val >= 0 ? '+' : '';
            return `
              <div class="ranking-item" onclick="App.selectStock('${r.symbol}')" style="cursor:pointer">
                <span class="ranking-symbol">${sym}</span>
                <span class="ranking-name" title="${r.name}">${r.name}</span>
                <span class="ranking-pct negative">${sign}${val.toFixed(2)}%</span>
              </div>
            `;
          }).join('');
        }
      }
    }

    // Update sector heatmap dynamically
    if (state.sectors) {
      UI.renderSectorHeatmap(state.sectors, state.results);
    }
    
    // Compute Counts for Filters based on composite scores
    const countAll = validResults.length;
    const countStrongBuy = validResults.filter(r => r.scores?.composite?.total >= 80).length;
    const countBuy = validResults.filter(r => r.scores?.composite?.total >= 65 && r.scores?.composite?.total < 80).length;
    const countWatch = validResults.filter(r => r.scores?.composite?.total >= 50 && r.scores?.composite?.total < 65).length;
    const countAvoid = validResults.filter(r => r.scores?.composite?.total < 50).length;

    // Update Counts in UI
    const elAll = document.getElementById('count-all');
    const elStrongBuy = document.getElementById('count-strong-buy');
    const elBuy = document.getElementById('count-buy');
    const elWatch = document.getElementById('count-watch');
    const elAvoid = document.getElementById('count-avoid');

    if (elAll) elAll.textContent = countAll;
    if (elStrongBuy) elStrongBuy.textContent = countStrongBuy;
    if (elBuy) elBuy.textContent = countBuy;
    if (elWatch) elWatch.textContent = countWatch;
    if (elAvoid) elAvoid.textContent = countAvoid;

    // Update Active Filter Class in UI
    document.querySelectorAll('.rec-filters .filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-filter') === activeFilter);
    });

    // ── GLOBAL TOP-10 MODE (when a specific filter is selected)
    if (activeFilter !== 'all') {
      const catalogTotal = API.STOCK_CATALOG.filter(s => s.symbol.endsWith('.NS')).length;
      const scanned = state.catalogScanProgress;
      const scanDone = !state.catalogScanInProgress;

      // Get catalog results matching the current filter
      const catalogValid = Array.from(state.catalogResults.values())
        .filter(r => !r.error && r.scores && r.scores.composite && r.quote && r.quote.price > 0);

      let globalFiltered;
      if (activeFilter === 'strong-buy') {
        globalFiltered = catalogValid.filter(r => r.scores.composite.total >= 80);
      } else if (activeFilter === 'buy') {
        globalFiltered = catalogValid.filter(r => r.scores.composite.total >= 65 && r.scores.composite.total < 80);
      } else if (activeFilter === 'watch') {
        globalFiltered = catalogValid.filter(r => r.scores.composite.total >= 50 && r.scores.composite.total < 65);
      } else if (activeFilter === 'avoid') {
        globalFiltered = catalogValid.filter(r => r.scores.composite.total < 50);
      } else {
        globalFiltered = catalogValid;
      }

      // Sort by score descending, take top 10
      const top10 = [...globalFiltered]
        .sort((a, b) => b.scores.composite.total - a.scores.composite.total)
        .slice(0, 10);

      // Compute scan progress percent
      const pct = catalogTotal > 0 ? Math.round((scanned / catalogTotal) * 100) : 0;

      let filterLabelMap = {
        'strong-buy': '🟢 Strong Buy',
        'buy': '🟡 Buy',
        'watch': '🟠 Hold/Watch',
        'avoid': '🔴 Avoid/Ignore',
      };
      const filterLabel = filterLabelMap[activeFilter] || activeFilter;

      let headerHtml = `
        <div style="grid-column:1/-1; margin-bottom:12px; padding:12px 16px; background:rgba(255,255,255,0.04); border-radius:10px; border:1px solid rgba(255,255,255,0.08);">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <div>
              <div style="font-size:0.85rem; font-weight:700; color:var(--text-primary);">🌐 Global Market Scan — ${filterLabel}</div>
              <div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px;">Scanning ${catalogTotal} Indian NSE stocks · Top 10 picks by score</div>
            </div>
            ${!scanDone ? `
              <div style="display:flex;align-items:center;gap:8px;">
                <div class="spinner" style="width:14px;height:14px;border-width:2px;"></div>
                <span style="font-size:0.72rem;color:var(--text-muted);">Scanning ${scanned}/${catalogTotal} (${pct}%)</span>
              </div>
            ` : `
              <div style="font-size:0.72rem;color:#22c55e;font-weight:600;">✅ Scan Complete — ${catalogValid.length} stocks analyzed</div>
            `}
          </div>
          ${!scanDone ? `
            <div style="height:3px; background:rgba(255,255,255,0.08); border-radius:3px; margin-top:8px; overflow:hidden;">
              <div style="height:100%; width:${pct}%; background:linear-gradient(90deg,#10b981,#22c55e); border-radius:3px; transition:width 0.5s;"></div>
            </div>
          ` : ''}
        </div>
      `;

      if (top10.length === 0) {
        let scanningMsg = !scanDone
          ? `<div style="font-size:0.85rem; color:var(--text-muted); margin-top:4px;">Scanning catalog... (${scanned}/${catalogTotal})</div>`
          : `<div style="font-size:0.85rem; color:var(--text-muted); margin-top:4px;">No stocks found in this category from the full catalog scan.</div>`;
        container.innerHTML = headerHtml + `
          <div class="rec-empty-state" style="grid-column: 1 / -1;">
            <div class="empty-icon">🔍</div>
            <div class="empty-title" style="font-weight:600;">Scanning All Indian Stocks...</div>
            ${scanningMsg}
          </div>
        `;
      } else {
        container.innerHTML = headerHtml + top10.map(r => UI.renderRecCard(r)).join('');
      }
      return;
    }

    // ── WATCHLIST MODE (activeFilter === 'all')
    if (validResults.length === 0 && loadingCount > 0) {
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

    // Sort by composite score descending
    const sorted = [...validResults].sort((a, b) => b.scores.composite.total - a.scores.composite.total);
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
    if (!state.isAuthenticated) {
      document.getElementById('login-overlay').style.display = 'flex';
      return;
    }
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

    // Get active stock context. Automatically scan input msg for stock ticker or company name references
    let currentStockContext = null;
    let matchedSymbol = null;
    const msgLower = msg.toLowerCase();

    // 1. Scan catalog for symbol/name matches
    if (API.STOCK_CATALOG) {
      for (const stock of API.STOCK_CATALOG) {
        const cleanSymbol = stock.symbol.replace('.NS', '').replace('.BO', '').toLowerCase();
        const companyName = stock.name.toLowerCase();
        const symPattern = new RegExp('\\b' + cleanSymbol + '\\b', 'i');
        
        if (symPattern.test(msgLower) || msgLower.includes(companyName)) {
          matchedSymbol = stock.symbol;
          break;
        }
      }
    }

    // 2. If a catalog symbol matched, use its result if analyzed, or fetch on-the-fly
    if (matchedSymbol) {
      if (state.results.has(matchedSymbol)) {
        currentStockContext = state.results.get(matchedSymbol);
      } else if (state.catalogResults.has(matchedSymbol)) {
        // Use cached catalog scan result (avoids redundant fetch)
        currentStockContext = state.catalogResults.get(matchedSymbol);
      } else {
        const catalogItem = API.STOCK_CATALOG.find(s => s.symbol === matchedSymbol);
        const stockName = catalogItem?.name || matchedSymbol;
        
        // Update typing indicator text to show dynamic loading state
        const textEl = typingIndicator.querySelector('.msg-text');
        if (textEl) {
          textEl.textContent = `Invy is fetching and analyzing ${stockName} data...`;
        }

        try {
          // Perform dynamic analysis fetch
          currentStockContext = await analyzeAndStore(matchedSymbol, stockName, catalogItem?.sector || 'N/A');
        } catch (err) {
          console.warn(`Dynamic chat analysis fetch failed for ${matchedSymbol}:`, err.message);
          currentStockContext = {
            symbol: matchedSymbol,
            name: stockName,
            sector: catalogItem?.sector || '',
            quote: { price: 0, change: 0, changePct: 0 },
            scores: { composite: { total: 0 } }
          };
        }
      }
    } else {
      // 3. Fallback to active tab
      if (state.activeSymbol) {
        const activeResult = state.results.get(state.activeSymbol);
        if (activeResult) {
          currentStockContext = activeResult;
        }
      }
    }

    try {
      // Call sendInvyChatMessage
      const response = await API.sendInvyChatMessage(chatHistory, msg, currentStockContext, state.marketSummary);
      
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
    }
  }

  function setRecFilter(filterValue) {
    state.recFilter = filterValue;
    updateRecommendations();
    // If a rating-specific filter is selected, trigger the global catalog scan
    if (filterValue !== 'all') {
      loadCatalogScans(filterValue);
    }
  }

  // Expose public API
  return { init, addStock, removeStock, selectStock, switchTab, setRecFilter, setMarketMode };
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
              if (pulse.indices) {
                UI.renderMarketTickers(pulse.indices);
                UI.renderMarketIndicesPanel(pulse.indices);
              }
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
