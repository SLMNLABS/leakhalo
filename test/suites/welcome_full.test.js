const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createChromeMock } = require('../harness/chrome_mock');
const { createClock, createDomEnvironment, DOMEvent, runExtensionScript } = require('../harness/dom_env');
const { createSuiteRunner } = require('../harness/test_runner');

const { test, run } = createSuiteRunner('WELCOME & ONBOARDING FULL SUITE');

function createWelcomeHarness(opts = {}) {
  const clock = opts.clock || createClock();
  const mock = createChromeMock({
    initialLocal: opts.initialLocal || {},
    isOnToolbar: opts.isOnToolbar ?? false,
    omitGetUserSettings: opts.omitGetUserSettings,
    omitUserSettingsChanged: opts.omitUserSettingsChanged,
    omitOpenPopup: opts.omitOpenPopup
  });

  if (opts.storageGetReject) mock.hooks.storageLocalGetReject = opts.storageGetReject;
  if (opts.getUserSettingsReject) mock.hooks.getUserSettingsReject = opts.getUserSettingsReject;
  if (opts.openPopupReject) mock.hooks.openPopupReject = opts.openPopupReject;
  if (opts.openOptionsReject) mock.hooks.openOptionsReject = opts.openOptionsReject;

  if (opts.sendMessageHandler) {
    mock.hooks.sendMessageHandler = opts.sendMessageHandler;
  } else {
    mock.hooks.sendMessageHandler = async (msg) => {
      if (msg.type === 'CHECK_NETWORK') return { status: 'ok', data: {} };
      if (msg.type === 'UPDATE_SETTINGS') {
        const next = { ...(mock.state.localData.appSettings || {}), ...(msg.patch || {}) };
        await mock.chrome.storage.local.set({ appSettings: next });
        const eff = opts.shieldEffective ?? (next.enableAntiLeakShield !== false);
        await mock.chrome.storage.local.set({ shieldEffective: eff });
        return { status: 'ok', settings: next, shieldEffective: eff };
      }
      return { status: 'ok' };
    };
  }

  const dom = createDomEnvironment({
    htmlRelPath: 'welcome/welcome.html',
    chrome: mock.chrome,
    clock,
    innerWidth: opts.innerWidth ?? 1280,
    clientWidth: opts.clientWidth ?? 1280,
    prefersReducedMotion: opts.prefersReducedMotion ?? false
  });

  if (opts.globeRect) {
    dom.document.getElementById('globe')._rect = opts.globeRect;
  }

  vm.createContext(dom.window);
  runExtensionScript('welcome/land.js', dom.window);
  runExtensionScript('welcome/welcome.js', dom.window);

  return {
    ...dom,
    mock,
    async init() {
      await clock.runRafFrames(2);
      await clock.flush();
    }
  };
}

test('welcome.js connection card states, country/ISP formatting, IPv6-only, masking, pending 20s timeout & 30s failure', async () => {
  const clock = createClock();
  const h = createWelcomeHarness({
    clock,
    initialLocal: {
      shieldEffective: true,
      latestV4Info: {
        ip: '198.51.100.10', countryCode: 'PS', country: '',
        city: 'Gaza', region: 'Gaza', isp: 'AS64500 Paltel', asn: '64500',
        lat: 31.5, lon: 34.46
      },
      latestV6Info: {
        ip: '2001:db8:1234::1', countryCode: 'DE', country: 'Germany', city: 'Berlin'
      },
      appSettings: { enableNotifications: true, enableFastDetection: true, enableAntiLeakShield: true, maskIp: false }
    }
  });
  await h.init();

  assert.equal(
    h.document.getElementById('appVersion').textContent,
    h.mock.chrome.runtime.getManifest().version
  );
  assert.match(h.document.querySelector('.chrome-menu-row span:nth-child(2)').textContent, /LeakHalo/);
  assert.equal(h.document.getElementById('connectionCard').dataset.state, 'live');
  assert.equal(h.document.getElementById('connectionCountry').textContent, 'Palestine');
  assert.equal(h.document.getElementById('connectionCity').textContent, 'Gaza');
  assert.equal(h.document.getElementById('connectionNetwork').textContent, 'Paltel (AS64500)');
  assert.equal(h.document.getElementById('connectionV6Location').textContent, 'Germany · Berlin');
  assert.equal(h.document.getElementById('connectionPolicy').textContent, 'Policy active');
  assert.equal(h.document.querySelector('.policy-label').dataset.active, 'true');
  assert.equal(h.document.getElementById('globeLabel').hidden, false);
  assert.match(h.document.getElementById('globeLabelText').textContent, /Gaza/);

  // Flag fallback onerror chain
  const flagImg = h.document.getElementById('connectionFlag');
  flagImg.onerror();
  assert.match(flagImg.src, /\/assets\/flags\/flag-ps\.png/);
  flagImg.onerror();
  assert.match(flagImg.src, /\/assets\/icons\/icon48\.png/);

  // IPv6-only + maskIp + null/0,0 coordinates
  await h.mock.chrome.storage.local.set({
    latestV4Info: null,
    latestV6Info: { ip: '2001:db8:abcd::1', countryCode: 'XX', country: 'FallbackName', city: '', isp: 'N/A', asn: 'N/A', lat: 0, lon: 0 },
    appSettings: { enableAntiLeakShield: false, maskIp: true }
  });
  await clock.flush();
  assert.equal(h.document.getElementById('primaryIpLabel').textContent, 'Public IPv6');
  assert.equal(h.document.getElementById('secondaryFactLabel').textContent, 'IPv4');
  assert.equal(h.document.getElementById('connectionV4').textContent, '2001:db8:•••');
  assert.equal(h.document.getElementById('connectionV6').textContent, 'Not detected');
  assert.equal(h.document.getElementById('connectionPolicy').textContent, 'WebRTC protection off');
  assert.equal(h.document.getElementById('globeLabel').hidden, true);

  // Pending state -> 20s locationTimedOut fallback
  await h.mock.chrome.storage.local.set({
    latestV4Info: { ip: '198.51.100.20', countryCode: '', pending: true, isp: 'N/A', asn: 'N/A' },
    latestV6Info: null
  });
  await clock.flush();
  assert.equal(h.document.getElementById('connectionCountry').textContent, 'Locating…');
  await clock.tick(20_500);
  assert.equal(h.document.getElementById('connectionCountry').textContent, 'Location unavailable');
  assert.equal(h.document.getElementById('connectionCity').textContent, 'Location lookup did not finish');

  // Offline & probeError states
  await h.mock.chrome.storage.local.set({ isOffline: true });
  await clock.flush();
  assert.equal(h.document.getElementById('connectionCard').dataset.state, 'offline');
  assert.equal(h.document.getElementById('copyIp').disabled, true);

  await h.mock.chrome.storage.local.set({ isOffline: false, probeError: true, shieldEffective: false, appSettings: { enableAntiLeakShield: true } });
  await clock.flush();
  assert.equal(h.document.getElementById('connectionCard').dataset.state, 'error');
  assert.equal(h.document.getElementById('connectionPolicy').textContent, 'Policy not verified');

  // 30s firstCheckTimer when storage & CHECK_NETWORK never produce an IP
  const hEmpty = createWelcomeHarness({ clock });
  await hEmpty.init();
  await clock.tick(30_500);
  assert.equal(hEmpty.document.getElementById('connectionCard').dataset.state, 'error');

  h.window.dispatchEvent(new DOMEvent('pagehide', { bubbles: false }));
  hEmpty.window.dispatchEvent(new DOMEvent('pagehide', { bubbles: false }));
  clock.clearAll();
});

test('welcome.js globe rendering, reducedMotion, resize/visibility, copy IP, setup switches, pin coach & actions', async () => {
  const clock = createClock();
  const h = createWelcomeHarness({
    clock,
    clientWidth: 1200,
    globeRect: { left: 1120, top: 100, width: 300, height: 300 }, // forces right-edge label flip
    initialLocal: {
      shieldEffective: true,
      latestV4Info: { ip: '198.51.100.30', countryCode: 'FR', country: 'France', city: 'Paris', isp: 'Orange', lat: 48.85, lon: 2.35 },
      appSettings: { enableNotifications: true, enableFastDetection: true, enableAntiLeakShield: true }
    }
  });
  await h.init();

  // Globe ResizeObserver, rAF animation frames, visibilitychange, reducedMotion change
  h.helpers.resizeObservers[0]?.trigger();
  await clock.runRafFrames(3, 40);
  h.window.dispatchEvent(new DOMEvent('resize', { bubbles: false }));
  h.helpers.getMediaQuery('(prefers-reduced-motion: reduce)').setMatches(true);
  h.document.visibilityState = 'visible';
  h.document.dispatchEvent(new DOMEvent('visibilitychange', { bubbles: false }));

  // Copy IP success + 1600ms reset + clipboard failure
  const copyBtn = h.document.getElementById('copyIp');
  copyBtn.click();
  await clock.flush();
  assert.equal(h.helpers.clipboardWrites.at(-1), '198.51.100.30');
  assert.equal(h.document.getElementById('copyLabel').textContent, 'Copied');
  await clock.tick(1700);
  assert.equal(h.document.getElementById('copyLabel').textContent, 'Copy');

  h.helpers.setClipboardFail(true);
  copyBtn.click();
  await clock.flush();
  assert.equal(h.document.getElementById('copyLabel').textContent, 'Copy failed');
  await clock.tick(1700);

  // Setup toggle switches: batching + error state
  h.document.getElementById('setNotifications').click();
  h.document.getElementById('setAntiLeakShield').click();
  await clock.flush();
  assert.equal(h.document.getElementById('saveStatus').textContent, 'Saved in this browser');

  const origMsg = h.mock.hooks.sendMessageHandler;
  h.mock.hooks.sendMessageHandler = async () => ({ status: 'error' });
  h.document.getElementById('setFastDetection').click();
  await clock.flush();
  assert.equal(h.document.getElementById('saveStatus').dataset.state, 'error');
  h.mock.hooks.sendMessageHandler = origMsg;

  // Pin coach: live onUserSettingsChanged -> pinned true -> openPopup success & error
  assert.equal(h.document.getElementById('pinCard').dataset.pinned, 'false');
  h.mock.state.isOnToolbar = true;
  assert.equal(h.document.getElementById('pinCard').dataset.pinned, 'true');
  assert.equal(h.document.getElementById('pinFinalStep').getAttribute('aria-current'), 'step');

  h.document.getElementById('openPopup').click();
  await clock.flush();
  assert.equal(h.mock.state.openedPopupCount, 1);

  h.mock.hooks.openPopupReject = new Error('no popup');
  h.document.getElementById('openPopup').click();
  await clock.flush();
  assert.match(h.document.getElementById('popupHelp').textContent, /Click the LeakHalo icon in your toolbar/);

  // [data-options] links: success & error
  const optLinks = h.document.querySelectorAll('[data-options]');
  optLinks[0].click();
  await clock.flush();
  assert.equal(h.mock.state.openedOptionsCount, 1);
  h.mock.hooks.openOptionsReject = new Error('cannot open');
  optLinks[1].click();
  await clock.flush();
  assert.equal(h.document.getElementById('saveStatus').dataset.state, 'error');

  // Dismiss pin guide
  h.document.getElementById('pinCloseBtn').click();
  assert.equal(h.document.getElementById('pinCard').hidden, true);

  // Pin polling fallback (without onUserSettingsChanged) & pin unknown (without getUserSettings)
  const hPoll = createWelcomeHarness({ clock, omitUserSettingsChanged: true });
  await hPoll.init();
  await clock.tick(1600);
  hPoll.mock.hooks.getUserSettingsReject = new Error('unsupported');
  await clock.tick(1600);
  assert.equal(hPoll.document.getElementById('pinCard').dataset.pinned, 'unknown');

  const hNoPin = createWelcomeHarness({
    clock,
    omitGetUserSettings: true,
    omitOpenPopup: true,
    storageGetReject: new Error('storage error'),
    sendMessageHandler: async () => { throw new Error('worker dead'); }
  });
  await hNoPin.init();
  assert.equal(hNoPin.document.getElementById('pinCard').dataset.pinned, 'unknown');
  hNoPin.document.getElementById('openPopup').click();
  await clock.flush();
  assert.match(hNoPin.document.getElementById('popupHelp').textContent, /puzzle icon/);

  h.window.dispatchEvent(new DOMEvent('pagehide', { bubbles: false }));
  hPoll.window.dispatchEvent(new DOMEvent('pagehide', { bubbles: false }));
  hNoPin.window.dispatchEvent(new DOMEvent('pagehide', { bubbles: false }));
  clock.clearAll();
});

if (require.main === module) {
  run().then(r => process.exit(r.failed > 0 ? 1 : 0));
}

module.exports = { run };
