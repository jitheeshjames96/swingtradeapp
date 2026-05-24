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
    drawerActiveSymbol: null,
    alerts: JSON.parse(localStorage.getItem('stid_alerts') || '[]'),
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

    // --- Phase 6 Quant Additions ---
    weights: JSON.parse(localStorage.getItem('stid_weights') || 'null') || {
      fundamental: 25,
      technical: 20,
      momentum: 20,
      sentiment: 15,
      institutional: 20
    },
    regime: localStorage.getItem('stid_regime') || 'auto', // 'auto', 'bull', 'bear'
    activeRegime: 'bull', // Resolved active regime: 'bull' or 'bear'
    screener: {
      filters: [],
      results: []
    },
    backtest: {
      params: {
        threshold: 80,
        holdingPeriod: 30,
        lookback: 365
      },
      results: null
    }
  };

  function updateAuthButtons() {
    const btnLogin = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');
    if (!googleClientId) {
      if (btnLogin) btnLogin.style.display = 'none';
      if (btnLogout) btnLogout.style.display = 'none';
      return;
    }
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
    initWeightSliders();
    
    // Fetch SSO configuration
    const config = await API.fetchAuthConfig();
    googleClientId = config.googleClientId;

    const initGoogleSSO = () => {
      if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
        google.accounts.id.initialize({
          client_id: googleClientId,
          callback: handleGoogleLoginCallback
        });
        
        google.accounts.id.renderButton(
          document.getElementById('google-signin-btn'),
          { theme: 'filled_blue', size: 'large', text: 'signin_with', width: 250 }
        );
        console.log('Google Identity Services script loaded and initialized.');
      } else {
        console.log('Google SSO script not ready, retrying in 300ms...');
        setTimeout(initGoogleSSO, 300);
      }
    };

    if (googleClientId) {
      initGoogleSSO();
      const token = localStorage.getItem('google_sso_token');

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
    // Market Regime Status Badge Click
    const regimeBadge = document.getElementById('regime-status');
    if (regimeBadge) {
      regimeBadge.addEventListener('click', () => {
        if (state.regime === 'auto') {
          // Switch to manual bull
          state.regime = 'bull';
          state.activeRegime = 'bull';
          UI.toast('Market Regime set to MANUAL: BULL', 'success');
        } else if (state.regime === 'bull') {
          // Switch to manual bear
          state.regime = 'bear';
          state.activeRegime = 'bear';
          UI.toast('Market Regime set to MANUAL: BEAR', 'warning');
        } else {
          // Switch back to auto
          state.regime = 'auto';
          const savedRegime = state.indicesRegime?.regime || 'bull';
          state.activeRegime = savedRegime;
          UI.toast('Market Regime set to AUTO-DETECTION', 'info');
        }
        localStorage.setItem('stid_regime', state.regime);
        
        // Refresh UI & Recalculate
        updateRegimeUI(state.indicesRegime);
        recalculateAllScores();
      });
    }

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
      if (!e.target.closest('#btn-nexus') && !e.target.closest('#nexus-dropdown')) {
        const nd = document.getElementById('nexus-dropdown');
        if (nd) nd.style.display = 'none';
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
    const apiKeyInput = null; // Removed: Gemini key now server-side only
    const backendUrlInput = null; // Removed: Backend URL is hardcoded server-side
    
    if (btnSettings && settingsDropdown) {
      btnSettings.addEventListener('click', e => {
        e.stopPropagation();
        const isShown = settingsDropdown.style.display === 'block';
        settingsDropdown.style.display = isShown ? 'none' : 'block';
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
        settingsDropdown.style.display = 'none';
        // Reload analysis for current active symbol if present
        if (state.activeSymbol) {
          selectStock(state.activeSymbol);
        }
      });
    }

    // Nexus Toggle & Wizard Wiring
    const btnNexus = document.getElementById('btn-nexus');
    const nexusDropdown = document.getElementById('nexus-dropdown');
    
    if (btnNexus && nexusDropdown) {
      btnNexus.addEventListener('click', e => {
        e.stopPropagation();
        const isShown = nexusDropdown.style.display === 'block';
        nexusDropdown.style.display = isShown ? 'none' : 'block';
        
        // Auto-close settings when opening Nexus
        const sd = document.getElementById('settings-dropdown');
        if (sd) sd.style.display = 'none';

        if (!isShown) {
          const ssoToken = localStorage.getItem('google_sso_token');
          const isBypassed = ssoToken === 'DEMO_BYPASS';
          
          if (!state.isAuthenticated || isBypassed) {
            // Locked preview mode
            document.getElementById('nexus-form-view').style.display = 'none';
            document.getElementById('nexus-results-view').style.display = 'none';
            document.getElementById('nexus-locked-view').style.display = 'flex';
          } else {
            // Premium access
            document.getElementById('nexus-locked-view').style.display = 'none';
            const profStr = localStorage.getItem('nexus_profile');
            if (profStr) {
              try {
                const prof = JSON.parse(profStr);
                document.getElementById('nx-age').value = prof.age || 30;
                document.getElementById('nx-profession').value = prof.profession || 'Engineer';
                document.getElementById('nx-income-stability').value = prof.incomeStability || 'High';
                document.getElementById('nx-dependents').value = prof.dependents || 0;
                document.getElementById('nx-net-income').value = prof.netIncome || 100000;
                document.getElementById('nx-capital').value = prof.capitalAllocation || 500000;
                document.getElementById('nx-risk').value = prof.riskAppetite || 'Moderate';
                document.getElementById('nx-stress').value = prof.behavioralStressResponse || 'Do Nothing';
                
                document.getElementById('nexus-form-view').style.display = 'none';
                document.getElementById('nexus-results-view').style.display = 'flex';
                updateNexusPieChart(prof);
              } catch (err) {
                document.getElementById('nexus-form-view').style.display = 'block';
                document.getElementById('nexus-results-view').style.display = 'none';
              }
            } else {
              document.getElementById('nexus-form-view').style.display = 'block';
              document.getElementById('nexus-results-view').style.display = 'none';
            }
          }
        }
      });
    }

    const btnNexusCloseX = document.getElementById('btn-nexus-close-x');
    if (btnNexusCloseX && nexusDropdown) btnNexusCloseX.addEventListener('click', () => nexusDropdown.style.display = 'none');
    const btnNexusCancel = document.getElementById('btn-nexus-cancel');
    if (btnNexusCancel && nexusDropdown) btnNexusCancel.addEventListener('click', () => nexusDropdown.style.display = 'none');
    const btnNexusClose = document.getElementById('btn-nexus-close');
    if (btnNexusClose && nexusDropdown) btnNexusClose.addEventListener('click', () => nexusDropdown.style.display = 'none');

    // Unlock login trigger
    const btnUnlockLogin = document.getElementById('btn-nexus-unlock-login');
    if (btnUnlockLogin) {
      btnUnlockLogin.addEventListener('click', () => {
        nexusDropdown.style.display = 'none';
        const overlay = document.getElementById('login-overlay');
        if (overlay) overlay.style.display = 'flex';
      });
    }

    // Rebalancing alerts toggle
    const nxAlertToggle = document.getElementById('nx-alert-toggle');
    if (nxAlertToggle) {
      nxAlertToggle.checked = localStorage.getItem('nexus_rebalancing_alerts') !== 'false';
      nxAlertToggle.addEventListener('change', e => {
        localStorage.setItem('nexus_rebalancing_alerts', e.target.checked ? 'true' : 'false');
        UI.toast(`Rebalancing alerts ${e.target.checked ? 'enabled' : 'disabled'}!`, 'info');
      });
    }

    const btnNexusEdit = document.getElementById('btn-nexus-edit');
    if (btnNexusEdit) {
      btnNexusEdit.addEventListener('click', () => {
        document.getElementById('nexus-form-view').style.display = 'block';
        document.getElementById('nexus-results-view').style.display = 'none';
      });
    }

    const nexusForm = document.getElementById('nexus-profile-form');
    if (nexusForm) {
      nexusForm.addEventListener('submit', e => {
        e.preventDefault();
        const userProfile = {
          age: parseInt(document.getElementById('nx-age').value),
          profession: document.getElementById('nx-profession').value.trim(),
          incomeStability: document.getElementById('nx-income-stability').value,
          dependents: parseInt(document.getElementById('nx-dependents').value),
          netIncome: parseFloat(document.getElementById('nx-net-income').value),
          capitalAllocation: parseFloat(document.getElementById('nx-capital').value),
          riskAppetite: document.getElementById('nx-risk').value,
          behavioralStressResponse: document.getElementById('nx-stress').value
        };

        localStorage.setItem('nexus_profile', JSON.stringify(userProfile));
        UI.toast('Nexus Robo-Advisory Profile saved!', 'success');
        
        document.getElementById('nexus-form-view').style.display = 'none';
        document.getElementById('nexus-results-view').style.display = 'flex';
        updateNexusPieChart(userProfile);

        // Trigger AI Wealth Matrix generation
        const aiMatrix = document.getElementById('nexus-ai-matrix');
        const aiLoading = document.getElementById('nexus-ai-loading');
        const aiContent = document.getElementById('nexus-ai-content');
        if (aiMatrix && aiLoading && aiContent) {
          aiMatrix.style.display = 'block';
          aiLoading.style.display = 'block';
          aiContent.style.display = 'none';
          API.fetchNexusProfile(userProfile).then(result => {
            aiLoading.style.display = 'none';
            if (result && result.analysis) {
              // Convert markdown-style text to simple HTML
              const html = result.analysis
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/^### (.*$)/gm, '<div style="font-size:0.78rem;font-weight:700;color:var(--text-primary);margin:10px 0 4px;">$1</div>')
                .replace(/^## (.*$)/gm, '<div style="font-size:0.8rem;font-weight:700;color:var(--text-accent);margin:10px 0 4px;">$1</div>')
                .replace(/^- (.*$)/gm, '<div style="padding-left:8px;margin:2px 0;">• $1</div>')
                .replace(/\n\n/g, '<br>');
              aiContent.innerHTML = html;
              aiContent.style.display = 'block';
            } else {
              aiContent.innerHTML = '<span style="color:var(--text-muted)">AI analysis unavailable. Check backend connection.</span>';
              aiContent.style.display = 'block';
            }
          }).catch(err => {
            aiLoading.style.display = 'none';
            aiContent.innerHTML = `<span style="color:var(--red)">Analysis failed: ${err.message}</span>`;
            aiContent.style.display = 'block';
          });
        }

        // Update UI
        updateWatchlistUI();
        updateRecommendations();
        if (state.activeSymbol) {
          const res = state.results.get(state.activeSymbol);
          if (res) {
            UI.renderDetailHeader(res);
            UI.renderTechnicals(res);
          }
        }
      });
    }

    // Sector Grid event delegation -> Opens right side drawer instead of main panel
    const sectorGrid = document.getElementById('sector-grid');
    if (sectorGrid) {
      sectorGrid.addEventListener('click', e => {
        const badge = e.target.closest('.sector-stock-badge, .sector-stock-tag');
        if (badge) {
          const sym = badge.getAttribute('data-symbol');
          if (sym) {
            e.preventDefault();
            e.stopPropagation();
            openMiniAnalysisDrawer(sym);
          }
        }
      });
    }

    // Mini-Analysis Drawer Event Bindings
    const miniDrawer = document.getElementById('mini-analysis-drawer');
    const miniDrawerClose = document.getElementById('mini-analysis-close');
    if (miniDrawerClose && miniDrawer) {
      miniDrawerClose.addEventListener('click', () => {
        miniDrawer.classList.remove('show');
        miniDrawer.setAttribute('aria-hidden', 'true');
        document.getElementById('drawer-alert-setup').style.display = 'none';
      });
    }

    const btnDrawerAlert = document.getElementById('btn-drawer-alert');
    const drawerAlertSetup = document.getElementById('drawer-alert-setup');
    if (btnDrawerAlert && drawerAlertSetup) {
      btnDrawerAlert.addEventListener('click', () => {
        const isShown = drawerAlertSetup.style.display === 'flex';
        drawerAlertSetup.style.display = isShown ? 'none' : 'flex';
        if (!isShown) {
          // prefill current price
          const activeSym = state.drawerActiveSymbol;
          if (activeSym) {
            const res = state.results.get(activeSym) || state.catalogResults.get(activeSym);
            const priceValInput = document.getElementById('alert-setup-price');
            if (res && priceValInput) {
              priceValInput.value = res.quote.price.toFixed(2);
            }
          }
        }
      });
    }

    const btnDrawerAlertClose = document.getElementById('btn-drawer-alert-close');
    if (btnDrawerAlertClose && drawerAlertSetup) {
      btnDrawerAlertClose.addEventListener('click', () => {
        drawerAlertSetup.style.display = 'none';
      });
    }

    const btnDrawerAlertSave = document.getElementById('btn-drawer-alert-save');
    if (btnDrawerAlertSave) {
      btnDrawerAlertSave.addEventListener('click', () => {
        const symbol = state.drawerActiveSymbol;
        if (!symbol) return;
        
        const priceInput = document.getElementById('alert-setup-price');
        const condSelect = document.getElementById('alert-setup-cond');
        const rsiSelect = document.getElementById('alert-setup-rsi-cond');
        
        const price = parseFloat(priceInput?.value || '');
        if (isNaN(price) || price <= 0) {
          UI.toast('Please enter a valid target price', 'error');
          return;
        }
        
        const condition = condSelect?.value || 'below';
        const rsiCondition = rsiSelect?.value || 'any';
        
        state.alerts = state.alerts || [];
        state.alerts.push({ symbol, price, condition, rsiCondition, active: true });
        localStorage.setItem('stid_alerts', JSON.stringify(state.alerts));
        
        UI.toast(`Alert signal configured for ${symbol.replace('.NS','')}`, 'success');
        
        if (priceInput) priceInput.value = '';
        if (drawerAlertSetup) drawerAlertSetup.style.display = 'none';
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

    // --- Portfolio & Auth Bindings ---
    const brokerSelect = document.getElementById('portfolio-broker-select');
    const apiKeyGroup = document.getElementById('portfolio-api-key-group');
    if (brokerSelect && apiKeyGroup) {
      brokerSelect.addEventListener('change', () => {
        apiKeyGroup.style.display = brokerSelect.value === 'ZERODHA' ? 'block' : 'none';
      });
    }

    const demoBypassChk = document.getElementById('portfolio-demo-bypass-chk');
    if (demoBypassChk) {
      demoBypassChk.addEventListener('change', () => {
        if (demoBypassChk.checked) {
          const apiField = document.getElementById('portfolio-api-key-input');
          const tokField = document.getElementById('portfolio-access-token-input');
          if (apiField) apiField.value = 'MOCK_KEY';
          if (tokField) tokField.value = 'DEMO_BYPASS';
        } else {
          const apiField = document.getElementById('portfolio-api-key-input');
          const tokField = document.getElementById('portfolio-access-token-input');
          if (apiField) apiField.value = '';
          if (tokField) tokField.value = '';
        }
      });
    }

    const btnConnect = document.getElementById('btn-portfolio-connect');
    if (btnConnect) {
      btnConnect.addEventListener('click', async () => {
        const brokerName = document.getElementById('portfolio-broker-select').value;
        const apiKey = document.getElementById('portfolio-api-key-input')?.value.trim() || '';
        const accessToken = document.getElementById('portfolio-access-token-input')?.value.trim() || '';
        
        if (!accessToken) {
          UI.toast('Access token is required', 'error');
          return;
        }
        
        try {
          btnConnect.disabled = true;
          btnConnect.innerText = '🔐 Connecting...';
          await API.connectBroker(brokerName, apiKey, accessToken);
          UI.toast(`Successfully connected to ${brokerName}!`, 'success');
          await loadAndRenderPortfolio();
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          btnConnect.disabled = false;
          btnConnect.innerText = '🔐 Save & Authorize';
        }
      });
    }

    const btnDisconnect = document.getElementById('btn-portfolio-disconnect');
    if (btnDisconnect) {
      btnDisconnect.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to disconnect your broker account? This will clear synced holdings.')) return;
        try {
          const brokerBadge = document.getElementById('portfolio-connected-broker')?.innerText || 'ZERODHA';
          await API.disconnectBroker(brokerBadge);
          UI.toast('Disconnected successfully', 'success');
          UI.renderPortfolioSection({ connected: false });
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    }

    const btnSync = document.getElementById('btn-portfolio-sync');
    if (btnSync) {
      btnSync.addEventListener('click', async () => {
        await loadAndRenderPortfolio();
      });
    }

    const btnAuthLogin = document.getElementById('btn-auth-login');
    const btnAuthRegister = document.getElementById('btn-auth-register');
    if (btnAuthLogin && btnAuthRegister) {
      btnAuthLogin.addEventListener('click', async () => {
        const email = document.getElementById('auth-email-input')?.value.trim() || '';
        const password = document.getElementById('auth-password-input')?.value.trim() || '';
        if (!email || !password) {
          UI.toast('Email and Password are required', 'error');
          return;
        }
        try {
          btnAuthLogin.disabled = true;
          const res = await API.loginUser(email, password);
          localStorage.setItem('google_sso_token', res.token);
          state.isAuthenticated = true;
          document.getElementById('login-overlay').style.display = 'none';
          UI.toast('Signed in successfully!', 'success');
          updateAuthButtons();
          await loadAllWatchlistStocks();
          if (state.pendingAction === 'showPortfolio') {
            state.pendingAction = null;
            switchRecTab('portfolio');
          }
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          btnAuthLogin.disabled = false;
        }
      });

      btnAuthRegister.addEventListener('click', async () => {
        const email = document.getElementById('auth-email-input')?.value.trim() || '';
        const password = document.getElementById('auth-password-input')?.value.trim() || '';
        if (!email || !password) {
          UI.toast('Email and Password are required', 'error');
          return;
        }
        try {
          btnAuthRegister.disabled = true;
          const res = await API.registerUser(email, password);
          localStorage.setItem('google_sso_token', res.token);
          state.isAuthenticated = true;
          document.getElementById('login-overlay').style.display = 'none';
          UI.toast('Account registered and signed in!', 'success');
          updateAuthButtons();
          await loadAllWatchlistStocks();
          if (state.pendingAction === 'showPortfolio') {
            state.pendingAction = null;
            switchRecTab('portfolio');
          }
        } catch (err) {
          UI.toast(err.message, 'error');
        } finally {
          btnAuthRegister.disabled = false;
        }
      });
    }

    // Toggle Picks, Portfolio, Screener, Backtester and Performance Report
    const btnShowPicks = document.getElementById('btn-show-picks');
    const btnShowPortfolio = document.getElementById('btn-show-portfolio');
    const btnShowScreener = document.getElementById('btn-show-screener');
    const btnShowBacktester = document.getElementById('btn-show-backtester');
    const btnShowPerformance = document.getElementById('btn-show-performance');

    const picksSection = document.getElementById('picks-section-container');
    const portfolioSection = document.getElementById('portfolio-section-container');
    const screenerSection = document.getElementById('screener-section-container');
    const backtesterSection = document.getElementById('backtester-section-container');
    const performanceSection = document.getElementById('performance-section-container');

    window.switchRecTab = function(tabName) {
      const tabs = [
        { name: 'picks', btn: btnShowPicks, sect: picksSection },
        { name: 'portfolio', btn: btnShowPortfolio, sect: portfolioSection },
        { name: 'screener', btn: btnShowScreener, sect: screenerSection },
        { name: 'backtester', btn: btnShowBacktester, sect: backtesterSection },
        { name: 'performance', btn: btnShowPerformance, sect: performanceSection }
      ];

      tabs.forEach(t => {
        if (t.btn && t.sect) {
          t.btn.classList.toggle('active', t.name === tabName);
          t.sect.style.display = t.name === tabName ? 'block' : 'none';
          if (t.name === tabName) {
            t.btn.style.color = 'var(--text-primary)';
            t.btn.style.borderBottom = '2px solid var(--text-accent)';
            t.btn.style.fontWeight = '700';
          } else {
            t.btn.style.color = 'var(--text-muted)';
            t.btn.style.borderBottom = 'none';
            t.btn.style.fontWeight = '600';
          }
        }
      });

      if (tabName === 'performance') {
        UI.renderPerformanceDashboard();
      } else if (tabName === 'backtester') {
        updateBacktestTargetStock();
      } else if (tabName === 'portfolio') {
        loadAndRenderPortfolio();
      }
    };

    async function loadAndRenderPortfolio() {
      if (!state.isAuthenticated) {
        state.pendingAction = 'showPortfolio';
        document.getElementById('login-overlay').style.display = 'flex';
        return;
      }
      
      const tbody = document.getElementById('portfolio-holdings-tbody');
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:20px; color:var(--text-muted);">🔄 Syncing holdings with broker & running AI Robo-Models...</td></tr>`;
      }
      
      try {
        const res = await API.analyzePortfolio();
        UI.renderPortfolioSection(res);
      } catch (err) {
        console.error("Failed to load portfolio:", err.message);
        UI.renderPortfolioSection({ connected: false });
        UI.toast("Sync failed: " + err.message, "error");
      }
    }

    if (btnShowPicks) btnShowPicks.addEventListener('click', () => switchRecTab('picks'));
    
    if (btnShowPortfolio) {
      btnShowPortfolio.addEventListener('click', () => {
        if (!state.isAuthenticated) {
          state.pendingAction = 'showPortfolio';
          document.getElementById('login-overlay').style.display = 'flex';
          return;
        }
        switchRecTab('portfolio');
      });
    }
    
    if (btnShowScreener) {
      btnShowScreener.addEventListener('click', () => {
        if (!state.isAuthenticated) {
          state.pendingAction = 'showScreener';
          document.getElementById('login-overlay').style.display = 'flex';
          return;
        }
        switchRecTab('screener');
      });
    }

    if (btnShowBacktester) {
      btnShowBacktester.addEventListener('click', () => {
        if (!state.isAuthenticated) {
          state.pendingAction = 'showBacktester';
          document.getElementById('login-overlay').style.display = 'flex';
          return;
        }
        switchRecTab('backtester');
      });
    }

    if (btnShowPerformance) {
      btnShowPerformance.addEventListener('click', () => {
        if (!state.isAuthenticated) {
          state.pendingAction = 'showPerformance';
          document.getElementById('login-overlay').style.display = 'flex';
          return;
        }
        switchRecTab('performance');
      });
    }


    // --- Screener Component UI Logic ---
    const btnScreenerAddFilter = document.getElementById('btn-screener-add-filter');
    const btnScreenerRun = document.getElementById('btn-screener-run');
    const btnScreenerClear = document.getElementById('btn-screener-clear');

    function addScreenerRow(metric = 'pe', operator = '<', value = '20') {
      const container = document.getElementById('screener-filter-list');
      if (!container) return;

      const row = document.createElement('div');
      row.className = 'screener-row';
      
      const metrics = [
        { value: 'pe', label: 'P/E Ratio' },
        { value: 'pb', label: 'Price / Book (P/B)' },
        { value: 'rsi', label: 'RSI (14)' },
        { value: 'volumeRatio', label: 'Volume / 20-Day Avg' },
        { value: 'roe', label: 'Return on Equity (ROE %)' },
        { value: 'marketCap', label: 'Market Cap (Cr / M$)' },
        { value: 'price', label: 'Stock Price' },
        { value: 'changePct', label: 'Daily Change %' },
        { value: 'score', label: 'Composite Score (0-100)' }
      ];

      const metricSelect = `<select class="screener-select metric-select" style="width:100%;">
        ${metrics.map(m => `<option value="${m.value}" ${m.value === metric ? 'selected' : ''}>${m.label}</option>`).join('')}
      </select>`;

      const operatorSelect = `<select class="screener-select operator-select" style="width:100%;">
        <option value="<" ${operator === '<' ? 'selected' : ''}>&lt; Less Than</option>
        <option value=">" ${operator === '>' ? 'selected' : ''}>&gt; Greater Than</option>
        <option value="=" ${operator === '=' ? 'selected' : ''}>= Equals</option>
      </select>`;

      const valueInput = `<input type="number" class="screener-input value-input" value="${value}" style="width:100%;" step="any">`;
      const deleteBtn = `<button type="button" class="screener-btn-delete" title="Delete filter">🗑️</button>`;

      row.innerHTML = metricSelect + operatorSelect + valueInput + deleteBtn;

      row.querySelector('.screener-btn-delete').addEventListener('click', () => {
        row.remove();
        if (container.children.length === 0) {
          addScreenerRow();
        }
      });

      container.appendChild(row);
    }

    function resetScreenerFilters() {
      const container = document.getElementById('screener-filter-list');
      if (container) {
        container.innerHTML = '';
        addScreenerRow('rsi', '<', '40');
        addScreenerRow('score', '>', '70');
      }
      const tbody = document.getElementById('screener-results-tbody');
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="7" style="text-align:center; padding:32px 0; color:var(--text-muted); font-size:0.8rem;">
              No query run yet. Add conditions and click "Run Query" to search.
            </td>
          </tr>`;
      }
      const countEl = document.getElementById('screener-result-count');
      if (countEl) countEl.textContent = '0 stocks matched';
    }

    async function runScreenerQuery() {
      if (btnScreenerRun) {
        btnScreenerRun.disabled = true;
        btnScreenerRun.textContent = 'Scanning...';
      }

      try {
        const filterRows = document.querySelectorAll('.screener-row');
        const filters = [];

        filterRows.forEach(row => {
          const metric = row.querySelector('.metric-select').value;
          const operator = row.querySelector('.operator-select').value;
          const valueVal = row.querySelector('.value-input').value;
          
          if (valueVal !== '') {
            filters.push({ metric, operator, value: parseFloat(valueVal) });
          }
        });

        const weights = state.weights;
        const activeRegime = state.activeRegime;
        const market = state.marketMode || 'IN';

        const results = await API.runScreener(filters, weights, activeRegime, market);
        
        const tbody = document.getElementById('screener-results-tbody');
        const countEl = document.getElementById('screener-result-count');

        if (countEl) {
          countEl.textContent = `${results?.length || 0} stocks matched`;
        }

        if (!tbody) return;

        if (!results || results.length === 0) {
          tbody.innerHTML = `
            <tr>
              <td colspan="7" style="text-align:center; padding:32px 0; color:var(--text-muted); font-size:0.8rem;">
                No stocks matched the specified filter conditions.
              </td>
            </tr>`;
          return;
        }

        const mode = localStorage.getItem('stid_market_mode') || 'IN';
        const isUS = mode === 'US';
        const cSym = isUS ? '$' : '₹';

        tbody.innerHTML = results.map(r => {
          const changeClass = r.changePct >= 0 ? 'text-success' : 'text-danger';
          const scoreColor = Analysis.scoreColor(r.score);
          const scoreBadge = Analysis.scoreBadgeClass(r.score);
          
          return `
            <tr>
              <td>
                <strong style="color:var(--text-primary); cursor:pointer;" onclick="App.selectStock('${r.symbol}')">${r.symbol.replace('.NS','').replace('.BO','')}</strong>
              </td>
              <td>${r.name}</td>
              <td style="font-family:'JetBrains Mono', monospace; font-weight:600;">${cSym}${r.price?.toFixed(2)}</td>
              <td class="${changeClass}" style="font-weight:600;">${r.changePct >= 0 ? '+' : ''}${r.changePct?.toFixed(2)}%</td>
              <td>
                <span class="badge ${scoreBadge}" style="background:${scoreColor}20; color:${scoreColor}; border:1px solid ${scoreColor}40;">
                  ${r.score}
                </span>
              </td>
              <td>${r.marketCapCr ? r.marketCapCr.toFixed(0) + (isUS ? ' M' : ' Cr') : 'N/A'}</td>
              <td>
                <button type="button" class="btn" style="padding:4px 8px; font-size:0.7rem; background:rgba(59,130,246,0.1); color:#3b82f6; border:1px solid rgba(59,130,246,0.2);" onclick="App.selectStock('${r.symbol}')">Analyze</button>
                <button type="button" class="btn" style="padding:4px 8px; font-size:0.7rem; background:rgba(16,185,129,0.1); color:#10b981; border:1px solid rgba(16,185,129,0.2);" onclick="App.addStock('${r.symbol}', '${r.name}')">Watch</button>
              </td>
            </tr>
          `;
        }).join('');

      } catch (err) {
        UI.toast('Screener run failed: ' + err.message, 'error');
      } finally {
        if (btnScreenerRun) {
          btnScreenerRun.disabled = false;
          btnScreenerRun.textContent = '🚀 Run Query';
        }
      }
    }

    if (btnScreenerAddFilter) btnScreenerAddFilter.addEventListener('click', () => addScreenerRow());
    if (btnScreenerClear) btnScreenerClear.addEventListener('click', resetScreenerFilters);
    if (btnScreenerRun) btnScreenerRun.addEventListener('click', runScreenerQuery);

    // Initialize with default filters
    resetScreenerFilters();

    // --- Backtester Component UI Logic ---
    const btnBacktestRun = document.getElementById('btn-backtest-run');

    window.updateBacktestTargetStock = function() {
      const el = document.getElementById('backtest-target-stock');
      if (el) {
        if (state.activeSymbol) {
          const res = state.results.get(state.activeSymbol);
          el.textContent = `${res?.name || state.activeSymbol} (${state.activeSymbol.replace('.NS','').replace('.BO','')})`;
        } else {
          el.textContent = 'Select stock from Watchlist';
        }
      }
    };

    async function runBacktestSimulation() {
      if (!state.activeSymbol) {
        UI.toast('Please select a stock from the watchlist first to backtest.', 'warning');
        return;
      }

      const tbody = document.getElementById('backtest-ledger-tbody');
      const statsContainer = document.getElementById('backtest-stats-container');

      if (btnBacktestRun) {
        btnBacktestRun.disabled = true;
        btnBacktestRun.textContent = 'Simulating...';
      }

      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align:center; padding:32px 0; color:var(--text-muted); font-size:0.8rem;">
              <div class="spinner" style="margin: 0 auto 8px auto;"></div>
              Executing trade simulations across historical price bars...
            </td>
          </tr>`;
      }

      try {
        const threshold = parseFloat(document.getElementById('backtest-param-threshold').value || '80');
        const holdingPeriod = parseInt(document.getElementById('backtest-param-holding').value || '30');
        const lookback = parseInt(document.getElementById('backtest-param-lookback').value || '365');
        const weights = state.weights;
        const activeRegime = state.activeRegime;

        const res = await API.runBacktest(state.activeSymbol, {
          threshold,
          holdingPeriod,
          lookback,
          weights,
          activeRegime
        });

        if (!res) {
          throw new Error('No simulation results returned');
        }

        if (statsContainer) {
          statsContainer.style.display = 'grid';
          
          const wrEl = document.getElementById('backtest-stat-winrate');
          const retEl = document.getElementById('backtest-stat-avgreturn');
          const tradesEl = document.getElementById('backtest-stat-trades');
          const alphaEl = document.getElementById('backtest-stat-alpha');

          if (wrEl) {
            wrEl.textContent = `${res.winRate.toFixed(1)}%`;
            wrEl.style.color = res.winRate >= 50 ? 'var(--green)' : 'var(--red)';
          }
          if (retEl) {
            retEl.textContent = `${res.avgReturn >= 0 ? '+' : ''}${res.avgReturn.toFixed(2)}%`;
            retEl.style.color = res.avgReturn >= 0 ? 'var(--green)' : 'var(--red)';
          }
          if (tradesEl) {
            tradesEl.textContent = res.totalTrades;
          }
          if (alphaEl) {
            alphaEl.textContent = `${res.alpha >= 0 ? '+' : ''}${res.alpha.toFixed(1)}%`;
            alphaEl.style.color = res.alpha >= 0 ? 'var(--green)' : 'var(--red)';
          }
        }

        if (!tbody) return;

        if (res.trades.length === 0) {
          tbody.innerHTML = `
            <tr>
              <td colspan="6" style="text-align:center; padding:32px 0; color:var(--text-muted); font-size:0.8rem;">
                No trade signals generated with the current threshold score.
              </td>
            </tr>`;
          return;
        }

        const mode = localStorage.getItem('stid_market_mode') || 'IN';
        const cSym = mode === 'US' ? '$' : '₹';

        tbody.innerHTML = res.trades.map(t => {
          const retClass = t.returnPct >= 0 ? 'text-success' : 'text-danger';
          const entDateStr = new Date(t.entryDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
          const extDateStr = new Date(t.exitDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

          return `
            <tr>
              <td>${entDateStr}</td>
              <td style="font-family:'JetBrains Mono', monospace;">${cSym}${t.entryPrice.toFixed(2)}</td>
              <td>${extDateStr}</td>
              <td style="font-family:'JetBrains Mono', monospace;">${cSym}${t.exitPrice.toFixed(2)}</td>
              <td>${t.holdDays} days</td>
              <td class="${retClass}" style="font-family:'JetBrains Mono', monospace; font-weight:700;">
                ${t.returnPct >= 0 ? '+' : ''}${t.returnPct.toFixed(2)}%
              </td>
            </tr>
          `;
        }).join('');

      } catch (err) {
        UI.toast('Backtest run failed: ' + err.message, 'error');
        if (tbody) {
          tbody.innerHTML = `
            <tr>
              <td colspan="6" style="text-align:center; padding:32px 0; color:var(--red); font-size:0.8rem;">
                ⚠️ Error: ${err.message}
              </td>
            </tr>`;
        }
      } finally {
        if (btnBacktestRun) {
          btnBacktestRun.disabled = false;
          btnBacktestRun.textContent = '🚀 Run Simulation';
        }
      }
    }

    if (btnBacktestRun) btnBacktestRun.addEventListener('click', runBacktestSimulation);

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

  function initWeightSliders() {
    const keys = ['fundamental', 'technical', 'momentum', 'sentiment', 'institutional'];
    
    // Update labels and values initially
    keys.forEach(k => {
      const slider = document.getElementById(`weight-slider-${k}`);
      const label = document.getElementById(`weight-lbl-${k}`);
      if (slider && label) {
        slider.value = state.weights[k];
        label.textContent = `${state.weights[k]}%`;
      }
    });

    // Reset button click
    const btnReset = document.getElementById('btn-weights-reset');
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        state.weights = {
          fundamental: 25,
          technical: 20,
          momentum: 20,
          sentiment: 15,
          institutional: 20
        };
        localStorage.setItem('stid_weights', JSON.stringify(state.weights));
        keys.forEach(k => {
          const slider = document.getElementById(`weight-slider-${k}`);
          const label = document.getElementById(`weight-lbl-${k}`);
          if (slider && label) {
            slider.value = state.weights[k];
            label.textContent = `${state.weights[k]}%`;
          }
        });
        recalculateAllScores();
        UI.toast('Sliders reset to default weights', 'info');
      });
    }

    // Auto-proportional slider logic
    keys.forEach(changedKey => {
      const slider = document.getElementById(`weight-slider-${changedKey}`);
      if (slider) {
        slider.addEventListener('input', (e) => {
          const newValue = parseInt(e.target.value);
          const oldValue = state.weights[changedKey];
          const diff = newValue - oldValue;
          
          if (diff === 0) return;

          const otherKeys = keys.filter(k => k !== changedKey);
          const sumOthers = otherKeys.reduce((acc, k) => acc + state.weights[k], 0);

          if (sumOthers > 0) {
            let tempSum = 0;
            otherKeys.forEach(k => {
              const proportion = state.weights[k] / sumOthers;
              const adjustment = diff * proportion;
              state.weights[k] = Math.max(0, Math.round(state.weights[k] - adjustment));
              tempSum += state.weights[k];
            });
            
            state.weights[changedKey] = newValue;

            // Resolve rounding adjustments to enforce exact 100% total
            let total = state.weights[changedKey] + tempSum;
            if (total !== 100) {
              const error = 100 - total;
              let largestKey = otherKeys[0];
              let maxVal = state.weights[largestKey];
              otherKeys.forEach(k => {
                if (state.weights[k] > maxVal) {
                  maxVal = state.weights[k];
                  largestKey = k;
                }
              });
              state.weights[largestKey] = Math.max(0, state.weights[largestKey] + error);
            }
          } else {
            // Split remaining weight evenly if other fields are 0
            const remaining = 100 - newValue;
            const split = Math.floor(remaining / otherKeys.length);
            otherKeys.forEach(k => {
              state.weights[k] = split;
            });
            state.weights[changedKey] = newValue;
            
            let total = newValue + (split * otherKeys.length);
            if (total !== 100) {
              state.weights[otherKeys[0]] += (100 - total);
            }
          }

          // Sync label strings and values
          keys.forEach(k => {
            const s = document.getElementById(`weight-slider-${k}`);
            const l = document.getElementById(`weight-lbl-${k}`);
            if (s && l) {
              s.value = state.weights[k];
              l.textContent = `${state.weights[k]}%`;
            }
          });

          localStorage.setItem('stid_weights', JSON.stringify(state.weights));
          recalculateAllScores();
        });
      }
    });
  }

  function updateRegimeUI(regimeData) {
    const badge = document.getElementById('regime-status');
    const textSpan = document.getElementById('regime-text');
    if (!badge || !textSpan) return;

    const currentRegime = state.activeRegime;
    const isAuto = state.regime === 'auto';
    
    badge.className = 'regime-badge';
    
    if (isAuto) {
      if (currentRegime === 'bull') {
        badge.classList.add('regime-badge-auto-bull');
        textSpan.textContent = '🐂 AUTO: BULL';
        badge.title = `Auto-detected Bull Regime (200 SMA: ${regimeData?.sma200?.toFixed(1) || 'N/A'}). Click to cycle manual overrides.`;
      } else {
        badge.classList.add('regime-badge-auto-bear');
        textSpan.textContent = '🐻 AUTO: BEAR';
        badge.title = `Auto-detected Bear Regime (200 SMA: ${regimeData?.sma200?.toFixed(1) || 'N/A'}). Click to cycle manual overrides.`;
      }
    } else {
      if (currentRegime === 'bull') {
        badge.classList.add('regime-badge-bull');
        textSpan.textContent = '🐂 MANUAL: BULL';
        badge.title = 'Manual Bull Regime active. Click to switch to Manual Bear.';
      } else {
        badge.classList.add('regime-badge-bear');
        textSpan.textContent = '🐻 MANUAL: BEAR';
        badge.title = 'Manual Bear Regime active. Click to switch to Auto.';
      }
    }
  }

  function recalculateAllScores() {
    // 1. Detailed analysis results
    for (const [symbol, result] of state.results.entries()) {
      if (result && !result.error && result.scores) {
        const s = result.scores;
        const newComposite = Analysis.compositeScore(
          s.fundamental.score,
          s.technicalSetup.score,
          s.momentum.score,
          s.sentiment.score,
          s.institutional.score,
          result.quote.price,
          s.technicalSetup.indicators?.sma200,
          state.weights,
          state.activeRegime
        );
        result.scores.composite = newComposite;
        result.tradeSetup = Analysis.calcTradeSetup(result.quote.price, s.technicalSetup.indicators, s.momentum.indicators);
      }
    }

    // 2. Background catalog quotes
    for (const [symbol, result] of state.catalogResults.entries()) {
      if (result && !result.error && result.scores) {
        const s = result.scores;
        const newComposite = Analysis.compositeScore(
          s.fundamental.score,
          s.technicalSetup.score,
          s.momentum.score,
          s.sentiment.score,
          s.institutional.score,
          result.quote.price,
          s.technicalSetup.indicators?.sma200,
          state.weights,
          state.activeRegime
        );
        result.scores.composite = newComposite;
        result.tradeSetup = Analysis.calcTradeSetup(result.quote.price, s.technicalSetup.indicators, s.momentum.indicators);
      }
    }

    // 3. Update UI
    updateWatchlistUI();
    updateRecommendations();

    if (state.activeSymbol) {
      const activeRes = state.results.get(state.activeSymbol);
      if (activeRes) {
        UI.renderAnalysisResult(activeRes, state.watchlist);
        Charts.renderRadarChart(activeRes.scores);
        if (typeof renderHistoricalScoreChart === 'function') {
          renderHistoricalScoreChart(state.activeSymbol);
        }
      }
    }

    if (state.drawerActiveSymbol) {
      // Re-populate drawer dynamically
      openMiniAnalysisDrawer(state.drawerActiveSymbol);
    }
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
          
          // Extract and store market regime
          if (pulse.regime) {
            state.indicesRegime = pulse.regime;
            if (state.regime === 'auto') {
              state.activeRegime = pulse.regime.regime || 'bull';
            } else {
              state.activeRegime = state.regime;
            }
          }
          updateRegimeUI(pulse.regime);
        } catch (e) {
          console.warn('Backend pulse fetch failed, using fallback', e.message);
          backendActive = false;
        }
      }

      if (!backendActive) {
        indices = await API.fetchMarketIndices();
        fearGreed = await API.fetchFearGreed();
        state.indicesRegime = { price: 0, sma200: 0, regime: 'bull' };
        state.activeRegime = state.regime === 'auto' ? 'bull' : state.regime;
        updateRegimeUI(null);
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

    const finalResult = state.results.get(symbol);
    if (finalResult && !finalResult.error && finalResult.scores?.composite) {
      const profStr = localStorage.getItem('nexus_profile');
      if (profStr) {
        try {
          const prof = JSON.parse(profStr);
          if (prof.riskAppetite === 'Conservative') {
            const tag = Analysis.getAssetRiskTag(finalResult);
            if (tag === 'Core Portfolio Anchor' && finalResult.scores?.institutional?.score < 10) {
              UI.toast(`Portfolio Drift Alert: ${finalResult.symbol.replace('.NS','')} has lost institutional momentum. Rebalancing suggested to protect your conservative profile.`, 'warning', 8000);
            }
          }
        } catch (driftErr) {
          console.warn('Drift check failed:', driftErr);
        }
      }
    }

    updateWatchlistUI();
    updateRecommendations();
    checkPriceAlerts();
    return finalResult;
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

  // ── Price Alerts Checker
  function checkPriceAlerts() {
    if (!state.alerts || state.alerts.length === 0) return;
    
    let triggeredAlerts = [];
    let updatedAlerts = [...state.alerts];
    
    updatedAlerts.forEach((alert, index) => {
      const result = state.results.get(alert.symbol) || state.catalogResults.get(alert.symbol);
      if (!result || result.error) return;
      
      const currentPrice = result.quote.price;
      const currentRsi = result.scores.momentum?.indicators?.rsi;
      if (typeof currentPrice !== 'number') return;
      
      let priceTriggered = false;
      if (alert.condition === 'above' && currentPrice >= alert.price) {
        priceTriggered = true;
      } else if (alert.condition === 'below' && currentPrice <= alert.price) {
        priceTriggered = true;
      }
      
      let rsiTriggered = true;
      if (alert.rsiCondition === 'oversold' && typeof currentRsi === 'number' && currentRsi >= 35) {
        rsiTriggered = false;
      } else if (alert.rsiCondition === 'overbought' && typeof currentRsi === 'number' && currentRsi <= 65) {
        rsiTriggered = false;
      }
      
      if (priceTriggered && rsiTriggered) {
        const ticker = alert.symbol.replace('.NS', '').replace('.BO', '');
        const rsiText = typeof currentRsi === 'number' ? ` | RSI: ${currentRsi.toFixed(1)}` : '';
        const alertMsg = `🚨 ALERT: ${ticker} hit ${currentPrice.toFixed(2)} (Target: ${alert.price})${rsiText}!`;
        UI.toast(alertMsg, 'warning', 10000);
        console.log(`[ALERT SIGNAL TRIGGERED]`, alertMsg);
        triggeredAlerts.push(index);
      }
    });
    
    if (triggeredAlerts.length > 0) {
      state.alerts = updatedAlerts.filter((_, idx) => !triggeredAlerts.includes(idx));
      localStorage.setItem('stid_alerts', JSON.stringify(state.alerts));
    }
  }

  // ── Open Mini Analysis Side Drawer
  async function openMiniAnalysisDrawer(symbol) {
    if (!state.isAuthenticated) {
      state.pendingSelectSymbol = symbol;
      document.getElementById('login-overlay').style.display = 'flex';
      return;
    }
    
    const drawer = document.getElementById('mini-analysis-drawer');
    if (!drawer) return;

    // Close chat drawer to avoid overlay clutter
    const chatDrawer = document.getElementById('invy-chat-drawer');
    if (chatDrawer && chatDrawer.classList.contains('show')) {
      chatDrawer.classList.remove('show');
      chatDrawer.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('chat-open');
    }

    // Set active symbol of the drawer
    state.drawerActiveSymbol = symbol;

    // Slide drawer in
    drawer.classList.add('show');
    drawer.setAttribute('aria-hidden', 'false');

    // Setup initial loading text
    const cleanSym = symbol.replace('.NS', '').replace('.BO', '');
    document.getElementById('drawer-ticker-name').textContent = cleanSym;
    const initialScoreBadge = document.getElementById('drawer-score-badge');
    if (initialScoreBadge) {
      initialScoreBadge.textContent = '--';
      initialScoreBadge.style.borderColor = 'var(--border)';
      initialScoreBadge.style.color = 'var(--text-muted)';
    }
    document.getElementById('drawer-company-name').textContent = 'Fetching quantitative analysis...';
    document.getElementById('drawer-price').textContent = '—';
    document.getElementById('drawer-change').textContent = '—';
    document.getElementById('drawer-change').className = '';
    document.getElementById('drawer-trend-strength').textContent = 'Loading...';
    document.getElementById('drawer-trend-strength').style.color = 'var(--text-secondary)';
    document.getElementById('drawer-rsi-val').textContent = '—';
    document.getElementById('drawer-rsi-bar').style.width = '0%';
    document.getElementById('drawer-macd-details').textContent = '—';
    document.getElementById('drawer-macd-badge').textContent = '—';
    document.getElementById('drawer-macd-badge').className = 'badge';
    document.getElementById('drawer-vol-ratio').textContent = '—';
    document.getElementById('drawer-bb-status').textContent = '—';
    document.getElementById('drawer-pivot').textContent = '—';
    document.getElementById('drawer-news-title').textContent = 'Loading catalysts...';
    document.getElementById('drawer-news-summary').textContent = '—';
    document.getElementById('drawer-news-source').textContent = '';
    document.getElementById('drawer-news-link').style.display = 'none';

    // Hide any previous open alert forms
    document.getElementById('drawer-alert-setup').style.display = 'none';

    let result = state.results.get(symbol);
    if (!result) {
      let wl = state.watchlist.find(w => w.symbol === symbol);
      if (!wl && window.API && window.API.STOCK_CATALOG) {
        wl = window.API.STOCK_CATALOG.find(w => w.symbol === symbol);
      }
      result = await analyzeAndStore(symbol, wl?.name || symbol, wl?.sector || 'N/A');
    }

    if (!result || result.error) {
      document.getElementById('drawer-company-name').textContent = 'Error loading stock analysis.';
      document.getElementById('drawer-news-title').textContent = 'Quantitative scraping failed for ' + cleanSym;
      return;
    }

    // Double check that user hasn't switched tickers while fetching
    if (state.drawerActiveSymbol !== symbol) return;

    // Populate drawer elements
    const riskTag = Analysis.getAssetRiskTag(result);
    let tagColor = 'var(--text-accent)';
    let tagBg = 'rgba(99,102,241,0.12)';
    if (riskTag === 'Core Portfolio Anchor') {
      tagColor = '#10b981';
      tagBg = 'rgba(16,185,129,0.12)';
    } else if (riskTag === 'High-Risk Speculative') {
      tagColor = '#ec4899';
      tagBg = 'rgba(236,72,153,0.12)';
    }

    document.getElementById('drawer-ticker-name').innerHTML = `
      ${cleanSym}
      <span class="badge" style="font-size:0.65rem; padding:2px 5px; border-radius:4px; font-weight:700; color:${tagColor}; background:${tagBg}; border:1px solid ${tagColor}33; margin-left:6px; display:inline-block; vertical-align:middle;">
        ${riskTag}
      </span>
    `;
    document.getElementById('drawer-company-name').textContent = result.name;
    const scoreVal = result.scores.composite.total;
    const scoreCol = Analysis.scoreColor(scoreVal, 100);
    const scoreBadge = document.getElementById('drawer-score-badge');
    if (scoreBadge) {
      scoreBadge.textContent = scoreVal;
      scoreBadge.style.borderColor = scoreCol;
      scoreBadge.style.color = scoreCol;
    }

    const mode = localStorage.getItem('stid_market_mode') || 'IN';
    const cSym = mode === 'US' ? '$' : '₹';
    document.getElementById('drawer-price').textContent = `${cSym}${result.quote.price.toFixed(2)}`;
    
    const change = result.quote.changePct;
    document.getElementById('drawer-change').textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
    document.getElementById('drawer-change').className = `wi-change ${change >= 0 ? 'positive' : 'negative'}`;
    document.getElementById('drawer-change').style.color = change >= 0 ? 'var(--green)' : 'var(--red)';

    const tech = result.scores.technicalSetup?.indicators || {};
    const pivots = tech.pivots || {};
    const trendText = tech.trend === 'uptrend' ? 'Bullish Uptrend' : tech.trend === 'downtrend' ? 'Bearish Downtrend' : 'Sideways Consolidation';
    const trendColor = tech.trend === 'uptrend' ? 'var(--green)' : tech.trend === 'downtrend' ? 'var(--red)' : 'var(--yellow)';
    
    document.getElementById('drawer-trend-strength').textContent = trendText;
    document.getElementById('drawer-trend-strength').style.color = trendColor;
    document.getElementById('drawer-pivot').textContent = pivots.pivot ? `${cSym}${pivots.pivot.toFixed(2)}` : 'N/A';

    // RSI
    const mom = result.scores.momentum?.indicators || {};
    const rsi = mom.rsi || 50;
    let rsiLabel = 'Neutral';
    let rsiColor = 'var(--text-primary)';
    if (rsi < 30) {
      rsiLabel = 'Oversold (Buy Zone)';
      rsiColor = 'var(--green)';
    } else if (rsi > 70) {
      rsiLabel = 'Overbought (Sell Zone)';
      rsiColor = 'var(--red)';
    } else if (rsi < 45) {
      rsiLabel = 'Weak Momentum';
      rsiColor = 'var(--yellow)';
    } else if (rsi > 55) {
      rsiLabel = 'Strong Momentum';
      rsiColor = 'var(--text-accent)';
    }
    
    document.getElementById('drawer-rsi-val').textContent = `${rsi.toFixed(1)} (${rsiLabel})`;
    document.getElementById('drawer-rsi-val').style.color = rsiColor;
    document.getElementById('drawer-rsi-bar').style.width = `${Math.min(100, Math.max(0, rsi))}%`;
    document.getElementById('drawer-rsi-bar').style.background = rsiColor;

    // MACD
    const crossover = mom.macdCrossover;
    document.getElementById('drawer-macd-details').textContent = crossover ? 'Fresh Bullish Cross Detected' : 'MACD Trend Bearish/Neutral';
    const macdBadge = document.getElementById('drawer-macd-badge');
    macdBadge.textContent = crossover ? 'Bullish' : 'Bearish';
    macdBadge.style.color = crossover ? '#10b981' : '#f59e0b';
    macdBadge.style.background = crossover ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.12)';
    macdBadge.style.border = `1px solid ${crossover ? '#10b98133' : '#f59e0b33'}`;

    // Volume Ratio
    const volData = tech.volData || {};
    const ratio = volData.latestRatio || (result.quote.volume / (result.quote.avgVolume || 1)) || 1.0;
    document.getElementById('drawer-vol-ratio').textContent = `${ratio.toFixed(2)}x`;
    document.getElementById('drawer-vol-ratio').style.color = ratio >= 1.5 ? 'var(--green)' : 'var(--text-primary)';

    // Bollinger Squeeze
    const bb = tech.bollinger || {};
    const isSqueeze = bb.bandwidth < 0.1;
    const squeezeText = bb.bandwidth ? `${(bb.bandwidth * 100).toFixed(1)}% ${isSqueeze ? '(Squeeze)' : '(Normal)'}` : 'N/A';
    document.getElementById('drawer-bb-status').textContent = squeezeText;
    document.getElementById('drawer-bb-status').style.color = isSqueeze ? 'var(--yellow)' : 'var(--text-primary)';

    // News
    const news = result.news || [];
    if (news.length > 0) {
      const n = news[0];
      document.getElementById('drawer-news-title').textContent = n.title;
      document.getElementById('drawer-news-summary').textContent = n.summary ? n.summary.substring(0, 150) + '...' : 'Click below to read article details.';
      document.getElementById('drawer-news-source').textContent = `Source: ${n.source || 'Finance Catalyst'}`;
      const link = document.getElementById('drawer-news-link');
      if (n.link) {
        link.href = n.link;
        link.style.display = 'inline-block';
      } else {
        link.style.display = 'none';
      }
    } else {
      document.getElementById('drawer-news-title').textContent = 'No recent news catalyst found.';
      document.getElementById('drawer-news-summary').textContent = 'This asset has no recent news events logged.';
      document.getElementById('drawer-news-source').textContent = 'Source: N/A';
      document.getElementById('drawer-news-link').style.display = 'none';
    }

    // Watchlist Add/Remove wiring
    const wlBtn = document.getElementById('btn-drawer-watchlist');
    if (wlBtn) {
      const inWatchlist = state.watchlist.some(w => w.symbol === symbol);
      wlBtn.textContent = inWatchlist ? '➖ Watchlist' : '➕ Watchlist';
      wlBtn.onclick = () => {
        if (inWatchlist) {
          removeStock(symbol);
          wlBtn.textContent = '➕ Watchlist';
        } else {
          addStock(symbol, result.name, result.sector);
          wlBtn.textContent = '➖ Watchlist';
        }
        drawer.classList.remove('show');
        drawer.setAttribute('aria-hidden', 'true');
      };
    }

    // Full dashboard view click handler
    document.getElementById('btn-drawer-full-analysis').onclick = () => {
      drawer.classList.remove('show');
      drawer.setAttribute('aria-hidden', 'true');
      selectStock(symbol);
    };

    // WhatsApp Signal Sharing Format: [TICKER] | [ACTION] | [ENTRY/EXIT] | [STOP LOSS] | [REASONING]
    document.getElementById('btn-drawer-share-wa').onclick = () => {
      const score = result.scores.composite.total;
      let action = 'WATCH/HOLD';
      if (score >= 80) action = 'STRONG BUY';
      else if (score >= 65) action = 'BUY';
      else if (score < 50) action = 'AVOID/SELL';
      
      const entry = `${cSym}${result.quote.price.toFixed(2)}`;
      const sl = result.tradeSetup?.stopLoss ? `${cSym}${result.tradeSetup.stopLoss}` : 'N/A';
      const target = result.tradeSetup?.target1 ? `${cSym}${result.tradeSetup.target1}` : 'N/A';
      const reasoning = `Score: ${score}/100 | RSI: ${rsi.toFixed(1)} (${tech.trend || 'Sideways'})`;
      
      const waMsg = `[${cleanSym}] | [${action}] | [Entry ${entry} / Target ${target}] | [Stop Loss ${sl}] | [${reasoning}]`;
      const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(waMsg)}`;
      window.open(waUrl, '_blank');
    };
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
    const countConfluence = validResults.filter(Analysis.isConfluence).length;

    // Update Counts in UI
    const elAll = document.getElementById('count-all');
    const elStrongBuy = document.getElementById('count-strong-buy');
    const elBuy = document.getElementById('count-buy');
    const elWatch = document.getElementById('count-watch');
    const elAvoid = document.getElementById('count-avoid');
    const elConfluence = document.getElementById('count-confluence');

    if (elAll) elAll.textContent = countAll;
    if (elStrongBuy) elStrongBuy.textContent = countStrongBuy;
    if (elBuy) elBuy.textContent = countBuy;
    if (elWatch) elWatch.textContent = countWatch;
    if (elAvoid) elAvoid.textContent = countAvoid;
    if (elConfluence) elConfluence.textContent = countConfluence;

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

      const profStr = localStorage.getItem('nexus_profile');
      let globalFiltered = [...catalogValid];
      
      if (profStr) {
        try {
          const prof = JSON.parse(profStr);
          if (prof.riskAppetite === 'Conservative') {
            globalFiltered = globalFiltered.filter(r => Analysis.getAssetRiskTag(r) !== 'High-Risk Speculative');
          }
        } catch (e) {}
      }

      if (activeFilter === 'strong-buy') {
        globalFiltered = globalFiltered.filter(r => r.scores.composite.total >= 80);
      } else if (activeFilter === 'buy') {
        globalFiltered = globalFiltered.filter(r => r.scores.composite.total >= 65 && r.scores.composite.total < 80);
      } else if (activeFilter === 'watch') {
        globalFiltered = globalFiltered.filter(r => r.scores.composite.total >= 50 && r.scores.composite.total < 65);
      } else if (activeFilter === 'avoid') {
        globalFiltered = globalFiltered.filter(r => r.scores.composite.total < 50);
      } else if (activeFilter === 'confluence') {
        globalFiltered = globalFiltered.filter(Analysis.isConfluence);
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
        'confluence': '⚡ Confluence'
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

    let watchlistResults = [...validResults];
    let sortFn = (a, b) => b.scores.composite.total - a.scores.composite.total;

    const profStr = localStorage.getItem('nexus_profile');
    if (profStr) {
      try {
        const prof = JSON.parse(profStr);
        const isConservative = prof.age > 45 || prof.dependents > 2 || prof.riskAppetite === 'Conservative' || prof.incomeStability === 'Low';
        const isAggressive = prof.age < 30 && prof.incomeStability === 'High' && prof.riskAppetite === 'Aggressive';

        if (isConservative) {
          watchlistResults = watchlistResults.filter(r => {
            const riskTag = Analysis.getAssetRiskTag(r);
            return riskTag !== 'High-Risk Speculative';
          });
          const priority = { 'Core Portfolio Anchor': 0, 'Alpha Generator': 1 };
          sortFn = (a, b) => {
            const tagA = Analysis.getAssetRiskTag(a);
            const tagB = Analysis.getAssetRiskTag(b);
            const pA = priority[tagA] ?? 99;
            const pB = priority[tagB] ?? 99;
            if (pA !== pB) return pA - pB;
            return b.scores.composite.total - a.scores.composite.total;
          };
        } else if (isAggressive) {
          const priority = { 'Alpha Generator': 0, 'High-Risk Speculative': 1, 'Core Portfolio Anchor': 2 };
          sortFn = (a, b) => {
            const tagA = Analysis.getAssetRiskTag(a);
            const tagB = Analysis.getAssetRiskTag(b);
            const pA = priority[tagA] ?? 99;
            const pB = priority[tagB] ?? 99;
            if (pA !== pB) return pA - pB;
            return b.scores.composite.total - a.scores.composite.total;
          };
        } else {
          const priority = { 'Core Portfolio Anchor': 0, 'Alpha Generator': 1, 'High-Risk Speculative': 2 };
          sortFn = (a, b) => {
            const tagA = Analysis.getAssetRiskTag(a);
            const tagB = Analysis.getAssetRiskTag(b);
            const pA = priority[tagA] ?? 99;
            const pB = priority[tagB] ?? 99;
            if (pA !== pB) return pA - pB;
            return b.scores.composite.total - a.scores.composite.total;
          };
        }
      } catch (e) {
        console.warn('Failed to apply profile sort/filter to watchlist', e);
      }
    }

    const sorted = [...watchlistResults].sort(sortFn);
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

  function updateNexusPieChart(prof) {
    const canvas = document.getElementById('nexus-pie-chart');
    if (!canvas) return;

    let corePct = 50;
    let alphaPct = 35;
    let specPct = 0;
    let cashPct = 15;
    let tierName = 'Moderate Balanced';

    const isConservative = prof.age > 45 || prof.dependents > 2 || prof.riskAppetite === 'Conservative' || prof.incomeStability === 'Low';
    const isAggressive = prof.age < 30 && prof.incomeStability === 'High' && prof.riskAppetite === 'Aggressive';

    if (isConservative) {
      corePct = 70;
      cashPct = 20;
      alphaPct = 10;
      specPct = 0;
      tierName = 'Conservative Legacy Protection';
    } else if (isAggressive) {
      corePct = 40;
      alphaPct = 50;
      specPct = 10;
      cashPct = 0;
      tierName = 'Aggressive Alpha Velocity';
    }

    document.getElementById('nx-assigned-tier').textContent = tierName;

    let detailsHtml = `
      <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
        <span>🏦 Core Anchors:</span>
        <strong>${corePct}%</strong>
      </div>
      <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
        <span>⚡ Alpha Generators:</span>
        <strong>${alphaPct}%</strong>
      </div>
      ${specPct > 0 ? `
      <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
        <span>🔥 High-Risk Speculative:</span>
        <strong>${specPct}%</strong>
      </div>
      ` : ''}
      ${cashPct > 0 ? `
      <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
        <span>💵 Cash / Liquid Hedge:</span>
        <strong>${cashPct}%</strong>
      </div>
      ` : ''}
    `;
    document.getElementById('nx-allocation-details').innerHTML = detailsHtml;

    const ctx = canvas.getContext('2d');
    if (window._nexusChartInstance) {
      window._nexusChartInstance.destroy();
    }

    const chartLabels = ['Core Anchors', 'Alpha Generators'];
    const chartData = [corePct, alphaPct];
    const chartColors = ['#10b981', '#3b82f6'];

    if (specPct > 0) {
      chartLabels.push('Speculative');
      chartData.push(specPct);
      chartColors.push('#ec4899');
    }
    if (cashPct > 0) {
      chartLabels.push('Cash/Hedge');
      chartData.push(cashPct);
      chartColors.push('#f59e0b');
    }

    if (typeof Chart !== 'undefined') {
      window._nexusChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: chartLabels,
          datasets: [{
            data: chartData,
            backgroundColor: chartColors,
            borderColor: '#111827',
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => ` ${ctx.label}: ${ctx.parsed}%`
              }
            }
          },
          cutout: '60%'
        }
      });
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
  return { init, addStock, removeStock, selectStock, switchTab, setRecFilter, setMarketMode, state, recalculateAllScores };
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
