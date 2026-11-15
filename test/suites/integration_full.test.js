const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createChromeMock } = require('../harness/chrome_mock');
const { createClock, createDomEnvironment, DOMEvent, runExtensionScript } = require('../harness/dom_env');
const { createSuiteRunner } = require('../harness/test_runner');

const { test, run } = createSuiteRunner('FULL EXTENSION INTEGRATION SUITE (WORKER + UI)');

test('End-to-end synchronization across Background, Popup, Options, and Welcome over shared chrome bus', async () => {
  const clock = createClock();
  const mock = createChromeMock({
    initialLocal: {
      appSettings: { enableAutoRefresh: true, enableFastDetection: false, enableNotifications: true, badgeMode: 'flag' }
    }
  });

  let v4 = '198.51.100.10';
  let ipifyIp = '198.51.100.10';
  let v6 = '2001:db8::10';

  const makeFetch = () => async (url) => {
    const body = (obj, ok = true, status = 200) => ({
      ok, status,
      headers: { get: () => null },
      text: async () => typeof obj === 'string' ? obj : JSON.stringify(obj),
      json: async () => obj,
      blob: async () => ({ size: 32 })
    });
    if (url.startsWith('chrome-extension://')) return body('', true);
    if (url.startsWith('https://cloudflare.com/')) return body(`ip=${v4}\nloc=US\n`);
    if (url.startsWith('https://api.ipify.org')) return body({ ip: ipifyIp });
    if (url.startsWith('https://ipv6.icanhazip.com')) return body(`${v6}\n`);
    if (url.startsWith('https://ipwho.is/')) {
      if (url.includes('203.0.113.55')) {
        return body({ success: true, country_code: 'DE', country: 'Germany', city: 'Berlin', connection: { isp: 'AltISP', asn: 2 }, timezone: { id: 'Europe/Berlin' } });
      }
      if (url.includes('2001:db8::')) {
        return body({ success: true, country_code: 'FR', country: 'France', city: 'Paris', connection: { isp: 'V6ISP', asn: 3 }, timezone: { id: 'Europe/Paris' } });
      }
      return body({ success: true, country_code: 'US', country: 'United States', city: 'New York', region: 'NY', connection: { isp: 'TestISP', asn: 64500 }, timezone: { id: 'America/New_York' }, latitude: 40.71, longitude: -74.0 });
    }
    return body('', false, 404);
  };

  // 1. Boot real background service worker
  const bgCtx = {
    chrome: mock.chrome,
    AbortController, URL, TextDecoder, Uint8Array, Uint8ClampedArray, Intl, console,
    Date: clock.Date, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    navigator: { onLine: true },
    createImageBitmap: async () => ({ width: 48, height: 48, close() {} }),
    fetch: makeFetch(),
    addEventListener() {}
  };
  bgCtx.self = bgCtx;
  vm.createContext(bgCtx);
  runExtensionScript('background/background.js', bgCtx);
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', bgCtx);
  await clock.flush();

  // 2. Boot real Popup, Options, and Welcome pages sharing the SAME mock.chrome bus
  const popup = createDomEnvironment({ htmlRelPath: 'popup/popup.html', chrome: mock.chrome, clock });
  vm.createContext(popup.window);
  runExtensionScript('popup/popup.js', popup.window);
  popup.document.dispatchEvent(new DOMEvent('DOMContentLoaded', { bubbles: false }));

  const options = createDomEnvironment({ htmlRelPath: 'options/options.html', chrome: mock.chrome, clock });
  vm.createContext(options.window);
  runExtensionScript('options/theme.js', options.window);
  runExtensionScript('options/options.js', options.window);
  options.document.dispatchEvent(new DOMEvent('DOMContentLoaded', { bubbles: false }));

  const welcome = createDomEnvironment({ htmlRelPath: 'welcome/welcome.html', chrome: mock.chrome, clock });
  vm.createContext(welcome.window);
  runExtensionScript('welcome/land.js', welcome.window);
  runExtensionScript('welcome/welcome.js', welcome.window);

  await clock.runRafFrames(3);
  await clock.flush();

  // Verify initial live data synced to Popup and Welcome
  assert.equal(popup.document.getElementById('v4Ip').innerText, '198.51.100.10');
  assert.equal(popup.document.getElementById('splitBadge').style.display, 'inline-flex'); // US v4 vs FR v6
  assert.equal(welcome.document.getElementById('connectionV4').textContent, '198.51.100.10');
  assert.equal(welcome.document.getElementById('connectionCountry').textContent, 'United States');

  // 3. Toggle Armor OFF from Popup -> Background clears browser WebRTC policy -> Options reflects OFF
  popup.document.getElementById('shieldToggleBtn').click();
  await clock.flush();
  await clock.tick(150);
  assert.equal(mock.state.policyValue, 'default');
  assert.equal(options.document.getElementById('setAntiLeakShield').checked, false);
  assert.equal(welcome.document.getElementById('setAntiLeakShield').checked, false);

  // 4. Enable Route Divergence warning, Timezone & Text Badge from Options -> Background re-probes & updates toolbar -> Popup shows alerts
  ipifyIp = '203.0.113.55';
  options.document.getElementsByName('badgeMode')[1].click(); // 'text'
  options.document.getElementById('setShowTimeZone').click();
  options.document.getElementById('setRouteWarning').click();
  await clock.flush();
  // Second probe confirms divergence (2 consecutive mismatches)
  popup.document.getElementById('refreshBtn').click();
  await clock.flush();
  await clock.tick(700);

  assert.equal(mock.state.toolbar.badgeText, 'US');
  assert.equal(popup.document.getElementById('routeAlert').style.display, 'flex');
  assert.equal(popup.document.getElementById('v4TzRow').style.display, 'flex');

  // 5. Clear stored IP data from Options -> Background clears & re-probes cleanly
  options.document.getElementById('clearDataBtn').click();
  await clock.flush();
  await clock.tick(1600);
  assert.equal(popup.document.getElementById('v4Ip').innerText, '198.51.100.10');

  popup.window.dispatchEvent(new DOMEvent('pagehide', { bubbles: false }));
  welcome.window.dispatchEvent(new DOMEvent('pagehide', { bubbles: false }));
  clock.clearAll();
});

if (require.main === module) {
  run().then(r => process.exit(r.failed > 0 ? 1 : 0));
}

module.exports = { run };
