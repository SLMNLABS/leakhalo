// LeakHalo Settings Controller
// Engineered by SLMN LABS · Client-Side Zero-Telemetry

document.addEventListener('DOMContentLoaded', async () => {
  const manifest = chrome.runtime.getManifest();
  const appVersionEl = document.getElementById('appVersion');
  if (appVersionEl) appVersionEl.textContent = manifest.version;

  const btnRateExtension = document.getElementById('btnRateExtension');
  if (btnRateExtension && chrome.runtime?.id) {
    btnRateExtension.href = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
  }

  const saveToast = document.getElementById('saveToast');
  const setNotifications = document.getElementById('setNotifications');
  const setNotifyIPv6 = document.getElementById('setNotifyIPv6');
  const setAutoRefresh = document.getElementById('setAutoRefresh');
  const setFastDetection = document.getElementById('setFastDetection');
  const setRouteWarning = document.getElementById('setRouteWarning');
  const setShowMap = document.getElementById('setShowMap');
  const setShowTimeZone = document.getElementById('setShowTimeZone');
  const setAntiLeakShield = document.getElementById('setAntiLeakShield');
  const setAntiLeakPolicy = document.getElementById('setAntiLeakPolicy');
  const setDnsPrefetchBlock = document.getElementById('setDnsPrefetchBlock');
  const setWebRtcScan = document.getElementById('setWebRtcScan');
  const badgeRadios = [...document.getElementsByName('badgeMode')];
  const themeRadios = [...document.getElementsByName('optionsTheme')];
  const navItems = [...document.querySelectorAll('.nav-item')];
  const navMenu = document.querySelector('.nav-menu');
  const navIndicator = document.querySelector('.nav-indicator');
  const sections = navItems.map((item) => ({
    item,
    section: document.getElementById(item.getAttribute('href')?.slice(1))
  })).filter(({ section }) => section);

  const policyRow = document.getElementById('policyRow');
  const fastDetectionRow = document.getElementById('fastDetectionRow');
  const notifyIpv6Row = document.getElementById('notifyIpv6Row');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const scrollBehavior = () => (reducedMotion.matches ? 'auto' : 'smooth');

  const policyCardStrict = document.getElementById('policyCardStrict');
  const policyCardBalanced = document.getElementById('policyCardBalanced');

  // Search Elements
  const settingsSearch = document.getElementById('settingsSearch');
  const searchClearBtn = document.getElementById('searchClearBtn');
  const searchKbd = document.getElementById('searchKbd');
  const searchEmptyState = document.getElementById('searchEmptyState');

  // Platform shortcut detection (⌘K on macOS, Ctrl K on others)
  const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgentData?.platform || navigator.userAgent || '');
  if (isMac) {
    if (searchKbd) searchKbd.textContent = '⌘K';
    if (settingsSearch) settingsSearch.placeholder = 'Search settings (⌘K)...';
  } else {
    if (searchKbd) searchKbd.textContent = 'Ctrl K';
    if (settingsSearch) settingsSearch.placeholder = 'Search settings (Ctrl+K)...';
  }

  const DEFAULT_SETTINGS = {
    enableAntiLeakShield: true,
    antiLeakPolicy: 'disable_non_proxied_udp',
    enableDnsPrefetchBlock: true,
    enableWebRtcScan: true,
    enableAutoRefresh: true,
    enableFastDetection: true,
    enableNotifications: true,
    notifyIPv6: true,
    warnRouteDivergence: false,
    showMap: true,
    showTimeZone: false,
    badgeMode: 'flag',
    optionsTheme: 'light',
    maskIp: false
  };

  const fields = {
    enableNotifications: setNotifications,
    notifyIPv6: setNotifyIPv6,
    enableAutoRefresh: setAutoRefresh,
    enableFastDetection: setFastDetection,
    warnRouteDivergence: setRouteWarning,
    showMap: setShowMap,
    showTimeZone: setShowTimeZone,
    enableAntiLeakShield: setAntiLeakShield,
    antiLeakPolicy: setAntiLeakPolicy,
    enableDnsPrefetchBlock: setDnsPrefetchBlock,
    enableWebRtcScan: setWebRtcScan
  };
  const OPT_IN = ['warnRouteDivergence', 'showTimeZone'];
  const pendingCounts = new Map();
  let saveChain = Promise.resolve();
  let lastKnownSettings = {};
  let batchFailed = false;

  function setStatus(message, state = 'ready') {
    if (!saveToast) return;
    saveToast.textContent = message;
    saveToast.dataset.state = state;
  }

  function syncPolicyCards(val) {
    const isStrict = val !== 'default_public_interface_only';
    policyCardStrict?.classList.toggle('active', isStrict);
    policyCardStrict?.setAttribute('aria-checked', isStrict ? 'true' : 'false');
    policyCardBalanced?.classList.toggle('active', !isStrict);
    policyCardBalanced?.setAttribute('aria-checked', !isStrict ? 'true' : 'false');
  }

  function updateDependentControls() {
    const shieldOn = !!setAntiLeakShield?.checked;
    if (setAntiLeakPolicy) setAntiLeakPolicy.disabled = !shieldOn;
    policyRow?.classList.toggle('is-disabled', !shieldOn);

    if (policyCardStrict) {
      policyCardStrict.setAttribute('aria-disabled', shieldOn ? 'false' : 'true');
      policyCardStrict.setAttribute('tabindex', shieldOn ? '0' : '-1');
    }
    if (policyCardBalanced) {
      policyCardBalanced.setAttribute('aria-disabled', shieldOn ? 'false' : 'true');
      policyCardBalanced.setAttribute('tabindex', shieldOn ? '0' : '-1');
    }

    const autoOn = !!setAutoRefresh?.checked;
    if (setFastDetection) setFastDetection.disabled = !autoOn;
    fastDetectionRow?.classList.toggle('is-disabled', !autoOn);

    const notifOn = !!setNotifications?.checked;
    if (setNotifyIPv6) setNotifyIPv6.disabled = !notifOn;
    notifyIpv6Row?.classList.toggle('is-disabled', !notifOn);
  }

  function selectPolicy(val) {
    if (!setAntiLeakShield?.checked) return;
    if (setAntiLeakPolicy) setAntiLeakPolicy.value = val;
    syncPolicyCards(val);
    queueSave('antiLeakPolicy', val);
    updateDependentControls();
  }

  function applyField(key, settings) {
    const control = fields[key];
    if (!control) return;
    if (key === 'antiLeakPolicy') {
      const val = settings.antiLeakPolicy === 'default_public_interface_only'
        ? 'default_public_interface_only'
        : 'disable_non_proxied_udp';
      control.value = val;
      syncPolicyCards(val);
    } else {
      control.checked = OPT_IN.includes(key) ? settings[key] === true : settings[key] !== false;
    }
  }

  function applySettings(settings, skipPending = false) {
    for (const key of Object.keys(fields)) {
      if (skipPending && pendingCounts.has(key)) continue;
      applyField(key, settings);
    }
    if (!skipPending || !pendingCounts.has('badgeMode')) {
      const badgeMode = ['flag', 'text', 'off'].includes(settings.badgeMode) ? settings.badgeMode : 'flag';
      for (const radio of badgeRadios) radio.checked = radio.value === badgeMode;
    }
    if (!skipPending || !pendingCounts.has('optionsTheme')) {
      const theme = ['light', 'dark', 'system'].includes(settings.optionsTheme) ? settings.optionsTheme : 'light';
      for (const radio of themeRadios) radio.checked = radio.value === theme;
      window.leakHaloTheme?.apply(theme);
    }
    updateDependentControls();
  }

  function revertField(key) {
    if (key in fields) applyField(key, lastKnownSettings);
    else applySettings(lastKnownSettings, true);
    updateDependentControls();
  }

  function queueSave(key, value) {
    if (!pendingCounts.size) batchFailed = false;
    pendingCounts.set(key, (pendingCounts.get(key) || 0) + 1);
    setStatus('Saving…', 'saving');
    saveChain = saveChain.catch(() => {}).then(async () => {
      let failed = false;
      let shieldLimited = false;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch: { [key]: value } });
        if (response?.status !== 'ok') throw new Error('Browser setting update failed');
        if (response.settings) lastKnownSettings = response.settings;
        if (response.shieldEffective === false && (key === 'enableAntiLeakShield' || key === 'antiLeakPolicy') && lastKnownSettings.enableAntiLeakShield !== false) {
          shieldLimited = true;
        }
      } catch (error) {
        failed = true;
        batchFailed = true;
      } finally {
        const remaining = (pendingCounts.get(key) || 1) - 1;
        if (remaining) pendingCounts.set(key, remaining);
        else pendingCounts.delete(key);
        if (failed && !pendingCounts.has(key)) revertField(key);
        if (!pendingCounts.size) {
          if (batchFailed) {
            setStatus('Could not apply setting', 'error');
          } else if (shieldLimited) {
            setStatus('Protection limited by browser policy', 'warning');
          } else {
            setStatus('Saved', 'ready');
          }
        }
      }
    });
  }

  // Visual Policy Card selection (Click + Keyboard Accessibility)
  policyCardStrict?.addEventListener('click', () => selectPolicy('disable_non_proxied_udp'));
  policyCardBalanced?.addEventListener('click', () => selectPolicy('default_public_interface_only'));

  function handlePolicyCardKey(e, val) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      selectPolicy(val);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      policyCardBalanced?.focus();
      selectPolicy('default_public_interface_only');
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      policyCardStrict?.focus();
      selectPolicy('disable_non_proxied_udp');
    }
  }

  policyCardStrict?.addEventListener('keydown', (e) => handlePolicyCardKey(e, 'disable_non_proxied_udp'));
  policyCardBalanced?.addEventListener('keydown', (e) => handlePolicyCardKey(e, 'default_public_interface_only'));

  // Navigation Logic
  function positionNavIndicator(item) {
    if (!navIndicator) return;
    navIndicator.style.width = `${item.offsetWidth}px`;
    navIndicator.style.height = `${item.offsetHeight}px`;
    navIndicator.style.transform = `translateY(${item.offsetTop}px)`;
  }

  function setActiveNav(item) {
    const changed = !item.classList.contains('active') || item.getAttribute('aria-current') !== 'location';
    if (changed) {
      navItems.forEach((nav) => {
        nav.classList.toggle('active', nav === item);
        if (nav === item) nav.setAttribute('aria-current', 'location');
        else nav.removeAttribute('aria-current');
      });
    }
    positionNavIndicator(item);
    if (changed && window.innerWidth <= 960 && navMenu) {
      const menuRect = navMenu.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const left = navMenu.scrollLeft + itemRect.left - menuRect.left - (navMenu.clientWidth - item.clientWidth) / 2;
      navMenu.scrollTo({ left, behavior: scrollBehavior() });
    }
  }

  let navigationTarget = null;
  let navigationTimer = null;
  let bottomOverride = null;
  const isAtBottom = () => window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;

  function releaseNavigationTarget() {
    if (navigationTarget && isAtBottom() && navigationTarget !== sections[sections.length - 1]?.item) bottomOverride = navigationTarget;
    navigationTarget = null;
    clearTimeout(navigationTimer);
  }

  function updateActiveNavFromScroll() {
    if (!sections.length || navigationTarget) return;
    const atBottom = isAtBottom();
    if (bottomOverride && atBottom) {
      setActiveNav(bottomOverride);
      return;
    }
    bottomOverride = null;
    const marker = Math.min(window.innerHeight * 0.35, 220);
    let current = sections[0];
    for (const entry of sections) {
      if (entry.section && entry.section.getBoundingClientRect().top <= marker) current = entry;
    }
    setActiveNav(atBottom ? sections[sections.length - 1].item : current.item);
  }

  let scrollUpdateQueued = false;
  function queueNavUpdate() {
    if (scrollUpdateQueued) return;
    scrollUpdateQueued = true;
    requestAnimationFrame(() => {
      scrollUpdateQueued = false;
      updateActiveNavFromScroll();
    });
  }

  function goToSection(item, behavior = scrollBehavior()) {
    if (settingsSearch && settingsSearch.value.trim()) {
      settingsSearch.value = '';
      handleSearch('');
    }
    const target = sections.find((entry) => entry.item === item);
    if (!target) return;
    bottomOverride = null;
    navigationTarget = item;
    setActiveNav(item);
    target.section.scrollIntoView({ behavior, block: 'start' });
    clearTimeout(navigationTimer);
    navigationTimer = setTimeout(releaseNavigationTarget, behavior === 'auto' ? 50 : 800);
  }

  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      goToSection(item);
      const hash = item.getAttribute('href');
      if (hash && window.location.hash !== hash) history.replaceState(null, '', hash);
    });
  });

  window.addEventListener('scroll', queueNavUpdate, { passive: true });
  for (const evt of ['wheel', 'touchstart']) {
    window.addEventListener(evt, releaseNavigationTarget, { passive: true });
  }
  window.addEventListener('resize', () => {
    const current = navItems.find((nav) => nav.classList.contains('active')) || navItems[0];
    if (current) positionNavIndicator(current);
  });

  const initialHash = window.location.hash.toLowerCase();
  const initialItem = initialHash && navItems.find((item) => item.getAttribute('href')?.toLowerCase() === initialHash);
  if (initialItem) goToSection(initialItem, 'auto');
  else queueNavUpdate();
  requestAnimationFrame(() => requestAnimationFrame(() => navMenu?.classList.add('indicator-ready')));

  // Clear Stored Network Cache
  const clearDataBtn = document.getElementById('clearDataBtn');
  clearDataBtn?.addEventListener('click', async () => {
    if (!confirm('Clear cached IP addresses and network details saved in this browser?')) return;
    clearDataBtn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CLEAR_IP_DATA' });
      if (res?.status !== 'ok') throw new Error('Clear cache failed');
      setStatus('Route cache cleared', 'ready');
      clearDataBtn.textContent = 'Cache cleared';
      setTimeout(() => {
        clearDataBtn.disabled = false;
        clearDataBtn.textContent = 'Clear cache';
      }, 1500);
    } catch (e) {
      setStatus('Could not clear cache', 'error');
      clearDataBtn.disabled = false;
    }
  });

  // Export & Import JSON Config
  const exportConfigBtn = document.getElementById('exportConfigBtn');
  exportConfigBtn?.addEventListener('click', () => {
    const fullConfig = { ...DEFAULT_SETTINGS, ...lastKnownSettings };
    const blob = new Blob([JSON.stringify(fullConfig, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leakhalo-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Configuration exported');
  });

  const importConfigBtn = document.getElementById('importConfigBtn');
  const importConfigInput = document.getElementById('importConfigInput');
  importConfigBtn?.addEventListener('click', () => importConfigInput?.click());
  importConfigInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    saveChain = saveChain.catch(() => {}).then(async () => {
      try {
        if (file.size > 64 * 1024) throw new Error('File too large');
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JSON');
        const validChoices = {
          antiLeakPolicy: ['disable_non_proxied_udp', 'default_public_interface_only'],
          badgeMode: ['flag', 'text', 'off'],
          optionsTheme: ['light', 'dark', 'system']
        };
        const hasValidKey = Object.entries(parsed).some(([k, v]) => {
          if (!(k in DEFAULT_SETTINGS)) return false;
          if (k in validChoices) return validChoices[k].includes(v);
          return typeof v === 'boolean';
        });
        if (!hasValidKey) throw new Error('No valid settings found');
        setStatus('Importing settings…', 'saving');
        const response = await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', patch: parsed });
        if (response?.status !== 'ok') throw new Error('Import failed');
        lastKnownSettings = response.settings || { ...lastKnownSettings, ...parsed };
        applySettings(lastKnownSettings);
        if (response.shieldEffective === false && response.settings?.enableAntiLeakShield !== false) {
          setStatus('Protection limited by browser policy', 'warning');
        } else {
          setStatus('Settings imported', 'ready');
        }
      } catch (err) {
        setStatus('Failed to import configuration', 'error');
      } finally {
        importConfigInput.value = '';
      }
    });
  });

  // Reset to Defaults (Single Batch Update)
  const resetDefaultsBtn = document.getElementById('resetDefaultsBtn');
  resetDefaultsBtn?.addEventListener('click', async () => {
    if (!confirm('Restore all LeakHalo preferences to standard recommended defaults?')) return;
    resetDefaultsBtn.disabled = true;
    setStatus('Restoring defaults…', 'saving');
    saveChain = saveChain.catch(() => {}).then(async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'UPDATE_SETTINGS',
          patch: DEFAULT_SETTINGS
        });
        if (response?.status !== 'ok') throw new Error('Reset defaults failed');
        lastKnownSettings = response.settings || { ...DEFAULT_SETTINGS };
        applySettings(lastKnownSettings);
        if (response.shieldEffective === false && response.settings?.enableAntiLeakShield !== false) {
          setStatus('Protection limited by browser policy', 'warning');
        } else {
          setStatus('Restored defaults', 'ready');
        }
      } catch (e) {
        setStatus('Could not restore defaults', 'error');
      } finally {
        resetDefaultsBtn.disabled = false;
      }
    });
  });

  // Instant Settings Search
  function handleSearch(term) {
    const q = term.trim().toLowerCase();
    if (searchClearBtn) searchClearBtn.style.display = q ? 'grid' : 'none';
    if (searchKbd) searchKbd.style.display = q ? 'none' : '';

    const allRows = document.querySelectorAll('.setting-row, .badge-fieldset, .setting-subgroup');
    const allCallouts = document.querySelectorAll('.notification-callout');
    const allSections = document.querySelectorAll('.section-card');
    const aboutCards = document.querySelectorAll('.about-card');

    if (!q) {
      allRows.forEach((el) => el.classList.remove('is-hidden'));
      allCallouts.forEach((el) => el.classList.remove('is-hidden'));
      allSections.forEach((el) => el.classList.remove('is-hidden'));
      aboutCards.forEach((el) => el.classList.remove('is-hidden'));
      if (searchEmptyState) searchEmptyState.style.display = 'none';
      queueNavUpdate();
      return;
    }

    allRows.forEach((row) => {
      const searchAttr = row.getAttribute('data-search') || '';
      const text = row.textContent.toLowerCase();
      const match = searchAttr.includes(q) || text.includes(q);
      row.classList.toggle('is-hidden', !match);
    });

    allCallouts.forEach((callout) => {
      const visibleChildRows = callout.querySelectorAll('.setting-row:not(.is-hidden)');
      callout.classList.toggle('is-hidden', visibleChildRows.length === 0);
    });

    allSections.forEach((section) => {
      const visibleItems = section.querySelectorAll('.setting-row:not(.is-hidden), .badge-fieldset:not(.is-hidden), .setting-subgroup:not(.is-hidden)');
      const aboutCard = section.querySelector('.about-card');
      const aboutSearch = aboutCard ? (aboutCard.getAttribute('data-search') || '') : '';
      const aboutMatches = aboutCard && (aboutSearch.includes(q) || aboutCard.textContent.toLowerCase().includes(q));
      if (aboutCard) aboutCard.classList.toggle('is-hidden', !aboutMatches);
      const isVisible = visibleItems.length > 0 || aboutMatches;
      section.classList.toggle('is-hidden', !isVisible);
    });

    const anySectionVisible = [...allSections].some((s) => !s.classList.contains('is-hidden'));
    if (searchEmptyState) searchEmptyState.style.display = anySectionVisible ? 'none' : 'flex';

    const firstVisible = sections.find(({ section }) => section && !section.classList.contains('is-hidden'));
    if (firstVisible) setActiveNav(firstVisible.item);
  }

  settingsSearch?.addEventListener('input', (e) => handleSearch(e.target.value));
  searchClearBtn?.addEventListener('click', () => {
    if (settingsSearch) {
      settingsSearch.value = '';
      handleSearch('');
      settingsSearch.focus();
    }
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      settingsSearch?.focus();
      settingsSearch?.select();
    }
    if (e.key === 'Escape' && document.activeElement === settingsSearch) {
      settingsSearch.value = '';
      handleSearch('');
      settingsSearch.blur();
    }
  });

  // Change Listeners
  for (const [key, control] of Object.entries(fields)) {
    control.addEventListener('change', () => {
      if (['enableAntiLeakShield', 'enableAutoRefresh', 'enableNotifications'].includes(key)) updateDependentControls();
      queueSave(key, key === 'antiLeakPolicy' ? control.value : control.checked);
    });
  }
  for (const radio of badgeRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) queueSave('badgeMode', radio.value);
    });
  }
  for (const radio of themeRadios) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      window.leakHaloTheme?.apply(radio.value);
      queueSave('optionsTheme', radio.value);
    });
  }

  // Storage listener
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.appSettings) {
        lastKnownSettings = changes.appSettings.newValue || {};
        applySettings(lastKnownSettings, true);
      }
      if (changes.shieldEffective && !pendingCounts.size) {
        if (lastKnownSettings.enableAntiLeakShield !== false && changes.shieldEffective.newValue === false) {
          setStatus('Protection limited by browser policy', 'warning');
        } else {
          setStatus('Saved', 'ready');
        }
      }
    }
  });

  // Initial Data Load
  try {
    const res = await chrome.storage.local.get(['appSettings', 'shieldEffective']);
    lastKnownSettings = res.appSettings || {};
    applySettings(lastKnownSettings, true);
    if (!pendingCounts.size) {
      if (lastKnownSettings.enableAntiLeakShield !== false && res.shieldEffective === false) {
        setStatus('Protection limited by browser policy', 'warning');
      } else {
        setStatus('Saved', 'ready');
      }
    }
  } catch (error) {
    setStatus('Settings unavailable', 'error');
  }
});
