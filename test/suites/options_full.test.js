const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createChromeMock } = require('../harness/chrome_mock');
const { createClock, createDomEnvironment, DOMEvent, runExtensionScript } = require('../harness/dom_env');
const { createSuiteRunner } = require('../harness/test_runner');

const { test, run } = createSuiteRunner('OPTIONS & THEME FULL SUITE');

function createOptionsHarness(opts = {}) {
  const clock = opts.clock || createClock();
  const mock = createChromeMock({
    initialLocal: opts.initialLocal || {
      appSettings: {
        enableAntiLeakShield: true,
        antiLeakPolicy: 'disable_non_proxied_udp',
        enableNotifications: true,
        notifyIPv6: true,
        enableAutoRefresh: true,
        autoRefreshInterval: 5,
        enableFastDetection: false,
        badgeMode: 'flag',
        maskIp: false,
        warnRouteDivergence: false,
        showTimeZone: false,
        providerChoice: 'cloudflare',
        optionsTheme: 'system'
      },
      shieldEffective: true
    },
    ...opts
  });

  if (opts.storageGetReject) {
    mock.hooks.storageLocalGetReject = opts.storageGetReject;
  }

  if (opts.sendMessageHandler) {
    mock.hooks.sendMessageHandler = opts.sendMessageHandler;
  } else {
    mock.hooks.sendMessageHandler = async (msg) => {
      if (msg.type === 'UPDATE_SETTINGS') {
        const next = { ...(mock.state.localData.appSettings || {}), ...(msg.patch || {}) };
        await mock.chrome.storage.local.set({ appSettings: next });
        const eff = opts.shieldEffective ?? (next.enableAntiLeakShield !== false);
        await mock.chrome.storage.local.set({ shieldEffective: eff });
        return { status: 'ok', settings: next, shieldEffective: eff };
      }
      if (msg.type === 'CLEAR_IP_DATA') {
        await mock.chrome.storage.local.remove(['latestV4Info', 'latestV6Info']);
        return { status: 'ok' };
      }
      return { status: 'ok' };
    };
  }

  const dom = createDomEnvironment({
    htmlRelPath: 'options/options.html',
    chrome: mock.chrome,
    clock,
    initialLocalStorage: opts.initialLocalStorage || {},
    prefersDark: opts.prefersDark ?? false,
    clientWidth: opts.clientWidth ?? 1024,
    innerWidth: opts.innerWidth ?? 1024
  });

  vm.createContext(dom.window);
  runExtensionScript('options/theme.js', dom.window);
  runExtensionScript('options/options.js', dom.window);

  return {
    ...dom,
    mock,
    async init() {
      dom.document.dispatchEvent(new DOMEvent('DOMContentLoaded', { bubbles: false }));
      await clock.flush();
    }
  };
}

test('theme.js theme resolution, prefers-color-scheme listener, theme-switching class, and invalid/throwing storage', async () => {
  const clock = createClock();
  const h = createOptionsHarness({
    clock,
    initialLocal: { appSettings: { optionsTheme: 'system' }, shieldEffective: true },
    initialLocalStorage: { optionsTheme: 'system' },
    prefersDark: false
  });

  assert.equal(h.document.documentElement.dataset.theme, 'light');

  // Change prefers-color-scheme media query
  h.helpers.getMediaQuery('(prefers-color-scheme: dark)').setMatches(true);
  assert.equal(h.document.documentElement.dataset.theme, 'dark');

  // First paint via DOMContentLoaded + rAF
  h.document.dispatchEvent(new DOMEvent('DOMContentLoaded', { bubbles: false }));
  await clock.runRafFrames(1);

  // Switch to light explicitly -> theme-switching class applied
  h.window.leakHaloTheme.apply('light');
  assert.equal(h.document.documentElement.dataset.theme, 'light');
  assert.equal(h.document.documentElement.classList.contains('theme-switching'), true);
  await clock.runRafFrames(2);
  assert.equal(h.document.documentElement.classList.contains('theme-switching'), false);

  // Invalid theme value falls back to light
  h.window.leakHaloTheme.apply('invalid-theme-value');
  assert.equal(h.document.documentElement.dataset.theme, 'light');

  // Direct switch to dark
  h.window.leakHaloTheme.apply('dark');
  assert.equal(h.document.documentElement.dataset.theme, 'dark');

  // Throwing localStorage handled gracefully
  const brokenStorage = createDomEnvironment({ clock, prefersDark: false });
  brokenStorage.window.localStorage = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); }
  };
  vm.createContext(brokenStorage.window);
  runExtensionScript('options/theme.js', brokenStorage.window);
  assert.equal(brokenStorage.document.documentElement.dataset.theme, 'light');
  brokenStorage.window.leakHaloTheme.apply('dark');
  assert.equal(brokenStorage.document.documentElement.dataset.theme, 'dark');
  clock.clearAll();
});

test('options.js initialization, policy cards (strict/balanced), dependent controls, and live storage sync', async () => {
  const clock = createClock();
  const h = createOptionsHarness({
    clock,
    initialLocal: {
      appSettings: {
        enableAntiLeakShield: true,
        antiLeakPolicy: 'disable_non_proxied_udp',
        enableNotifications: true,
        notifyIPv6: true,
        enableAutoRefresh: true,
        autoRefreshInterval: 5,
        enableFastDetection: false,
        badgeMode: 'flag',
        maskIp: false,
        warnRouteDivergence: false,
        showTimeZone: false,
        providerChoice: 'cloudflare',
        optionsTheme: 'system'
      },
      shieldEffective: true
    }
  });
  await h.init();

  const strictCard = h.document.getElementById('policyCardStrict');
  const balancedCard = h.document.getElementById('policyCardBalanced');
  assert.equal(strictCard.getAttribute('aria-checked'), 'true');
  assert.equal(balancedCard.getAttribute('aria-checked'), 'false');

  // Balanced card click
  balancedCard.click();
  await clock.flush();
  assert.equal(balancedCard.getAttribute('aria-checked'), 'true');
  assert.equal(strictCard.getAttribute('aria-checked'), 'false');
  assert.equal(h.mock.state.localData.appSettings.antiLeakPolicy, 'default_public_interface_only');

  // Keyboard navigation on policy cards (Enter and Space)
  strictCard.dispatchEvent(new DOMEvent('keydown', { key: 'Enter', bubbles: true }));
  await clock.flush();
  assert.equal(strictCard.getAttribute('aria-checked'), 'true');

  balancedCard.dispatchEvent(new DOMEvent('keydown', { key: ' ', bubbles: true }));
  await clock.flush();
  assert.equal(balancedCard.getAttribute('aria-checked'), 'true');

  // Toggle armor OFF -> policy cards disabled
  const armorSwitch = h.document.getElementById('setAntiLeakShield');
  armorSwitch.click();
  await clock.flush();
  assert.equal(armorSwitch.checked, false);
  const policyGroup = h.document.querySelector('.setting-subgroup');
  assert.equal(policyGroup.classList.contains('is-disabled'), true);

  // Toggle auto-refresh OFF -> fast detection disabled
  const autoRefreshSwitch = h.document.getElementById('setAutoRefresh');
  autoRefreshSwitch.click();
  await clock.flush();
  assert.equal(autoRefreshSwitch.checked, false);
  assert.equal(h.document.getElementById('setFastDetection').disabled, true);
  assert.equal(h.document.getElementById('fastDetectionRow').classList.contains('is-disabled'), true);

  // Toggle notifications OFF -> notify IPv6 row disabled
  const notifSwitch = h.document.getElementById('setNotifications');
  notifSwitch.click();
  await clock.flush();
  assert.equal(notifSwitch.checked, false);
  assert.equal(h.document.getElementById('setNotifyIPv6').disabled, true);
  assert.equal(h.document.getElementById('notifyIpv6Row').classList.contains('is-disabled'), true);

  // Live storage sync
  await h.mock.chrome.storage.local.set({ shieldEffective: true });
  await clock.flush();
  await h.mock.chrome.storage.local.set({
    appSettings: {
      enableAntiLeakShield: true,
      antiLeakPolicy: 'disable_non_proxied_udp',
      enableNotifications: true,
      enableAutoRefresh: true,
      optionsTheme: 'dark'
    },
    shieldEffective: false
  });
  await clock.flush();
  assert.equal(h.document.getElementById('setAntiLeakShield').checked, true);
  assert.equal(h.document.getElementById('saveToast').textContent, 'Protection limited by browser policy');

  // Storage error on load branch
  const hErr = createOptionsHarness({
    clock,
    storageGetReject: new Error('storage read failed')
  });
  await hErr.init();
  assert.equal(hErr.document.getElementById('saveToast').dataset.state, 'error');
  clock.clearAll();
});

test('options.js navigation scroll/resize, search filter & clear, Escape & keyboard shortcuts', async () => {
  const clock = createClock();
  const h = createOptionsHarness({ clock });
  await h.init();

  // Navigation items click & indicator update
  const navItems = h.document.querySelectorAll('.nav-item');
  assert(navItems.length > 0);
  navItems[1].click();
  assert.equal(navItems[1].classList.contains('active'), true);

  // Scroll event & resize event
  h.window.dispatchEvent(new DOMEvent('scroll', { bubbles: false }));
  await clock.runRafFrames(1);
  h.window.dispatchEvent(new DOMEvent('resize', { bubbles: false }));

  // Search for 'dns prefetch' -> section 01 visible, #about hidden
  const search = h.document.getElementById('settingsSearch');
  search.value = 'dns prefetch';
  search.dispatchEvent(new DOMEvent('input', { bubbles: true }));
  assert.equal(h.document.getElementById('about').classList.contains('is-hidden'), true);
  assert.equal(h.document.getElementById('searchClearBtn').style.display, 'grid');

  // Clear search via clear button
  h.document.getElementById('searchClearBtn').click();
  assert.equal(h.document.getElementById('settingsSearch').value, '');
  assert.equal(h.document.getElementById('about').classList.contains('is-hidden'), false);

  // Search for non-existent query -> shows search empty state
  search.value = 'zzzznonexistentterm';
  search.dispatchEvent(new DOMEvent('input', { bubbles: true }));
  assert.equal(h.document.getElementById('searchEmptyState').style.display, 'flex');

  // Clear search via nav click
  search.value = 'dns prefetch';
  navItems[2].click();
  assert.equal(search.value, '');

  // Keyboard shortcut Ctrl+K
  h.window.dispatchEvent(new DOMEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  assert.equal(h.document.activeElement, search);

  // Keyboard shortcut Escape in search
  h.window.dispatchEvent(new DOMEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(search.value, '');

  // Policy cards arrow key navigation
  const strictCard = h.document.getElementById('policyCardStrict');
  const balancedCard = h.document.getElementById('policyCardBalanced');
  strictCard.dispatchEvent(new DOMEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await clock.flush();
  balancedCard.dispatchEvent(new DOMEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await clock.flush();

  // Wheel event for scroll release
  h.window.dispatchEvent(new DOMEvent('wheel', { bubbles: false }));

  clock.clearAll();
});

test('options.js settings changes, save queue retry/revert, clear IP data, reset defaults, and JSON export/import', async () => {
  const clock = createClock();
  const h = createOptionsHarness({ clock });
  await h.init();

  // Checkbox toggle: notifyIPv6
  const notifyV6 = h.document.getElementById('setNotifyIPv6');
  notifyV6.click();
  await clock.flush();
  assert.equal(notifyV6.checked, false);

  // Radio button change: theme radio
  const themeDark = h.document.querySelector('input[name="optionsTheme"][value="dark"]');
  themeDark.click();
  await clock.flush();
  assert.equal(themeDark.checked, true);
  assert.equal(h.document.documentElement.dataset.theme, 'dark');

  // Save failure reverts field
  const origHandler = h.mock.hooks.sendMessageHandler;
  h.mock.hooks.sendMessageHandler = async () => ({ status: 'error' });
  const showMap = h.document.getElementById('setShowMap');
  const prevChecked = showMap.checked;
  showMap.click();
  await clock.flush();
  assert.equal(showMap.checked, prevChecked);
  assert.equal(h.document.getElementById('saveToast').dataset.state, 'error');
  h.mock.hooks.sendMessageHandler = origHandler;

  // Clear IP Data button
  h.document.getElementById('clearDataBtn').click();
  await clock.flush();
  assert.equal(h.document.getElementById('saveToast').textContent, 'Route cache cleared');

  // Clear IP Data failure
  h.mock.hooks.sendMessageHandler = async () => { throw new Error('fail'); };
  h.document.getElementById('clearDataBtn').click();
  await clock.flush();
  assert.equal(h.document.getElementById('saveToast').dataset.state, 'error');
  h.mock.hooks.sendMessageHandler = origHandler;

  // Export configuration
  h.document.getElementById('exportConfigBtn').click();
  await clock.tick(1100);
  assert.equal(h.document.getElementById('saveToast').textContent, 'Configuration exported');

  // Import configuration: valid JSON
  const importInput = h.document.getElementById('importConfigInput');
  const validFile = {
    size: 200,
    text: async () => JSON.stringify({ enableAntiLeakShield: true, badgeMode: 'text' })
  };
  importInput.files = [validFile];
  importInput.dispatchEvent(new DOMEvent('change', { bubbles: true }));
  await clock.flush();
  assert.equal(h.document.getElementById('saveToast').textContent, 'Settings imported');

  // Import configuration: invalid file (too large)
  const largeFile = { size: 100_000, text: async () => '{}' };
  importInput.files = [largeFile];
  importInput.dispatchEvent(new DOMEvent('change', { bubbles: true }));
  await clock.flush();
  assert.equal(h.document.getElementById('saveToast').textContent, 'Failed to import configuration');

  // Import configuration: invalid JSON
  const corruptFile = { size: 50, text: async () => 'invalid-json' };
  importInput.files = [corruptFile];
  importInput.dispatchEvent(new DOMEvent('change', { bubbles: true }));
  await clock.flush();
  assert.equal(h.document.getElementById('saveToast').textContent, 'Failed to import configuration');

  // Reset defaults button
  h.document.getElementById('resetDefaultsBtn').click();
  await clock.flush();
  assert.equal(h.document.getElementById('saveToast').textContent, 'Restored defaults');

  // Reset defaults canceled by confirm
  h.window.confirm = () => false;
  h.document.getElementById('resetDefaultsBtn').click();
  await clock.flush();

  // Links click
  h.document.getElementById('btnPrivacyPolicy')?.click();
  h.document.getElementById('btnReportIssue')?.click();
  h.document.getElementById('btnRateExtension')?.click();

  clock.clearAll();
});

test('options.js Mac platform detection, warning status, and revertField fallback', async () => {
  const clock = createClock();
  const hMac = createOptionsHarness({
    clock,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
  });
  hMac.window.navigator.platform = 'MacIntel';
  await hMac.init();
  assert.equal(hMac.document.getElementById('searchKbd').textContent, '⌘K');

  // Import configuration with shieldEffective: false
  const importInput = hMac.document.getElementById('importConfigInput');
  hMac.mock.hooks.sendMessageHandler = async () => ({
    status: 'ok',
    settings: { enableAntiLeakShield: true },
    shieldEffective: false
  });
  importInput.files = [{ size: 100, text: async () => JSON.stringify({ enableAntiLeakShield: true }) }];
  importInput.dispatchEvent(new DOMEvent('change', { bubbles: true }));
  await clock.flush();
  assert.equal(hMac.document.getElementById('saveToast').textContent, 'Protection limited by browser policy');

  // Reset defaults with shieldEffective: false
  hMac.document.getElementById('resetDefaultsBtn').click();
  await clock.flush();
  assert.equal(hMac.document.getElementById('saveToast').textContent, 'Protection limited by browser policy');

  // Reset defaults with failure
  hMac.mock.hooks.sendMessageHandler = async () => ({ status: 'error' });
  hMac.document.getElementById('resetDefaultsBtn').click();
  await clock.flush();
  assert.equal(hMac.document.getElementById('saveToast').textContent, 'Could not restore defaults');

  clock.clearAll();
});

test('options.js deep edge branches: initial limited policy, revert non-field radio, and bottom override scroll', async () => {
  const clock = createClock();

  // 1. Initial storage with shieldEffective: false (covers L552)
  const hInitLimited = createOptionsHarness({
    clock,
    initialLocal: {
      appSettings: { enableAntiLeakShield: true, antiLeakPolicy: 'disable_non_proxied_udp' },
      shieldEffective: false
    }
  });
  await hInitLimited.init();
  assert.equal(hInitLimited.document.getElementById('saveToast').textContent, 'Protection limited by browser policy');

  // 2. Radio save error reverts non-fields setting (covers L170)
  const h = createOptionsHarness({ clock });
  await h.init();
  h.mock.hooks.sendMessageHandler = async () => ({ status: 'error' });
  const radioOff = h.document.querySelector('input[name="badgeMode"][value="off"]');
  radioOff.click();
  await clock.flush();
  assert.equal(h.document.getElementById('saveToast').dataset.state, 'error');

  // 3. Card policy save returning shieldEffective: false (covers L186, L200)
  h.mock.hooks.sendMessageHandler = async () => ({
    status: 'ok',
    settings: { enableAntiLeakShield: true, antiLeakPolicy: 'default_public_interface_only' },
    shieldEffective: false
  });
  const balancedCard = h.document.getElementById('policyCardBalanced');
  balancedCard.click();
  await clock.flush();
  assert.equal(h.document.getElementById('saveToast').textContent, 'Protection limited by browser policy');

  // 4. Scroll bottomOverride branch (covers L272-273)
  const navItems = h.document.querySelectorAll('.nav-item');
  navItems[0].click();
  h.window.scrollY = 2000;
  h.window.innerHeight = 1000;
  h.document.documentElement.scrollHeight = 2990;
  // wheel event releases navigationTarget while at bottom, setting bottomOverride
  h.window.dispatchEvent(new DOMEvent('wheel', { bubbles: false }));
  // scroll event then finds bottomOverride && atBottom
  h.window.dispatchEvent(new DOMEvent('scroll', { bubbles: false }));
  await clock.runRafFrames(1);

  clock.clearAll();
});

test('options.js policy card click, import config trigger, and initial hash navigation', async () => {
  const clock = createClock();

  // 1. Initial Hash navigation (L332-334)
  const hHash = createOptionsHarness({ clock });
  hHash.window.location.hash = '#notifications';
  await hHash.init();
  const notifNav = hHash.document.querySelector('.nav-item[href="#notifications"]');
  assert.ok(notifNav?.classList.contains('active'), 'Navigation item active from initial hash');

  // 2. Strict policy card click (L215)
  const h = createOptionsHarness({
    clock,
    initialLocal: {
      appSettings: { antiLeakPolicy: 'default_public_interface_only', enableAntiLeakShield: true },
      shieldEffective: true
    }
  });
  await h.init();
  const strictCard = h.document.getElementById('policyCardStrict');
  assert.equal(strictCard.getAttribute('aria-checked'), 'false');
  strictCard.click();
  await clock.flush();
  assert.equal(strictCard.getAttribute('aria-checked'), 'true');

  // 3. Import config button triggers file input click (L374)
  const importBtn = h.document.getElementById('importConfigBtn');
  const importInput = h.document.getElementById('importConfigInput');
  let inputClicked = false;
  importInput.click = () => { inputClicked = true; };
  importBtn.click();
  assert.equal(inputClicked, true, 'importConfigInput.click() invoked by import button');

  clock.clearAll();
});

if (require.main === module) {
  run().then(r => process.exit(r.failed > 0 ? 1 : 0));
}

module.exports = { run };
