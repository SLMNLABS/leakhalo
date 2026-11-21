const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createChromeMock } = require('../harness/chrome_mock');
const { createClock, createDomEnvironment, DOMEvent, runExtensionScript } = require('../harness/dom_env');
const { createSuiteRunner } = require('../harness/test_runner');

const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const { test, run } = createSuiteRunner('POPUP FULL RUNTIME SUITE');

function createPopupHarness(opts = {}) {
  const clock = opts.clock || createClock();
  const mock = createChromeMock({
    initialLocal: opts.initialLocal || {
      latestV4Info: {
        ip: '198.51.100.22',
        countryCode: 'US',
        country: 'United States',
        city: 'New York',
        region: 'NY',
        isp: 'TestISP',
        asn: '64500',
        lat: 40.71,
        lon: -74.0,
        timezone: 'America/New_York'
      },
      latestV6Info: {
        ip: '2001:db8::1',
        countryCode: 'FR',
        country: 'France',
        city: 'Paris',
        region: 'IDF',
        isp: 'V6ISP',
        asn: '64501',
        lat: 48.85,
        lon: 2.35,
        timezone: 'Europe/Paris'
      },
      shieldEffective: true,
      appSettings: {
        enableAntiLeakShield: true,
        antiLeakPolicy: 'disable_non_proxied_udp',
        enableWebRtcScan: true,
        showMap: true,
        maskIp: false,
        showTimeZone: true,
        warnRouteDivergence: true
      }
    },
    ...opts
  });

  if (opts.storageGetReject) {
    mock.hooks.storageLocalGetReject = opts.storageGetReject;
  }

  mock.hooks.sendMessageHandler = async (msg) => {
    if (msg.type === 'UPDATE_SETTINGS') {
      const next = { ...(mock.state.localData.appSettings || {}), ...(msg.patch || {}) };
      await mock.chrome.storage.local.set({ appSettings: next });
      return { status: 'ok', settings: next };
    }
    if (msg.type === 'TOGGLE_SHIELD') {
      const next = { ...(mock.state.localData.appSettings || {}), enableAntiLeakShield: msg.explicitState };
      await mock.chrome.storage.local.set({ appSettings: next, shieldEffective: msg.explicitState });
      return { status: 'ok', settings: next, shieldEffective: msg.explicitState };
    }
    return { status: 'ok' };
  };

  const dom = createDomEnvironment({
    htmlRelPath: 'popup/popup.html',
    chrome: mock.chrome,
    clock
  });

  // Mock RTCPeerConnection for WebRTC leak check customization
  if (opts.rtcCandidates) {
    dom.window.RTCPeerConnection = class extends dom.window.RTCPeerConnection {
      async createOffer() {
        clock.setTimeout(() => {
          for (const cand of opts.rtcCandidates) {
            this.onicecandidate?.({ candidate: cand });
          }
          this.iceGatheringState = 'complete';
          this.onicegatheringstatechange?.();
        }, 5);
        return { type: 'offer', sdp: '' };
      }
    };
  }

  vm.createContext(dom.window);
  runExtensionScript('popup/popup.js', dom.window);

  return {
    ...dom,
    mock,
    async init() {
      dom.document.dispatchEvent(new DOMEvent('DOMContentLoaded', { bubbles: false }));
      await clock.flush();
      await clock.tick(50);
      await clock.flush();
    }
  };
}

test('popup.js initialization, rendering IPv4 / IPv6, flag loading, place formatting, bogon / private IP filtering, time zones, and copyable rows', async () => {
  const clock = createClock();
  const h = createPopupHarness({ clock });
  await h.init();

  // IPv4 card values
  assert.equal(h.document.getElementById('v4Ip').innerText, '198.51.100.22');
  assert.equal(h.document.getElementById('v4Country').innerText, 'United States');
  assert.match(h.document.getElementById('v4CityRegion').innerText, /New York/);
  assert.match(h.document.getElementById('v4Isp').innerText, /TestISP/);
  assert.equal(h.document.getElementById('v4TzRow').style.display, 'flex');

  // IPv6 card values
  assert.equal(h.document.getElementById('v6Ip').innerText, '2001:db8::1');
  assert.equal(h.document.getElementById('v6Country').innerText, 'France');

  // Flag image load & fallback onerror
  const v4Flag = h.document.getElementById('v4FlagImg');
  v4Flag.onerror?.();
  assert.match(v4Flag.src, /flag-us\.png/);
  v4Flag.onerror?.();
  assert.match(v4Flag.src, /icon48\.png/);

  // Map button
  const mapBtn = h.document.getElementById('v4MapBtn');
  assert.match(mapBtn.href, /openstreetmap\.org/);

  // Copy IPv4 row
  const v4Row = h.document.getElementById('v4IpRow');
  v4Row.click();
  await clock.flush();
  assert.equal(h.helpers.clipboardWrites.at(-1), '198.51.100.22');
  assert.match(h.document.getElementById('v4CopyStatus').textContent, /Copied/);
  await clock.tick(1700);
  assert.equal(h.document.getElementById('v4CopyStatus').textContent, 'Copy');

  // Copy via Enter and Space keydown
  v4Row.dispatchEvent(new DOMEvent('keydown', { key: 'Enter', bubbles: true }));
  await clock.flush();
  assert.equal(h.helpers.clipboardWrites.at(-1), '198.51.100.22');

  v4Row.dispatchEvent(new DOMEvent('keydown', { key: ' ', bubbles: true }));
  await clock.flush();
  assert.equal(h.helpers.clipboardWrites.at(-1), '198.51.100.22');

  // Clipboard failure handled cleanly
  h.helpers.setClipboardFail(true);
  v4Row.click();
  await clock.flush();
  h.helpers.setClipboardFail(false);

  clock.clearAll();
});

test('popup.js IPv6-only, IPv4-only, offline, probe error, and unverified route states', async () => {
  const clock = createClock();

  // 1. IPv6-only state
  const hV6Only = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: null,
      latestV6Info: {
        ip: '2001:db8::99', countryCode: 'DE', country: 'Germany', city: 'Frankfurt', isp: 'DE-ISP'
      },
      shieldEffective: true,
      appSettings: { maskIp: false }
    }
  });
  await hV6Only.init();
  assert.equal(hV6Only.document.getElementById('v4InactivePill').style.display, 'flex');
  assert.equal(hV6Only.document.getElementById('v6ActiveCard').style.display, 'block');

  // 2. IPv4-only state
  const hV4Only = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: {
        ip: '198.51.100.5', countryCode: 'CA', country: 'Canada', city: 'Toronto', isp: 'Rogers'
      },
      latestV6Info: null,
      shieldEffective: true
    }
  });
  await hV4Only.init();
  assert.equal(hV4Only.document.getElementById('v6ActiveCard').style.display, 'none');
  assert.equal(hV4Only.document.getElementById('v6InactivePill').style.display, 'flex');

  // 3. Offline state
  const hOffline = createPopupHarness({
    clock,
    initialLocal: {
      isOffline: true,
      latestV4Info: null,
      latestV6Info: null
    }
  });
  await hOffline.init();
  assert.equal(hOffline.document.getElementById('v4Ip').innerText, 'No Connection');
  assert.equal(hOffline.document.getElementById('v4Country').innerText, 'Offline');

  // 4. Probe Error state
  const hError = createPopupHarness({
    clock,
    initialLocal: {
      probeError: true,
      latestV4Info: null,
      latestV6Info: null
    }
  });
  await hError.init();
  assert.equal(hError.document.getElementById('v4Ip').innerText, 'Unavailable');

  // 5. Unverified state
  const hUnverified = createPopupHarness({
    clock,
    initialLocal: {
      v4Unverified: true,
      latestV4Info: {
        ip: '198.51.100.8', countryCode: 'NL', country: 'Netherlands'
      }
    }
  });
  await hUnverified.init();
  assert.match(hUnverified.document.getElementById('v4TypeTag').innerText, /Verifying|Unverified/);

  // 6. Datacenter connectionType tag
  const hType = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: {
        ip: '198.51.100.8', countryCode: 'US', country: 'United States', connectionType: 'Datacenter'
      }
    }
  });
  await hType.init();
  assert.equal(hType.document.getElementById('v4TypeTag').innerText, 'Datacenter');

  clock.clearAll();
});

test('popup.js WebRTC leak probe, security audit banner, shield toggle, and WebRTC action navigation', async () => {
  const clock = createClock();

  // Test WebRTC leak detected with external candidate under balanced policy
  const hLeak = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: { ip: '198.51.100.22', countryCode: 'US', country: 'United States' },
      latestV6Info: null,
      shieldEffective: true,
      appSettings: {
        enableAntiLeakShield: true,
        antiLeakPolicy: 'default_public_interface_only',
        enableWebRtcScan: true
      }
    },
    rtcCandidates: [
      { candidate: 'candidate:1 1 UDP 2130706431 203.0.113.88 54321 typ host', address: '203.0.113.88' },
      { candidate: 'candidate:2 1 UDP 2130706431 fe80::1 54321 typ host', address: 'fe80::1' },
      { candidate: 'candidate:3 1 UDP 2130706431 100::1 54321 typ host', address: '100::1' },
      { candidate: 'candidate:4 1 UDP 2130706431 ::1 54321 typ host', address: '::1' },
      { candidate: 'candidate:5 1 UDP 2130706431 fc00::1 54321 typ host', address: 'fc00::1' }
    ]
  });
  await hLeak.init();
  await clock.tick(150);
  await clock.flush();

  // Re-audit with identical signature while leaking (covers L779-782)
  const leakSettings = hLeak.mock.state.localData.appSettings;
  await hLeak.mock.chrome.storage.local.set({ appSettings: { ...leakSettings, showMap: false } });
  await clock.flush();

  // WebRTC row click when leaking (shield is on) -> calls openOptionsPage
  const webrtcItem = hLeak.document.getElementById('webrtcItem');
  webrtcItem.click();
  assert.equal(hLeak.mock.state.openedOptionsCount, 1);

  // WebRTC keydown Enter & Space
  webrtcItem.dispatchEvent(new DOMEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(hLeak.mock.state.openedOptionsCount, 2);

  // Shield Toggle Button Click
  const shieldBtn = hLeak.document.getElementById('shieldToggleBtn');
  shieldBtn.click();
  await clock.flush();

  // Shield Status Pill Click
  const shieldPill = hLeak.document.getElementById('shieldStatusPill');
  shieldPill.click();
  await clock.flush();

  // Mask IP button toggle
  const maskBtn = hLeak.document.getElementById('maskToggleBtn');
  maskBtn.click();
  await clock.flush();
  assert.match(hLeak.document.getElementById('v4Ip').innerText, /•••/);

  // Settings button click opens options
  const settingsBtn = hLeak.document.getElementById('settingsToggleBtn');
  settingsBtn.click();
  assert.equal(hLeak.mock.state.openedOptionsCount, 3);

  // Refresh button click triggers refresh
  let refreshed = false;
  hLeak.mock.hooks.sendMessageHandler = async (msg) => {
    if (msg.type === 'REFRESH_NOW') refreshed = true;
    return { status: 'ok' };
  };
  hLeak.document.getElementById('refreshBtn').click();
  await clock.flush();
  assert.equal(refreshed, true);

  clock.clearAll();
});

test('popup.js live storage updates, route divergence alerts, split routing badge, and page lifecycle events', async () => {
  const clock = createClock();
  const h = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: {
        ip: '198.51.100.1', countryCode: 'US', country: 'United States'
      },
      latestV6Info: {
        ip: '2001:db8::1', countryCode: 'FR', country: 'France'
      },
      shieldEffective: true,
      routeDivergence: {
        primaryIp: '198.51.100.1',
        primarySource: 'Cloudflare',
        alts: [
          {
            source: 'ipify',
            ip: '203.0.113.99',
            geo: { countryCode: 'DE', country: 'Germany' }
          }
        ]
      },
      appSettings: { warnRouteDivergence: true, showMap: false }
    }
  });
  await h.init();

  // Route divergence alert displayed
  assert.equal(h.document.getElementById('routeAlert').style.display, 'flex');
  assert.match(h.document.getElementById('routeAlertRows').textContent, /203\.0\.113\.99/);

  // Split routing badge (US v4 vs FR v6)
  assert.equal(h.document.getElementById('splitBadge').style.display, 'inline-flex');

  // Live storage update via chrome.storage.onChanged
  await h.mock.chrome.storage.local.set({
    latestV4Info: {
      ip: '198.51.100.50', countryCode: 'FR', country: 'France', city: 'Lyon'
    }
  });
  await clock.flush();
  assert.equal(h.document.getElementById('v4Ip').innerText, '198.51.100.50');
  // Both now France -> split badge hidden
  assert.equal(h.document.getElementById('splitBadge').style.display, 'none');

  // Window events: online, offline, visibilitychange, pagehide
  h.window.dispatchEvent(new DOMEvent('online', { bubbles: false }));
  h.window.dispatchEvent(new DOMEvent('offline', { bubbles: false }));
  h.document.dispatchEvent(new DOMEvent('visibilitychange', { bubbles: false }));
  h.window.dispatchEvent(new DOMEvent('pagehide', { bubbles: false }));

  clock.clearAll();
});

test('popup.js mask IPv6, paused background, time zone mismatch, connection tags, and edge branches', async () => {
  const clock = createClock();
  let tabsCreated = [];
  const h = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: {
        ip: '198.51.100.1', countryCode: 'US', country: 'United States', connectionType: 'Residential',
        timezone: 'Asia/Tokyo', updatedAt: Date.now() - 30_000
      },
      latestV6Info: {
        ip: '2001:db8::1', countryCode: 'US', country: 'United States', connectionType: 'Mobile',
        timezone: 'Asia/Tokyo', updatedAt: Date.now() - 30_000
      },
      appSettings: {
        enableAutoRefresh: false,
        maskIp: true,
        showTimeZone: true,
        enableWebRtcScan: false
      },
      shieldEffective: true
    }
  });

  // Mock tabs.create
  h.mock.chrome.tabs = {
    async create(opts) { tabsCreated.push(opts); }
  };
  delete h.mock.chrome.runtime.openOptionsPage;

  await h.init();

  // Masked IPv4 and IPv6
  assert.equal(h.document.getElementById('v4Ip').innerText, '198.51.•••.•••');
  assert.match(h.document.getElementById('v6Ip').innerText, /2001:db8:•••/);

  // Background paused label
  assert.equal(h.document.querySelector('.subbar-label').innerText, 'Background Paused');

  // Connection type tags
  assert.equal(h.document.getElementById('v4TypeTag').innerText, 'Residential');
  assert.equal(h.document.getElementById('v6TypeTag').innerText, 'Mobile');

  // Click settings icon -> fallback to tabs.create when openOptionsPage missing
  h.document.getElementById('settingsToggleBtn').click();
  assert(tabsCreated.length > 0);

  // Timestamp 30s ago
  await h.mock.chrome.storage.local.set({ lastCheckedAt: h.window.Date.now() - 30_000 });
  await clock.flush();
  assert.match(h.document.getElementById('lastUpdatedTime').innerText, /30s ago/);

  // Timestamp 2m ago
  await h.mock.chrome.storage.local.set({ lastCheckedAt: h.window.Date.now() - 120_000 });
  await clock.flush();
  assert.match(h.document.getElementById('lastUpdatedTime').innerText, /2m ago/);

  // Watermark onerror fallback
  const wm = h.document.getElementById('flagWatermark');
  if (wm && wm.onerror) {
    wm.onerror();
    if (wm.onerror) wm.onerror();
  }

  // Probe error connection tag -> 'Last known'
  await h.mock.chrome.storage.local.set({ probeError: true, isOffline: false });
  await clock.flush();
  assert.equal(h.document.getElementById('v4TypeTag').innerText, 'Last known');

  clock.clearAll();
});

test('popup.js webrtc shield off click, IPv4-mapped canonicalIp, and balanced protected state', async () => {
  const clock = createClock();
  const h = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: {
        ip: '::ffff:7f00:1', countryCode: 'US', timezone: 'UTC'
      },
      appSettings: {
        enableAntiLeakShield: false,
        enableWebRtcScan: true,
        antiLeakPolicy: 'default_public_interface_only',
        showTimeZone: true
      },
      shieldEffective: true
    }
  });

  await h.init();

  // 1. WebRTC row click while shield is OFF -> toggles shield
  const webrtcItem = h.document.getElementById('webrtcItem');
  webrtcItem.click();
  await clock.flush();

  // 2. Storage update with balanced mode and no leak -> protected state
  await h.mock.chrome.storage.local.set({
    appSettings: {
      enableAntiLeakShield: true,
      antiLeakPolicy: 'default_public_interface_only',
      enableWebRtcScan: true,
      showTimeZone: true
    },
    shieldEffective: true,
    latestV4Info: { ip: '198.51.100.1', countryCode: 'US', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
  });
  await clock.flush();
  await clock.tick(3000);
  await clock.flush();
  assert.equal(h.document.getElementById('webrtcStatus').innerText, 'Policy Active');

  // 3. Repeated audit with identical signature
  await h.mock.chrome.storage.local.set({
    lastCheckedAt: h.window.Date.now()
  });
  await clock.flush();

  // 4. Time zone with invalid zone -> caught gracefully
  await h.mock.chrome.storage.local.set({
    latestV4Info: { ip: '198.51.100.1', countryCode: 'US', timezone: 'Invalid/Zone/123' }
  });
  await clock.flush();

  // 5. Clean state when armor is OFF and candidate matches public exit IP
  const hClean = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: { ip: '198.51.100.1', countryCode: 'US' },
      appSettings: { enableAntiLeakShield: false, enableWebRtcScan: true }
    },
    rtcCandidates: [
      { candidate: 'candidate:1 1 UDP 1 198.51.100.1 5000 typ host', address: '198.51.100.1' }
    ]
  });
  await hClean.init();
  await clock.tick(3000);
  await clock.flush();
  assert.equal(hClean.document.getElementById('webrtcStatus').innerText, 'No Leak Seen');

  clock.clearAll();
});

test('popup.js deep edge branches: watermark fallback, custom country, rtc error, and concurrent check', async () => {
  const clock = createClock();

  // 1. Bogon non-standard IP and custom fallback country name (covers L290, L666, L679)
  const hEdge = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: {
        ip: 'invalid-ip-string',
        countryCode: 'AA',
        country: 'SomewhereLand'
      },
      appSettings: { enableAntiLeakShield: false, enableWebRtcScan: true }
    },
    rtcCandidates: [
      { candidate: 'candidate:1 1 UDP 1 not_hex:colon 5000 typ host', address: 'not_hex:colon' }
    ]
  });
  await hEdge.init();
  await clock.tick(3000);
  await clock.flush();
  const v4Country = hEdge.document.getElementById('v4Country');
  assert.equal(v4Country.textContent, 'SomewhereLand');

  // 2. Watermark flag image error retry then clear (covers L434-435)
  const wm = hEdge.document.getElementById('v4Watermark');
  if (wm && wm.onerror) {
    wm.onerror(); // switches to square fallback and sets next onerror
    wm.onerror(); // calls clearWatermark (L434-435)
  }

  // 3. WebRTC peer connection failure branch (covers L763)
  const hRtcErr = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: { ip: '198.51.100.1', countryCode: 'US' },
      appSettings: { enableAntiLeakShield: false, enableWebRtcScan: true }
    }
  });
  hRtcErr.window.RTCPeerConnection = function() { throw new Error('WebRTC error'); };
  await hRtcErr.init();
  await clock.tick(3000);
  await clock.flush();

  // 4. Concurrent forced network check & queuing (covers L1076-1077, L1086-1087)
  let finishPendingCheck;
  const hQueue = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: { ip: '198.51.100.1', countryCode: 'US' }
    }
  });
  hQueue.mock.hooks.sendMessageHandler = (msg) => {
    if (msg.type === 'CHECK_NETWORK') {
      return new Promise((resolve) => {
        finishPendingCheck = resolve;
      });
    }
    return { status: 'ok' };
  };
  await hQueue.init();
  hQueue.window.dispatchEvent(new DOMEvent('online'));
  assert.ok(finishPendingCheck);
  finishPendingCheck({ data: true });
  await clock.flush();
  await clock.tick(50);
  await clock.flush();

  clock.clearAll();
});

test('popup.js review prompt lifecycle, upgrade reprompt, actions, and dismissals', async () => {
  const clock = createClock();
  const DAY_MS = 86400 * 1000;
  const now = clock.now();
  const healthyV4 = { ip: '198.51.100.22', countryCode: 'US' };

  const [cMaj, cMin] = MANIFEST.version.split('.').map(Number);
  const currentMinor = `${cMaj}.${cMin}`;
  const nextMinor = `${cMaj}.${cMin + 1}`;
  const nextVersion = `${cMaj}.${cMin + 1}.0`;
  const nextMajorMinor = `${cMaj + 1}.0`;
  const nextMajorVersion = `${cMaj + 1}.0.0`;

  // 1. Fresh install: < 7 days elapsed or < 5 opens -> banner hidden
  const h1 = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: healthyV4,
      reviewPrompt: {
        installedAt: now - 3 * DAY_MS,
        trackedMinor: currentMinor,
        opensInMinor: 2,
        dismissCount: 0,
        dismissedAt: 0,
        dismissedMinor: '',
        completed: false
      }
    }
  });
  await h1.init();
  const nudge1 = h1.document.getElementById('reviewNudge');
  assert.equal(nudge1.style.display, 'none');

  // 2. Connection offline/error -> banner hidden even if >= 7 days and >= 5 opens
  const h2 = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: healthyV4,
      isOffline: true,
      reviewPrompt: {
        installedAt: now - 10 * DAY_MS,
        trackedMinor: currentMinor,
        opensInMinor: 5,
        dismissCount: 0,
        completed: false
      }
    }
  });
  await h2.init();
  const nudge2 = h2.document.getElementById('reviewNudge');
  assert.equal(nudge2.style.display, 'none');

  // 3. First prompt shown: >= 7 days, >= 5 opens, healthy connection
  const h3 = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: healthyV4,
      reviewPrompt: {
        installedAt: now - 8 * DAY_MS,
        trackedMinor: currentMinor,
        opensInMinor: 4, // init increments opens to 5
        dismissCount: 0,
        completed: false
      }
    }
  });
  await h3.init();
  const nudge3 = h3.document.getElementById('reviewNudge');
  const actionBtn3 = h3.document.getElementById('reviewActionBtn');
  assert.equal(nudge3.style.display, 'flex');
  assert.ok(actionBtn3.href.includes('/reviews'));

  // 4. Click action button -> completed: true, banner hidden, tab created
  actionBtn3.click();
  await clock.flush();
  assert.equal(nudge3.style.display, 'none');
  const savedState3 = h3.mock.state.localData.reviewPrompt;
  assert.equal(savedState3.completed, true);
  assert.equal(h3.mock.state.createdTabs.length, 1);
  assert.ok(h3.mock.state.createdTabs[0].url.includes('/reviews'));

  // 5. First dismissal: dismiss button clicked -> dismissCount = 1, dismissedMinor = currentMinor, opensInMinor = 0
  const h4 = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: healthyV4,
      reviewPrompt: {
        installedAt: now - 8 * DAY_MS,
        trackedMinor: currentMinor,
        opensInMinor: 5,
        dismissCount: 0,
        completed: false
      }
    }
  });
  await h4.init();
  const nudge4 = h4.document.getElementById('reviewNudge');
  const dismissBtn4 = h4.document.getElementById('reviewDismissBtn');
  assert.equal(nudge4.style.display, 'flex');
  dismissBtn4.click();
  assert.equal(nudge4.style.display, 'none');
  const savedState4 = h4.mock.state.localData.reviewPrompt;
  assert.equal(savedState4.dismissCount, 1);
  assert.equal(savedState4.dismissedMinor, currentMinor);
  assert.equal(savedState4.opensInMinor, 0);

  // 6. Dismissed once, 60 days pass, but same minor version -> banner stays hidden
  const h5 = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: healthyV4,
      reviewPrompt: {
        installedAt: now - 70 * DAY_MS,
        trackedMinor: currentMinor,
        opensInMinor: 15,
        dismissCount: 1,
        dismissedAt: now - 65 * DAY_MS,
        dismissedMinor: currentMinor,
        completed: false
      }
    }
  });
  await h5.init();
  const nudge5 = h5.document.getElementById('reviewNudge');
  assert.equal(nudge5.style.display, 'none');

  // 7. Dismissed once, upgraded to minor nextMinor, >= 60 days pass, >= 10 opens, healthy -> banner shown
  const h6 = createPopupHarness({
    clock,
    manifest: { version: nextVersion, name: 'LeakHalo' },
    initialLocal: {
      latestV4Info: healthyV4,
      reviewPrompt: {
        installedAt: now - 70 * DAY_MS,
        trackedMinor: nextMinor,
        opensInMinor: 9, // init increments opens to 10
        dismissCount: 1,
        dismissedAt: now - 65 * DAY_MS,
        dismissedMinor: currentMinor,
        completed: false
      }
    }
  });
  await h6.init();
  const nudge6 = h6.document.getElementById('reviewNudge');
  const dismissBtn6 = h6.document.getElementById('reviewDismissBtn');
  assert.equal(nudge6.style.display, 'flex');

  // 8. Second dismissal -> dismissCount = 2 (hard cap)
  dismissBtn6.click();
  assert.equal(nudge6.style.display, 'none');
  const savedState6 = h6.mock.state.localData.reviewPrompt;
  assert.equal(savedState6.dismissCount, 2);

  // Subsequent open on major upgrade nextMajorVersion never prompts again
  const h7 = createPopupHarness({
    clock,
    manifest: { version: nextMajorVersion, name: 'LeakHalo' },
    initialLocal: {
      latestV4Info: healthyV4,
      reviewPrompt: {
        installedAt: now - 100 * DAY_MS,
        trackedMinor: nextMajorMinor,
        opensInMinor: 50,
        dismissCount: 2,
        dismissedAt: now - 80 * DAY_MS,
        dismissedMinor: nextMinor,
        completed: false
      }
    }
  });
  await h7.init();
  const nudge7 = h7.document.getElementById('reviewNudge');
  assert.equal(nudge7.style.display, 'none');

  // 9. Edge case: missing chrome.runtime.id hides banner (covers L929-930)
  const hNoId = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: healthyV4,
      reviewPrompt: {
        installedAt: now - 8 * DAY_MS,
        trackedMinor: currentMinor,
        opensInMinor: 10,
        dismissCount: 0,
        completed: false
      }
    }
  });
  hNoId.window.chrome.runtime.id = '';
  await hNoId.init();
  const nudgeNoId = hNoId.document.getElementById('reviewNudge');
  assert.equal(nudgeNoId.style.display, 'none');

  clock.clearAll();
});

test('Route divergence flag fallback and forceCheckTimer debounce', async () => {
  const clock = createClock();
  const h = createPopupHarness({
    clock,
    initialLocal: {
      latestV4Info: {
        ip: '198.51.100.22',
        countryCode: 'US',
        country: 'United States',
        isp: 'Cloudflare',
        asn: '13335'
      },
      routeDivergence: {
        primarySource: 'Cloudflare',
        primaryIp: '198.51.100.22',
        alts: [
          {
            source: 'ipify',
            ip: '198.51.100.99',
            geo: { countryCode: 'DE', country: 'Germany' }
          }
        ]
      },
      appSettings: {
        enableAntiLeakShield: true,
        warnRouteDivergence: true
      }
    }
  });

  await h.init();

  // 1. Verify divergence flag image onerror fallback (L629)
  const flagImgs = h.document.querySelectorAll('#routeAlertRows img');
  assert.ok(flagImgs.length > 0, 'Divergence flag images rendered');
  const img = flagImgs[0];
  assert.equal(typeof img.onerror, 'function');
  assert.ok(img.src.includes('/assets/flags-rect/'));
  img.onerror();
  assert.equal(img.onerror, null);
  assert.ok(img.src.includes('/assets/flags/flag-'));

  // 2. Trigger rapid connection changes to exercise forceCheckTimer debounce window (L1075)
  const sentCheckMessages = [];
  h.mock.hooks.sendMessageHandler = async (msg) => {
    if (msg.type === 'CHECK_NETWORK') sentCheckMessages.push(msg);
    return { status: 'ok' };
  };

  h.window.dispatchEvent(new DOMEvent('online', { bubbles: false }));
  assert.equal(sentCheckMessages.length, 1, 'First check dispatched immediately');
  assert.equal(sentCheckMessages[0].force, true);
  await clock.flush();

  h.window.dispatchEvent(new DOMEvent('online', { bubbles: false }));
  assert.equal(sentCheckMessages.length, 1, 'Second check debounced in forceCheckTimer');

  await clock.tick(1500);
  await clock.flush();
  assert.equal(sentCheckMessages.length, 2, 'Second forced check executed after debounce timer');
  assert.equal(sentCheckMessages[1].force, true);

  clock.clearAll();
});

if (require.main === module) {
  run().then(r => process.exit(r.failed > 0 ? 1 : 0));
}

module.exports = { run };
