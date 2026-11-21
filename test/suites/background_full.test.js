const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSuiteRunner } = require('../harness/test_runner');
const { OffscreenCanvas } = require('../harness/dom_env');

const { test, run } = createSuiteRunner('BACKGROUND SERVICE WORKER FULL SUITE');
const ROOT = path.resolve(__dirname, '../..');
const BG_SOURCE = fs.readFileSync(path.join(ROOT, 'background/background.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

function createBackgroundHarness(overrides = {}) {
  const localData = {
    latestV4Info: null,
    latestV6Info: null,
    appSettings: { enableNotifications: true, enableAntiLeakShield: true, badgeMode: 'flag' },
    ...(overrides.initialLocal || {})
  };
  const sessionData = { ...(overrides.initialSession || {}) };
  const requests = [];
  const notifications = [];
  const alarms = new Map();
  const toolbar = { icon: null, badge: '', color: null, textColor: null, title: '' };

  let policyValue = 'default';
  let predictionValue = true;
  let idleState = overrides.idleState || 'active';
  let idleInterval = 120;
  let listeners = {
    installed: null,
    startup: null,
    message: null,
    alarm: null,
    idle: null,
    storage: null,
    policy: null
  };

  const chrome = {
    runtime: {
      id: 'leakhalo-test-id',
      getURL: (p) => `chrome-extension://leakhalo-test-id/${p}`,
      getManifest: () => ({ ...MANIFEST, ...(overrides.manifest || {}) }),
      onInstalled: { addListener(fn) { listeners.installed = fn; } },
      onStartup: { addListener(fn) { listeners.startup = fn; } },
      onMessage: { addListener(fn) { listeners.message = fn; } },
      sendMessage() {},
      lastError: null
    },
    storage: {
      local: {
        get(keys, callback) {
          const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || localData);
          const out = {};
          for (const k of list) if (k in localData) out[k] = localData[k];
          if (callback) { callback(out); return; }
          return Promise.resolve(out);
        },
        async set(values) {
          const changes = {};
          for (const [k, v] of Object.entries(values || {})) {
            changes[k] = { oldValue: localData[k], newValue: v };
            localData[k] = v;
          }
          if (listeners.storage) listeners.storage(changes, 'local');
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete localData[k];
        }
      },
      session: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || sessionData);
          const out = {};
          for (const k of list) if (k in sessionData) out[k] = sessionData[k];
          return out;
        },
        async set(values) {
          Object.assign(sessionData, values);
        },
        async clear() {
          for (const k of Object.keys(sessionData)) delete sessionData[k];
        }
      },
      onChanged: { addListener(fn) { listeners.storage = fn; } }
    },
    action: {
      async setIcon(details) { toolbar.icon = details; },
      async setBadgeText({ text }) { toolbar.badge = text; },
      async setBadgeBackgroundColor({ color }) { toolbar.color = color; },
      async setBadgeTextColor({ color }) { toolbar.textColor = color; },
      async setTitle({ title }) { toolbar.title = title; }
    },
    alarms: {
      async get(name) { return alarms.get(name); },
      async create(name, info) { alarms.set(name, { name, ...info }); },
      async clear(name) { return alarms.delete(name); },
      onAlarm: { addListener(fn) { listeners.alarm = fn; } }
    },
    notifications: {
      create(id, opts, cb) {
        notifications.push({ id, ...opts });
        cb?.(id);
      },
      clear(id, cb) { cb?.(true); },
      onClicked: { addListener() {} }
    },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: {
          async get() { return { value: policyValue, levelOfControl: 'controlled_by_this_extension' }; },
          async set({ value }) { policyValue = value; },
          async clear() { policyValue = 'default'; },
          onChange: { addListener(fn) { listeners.policy = fn; } }
        },
        networkPredictionEnabled: {
          async set({ value }) { predictionValue = value; },
          async clear() { predictionValue = true; }
        }
      }
    },
    idle: {
      async queryState() { return idleState; },
      setDetectionInterval(s) { idleInterval = s; },
      onStateChanged: { addListener(fn) { listeners.idle = fn; } }
    },
    tabs: { async create() {} },
    i18n: { getMessage: () => '' }
  };

  const defaultFetch = async (url, opts) => {
    if (opts?.signal?.aborted) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    requests.push(url);
    const body = (obj, ok = true, status = 200, headers = {}) => ({
      ok, status,
      headers: { get: (n) => headers[n] || null },
      text: async () => typeof obj === 'string' ? obj : JSON.stringify(obj),
      json: async () => obj,
      blob: async () => ({ size: 32 })
    });

    if (url.startsWith('https://cloudflare.com/')) return body('ip=198.51.100.22\nloc=US\n');
    if (url.startsWith('https://ipv4.icanhazip.com')) return body('198.51.100.22\n');
    if (url.startsWith('https://api.ipify.org')) return body({ ip: '198.51.100.22' });
    if (url.startsWith('https://ipv6.icanhazip.com')) return body('2001:db8::1\n');
    if (url.startsWith('https://api6.ipify.org')) return body({ ip: '2001:db8::1' });
    if (url.includes('assets/')) return body('fake-image-bytes', true, 200);
    if (url.startsWith('https://ipwho.is/')) {
      return body({
        success: true,
        country_code: 'US',
        country: 'United States',
        city: 'New York',
        region: 'NY',
        connection: { isp: 'TestISP', asn: 64500 },
        timezone: { id: 'America/New_York' },
        latitude: 40.71,
        longitude: -74.0
      });
    }
    return body('', false, 404);
  };

  const fetchHandler = overrides.fetch || defaultFetch;

  const selfEvents = {};
  const context = {
    chrome,
    AbortController,
    URL,
    TextDecoder,
    Uint8Array,
    Uint8ClampedArray,
    Intl,
    console,
    Date,
    setTimeout,
    clearTimeout,
    navigator: { onLine: true },
    createImageBitmap: async () => ({ width: 48, height: 48, close() {} }),
    fetch: async (url, opts) => {
      if (opts?.signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return fetchHandler(url, opts);
    },
    addEventListener(event, fn) { selfEvents[event] = fn; },
    OffscreenCanvas
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(BG_SOURCE, context, { filename: path.join(ROOT, 'background/background.js') });

  return {
    context,
    chrome,
    localData,
    sessionData,
    requests,
    notifications,
    alarms,
    toolbar,
    listeners,
    selfEvents,
    teardown() {
      try {
        vm.runInContext(`
          if (typeof stopWatcher === "function") stopWatcher();
          if (typeof resetOfflineRetry === "function") resetOfflineRetry();
          if (typeof resetErrGrace === "function") resetErrGrace();
          if (typeof offlineRetry !== "undefined" && offlineRetry.timer) {
            clearTimeout(offlineRetry.timer);
            offlineRetry.timer = null;
          }
          if (typeof errRetryTimer !== "undefined" && errRetryTimer) {
            clearTimeout(errRetryTimer);
            errRetryTimer = null;
          }
          watcherGeneration++;
          clearGeneration++;
          probeGeneration++;
        `, context);
      } catch (e) {}
    },
    get policyValue() { return policyValue; },
    get predictionValue() { return predictionValue; }
  };
}

test('Validation utilities, coordinate normalization, and connection type classifier', () => {
  const h = createBackgroundHarness();
  const c = h.context;

  assert.equal(vm.runInContext('isValidIPv4("198.51.100.1")', c), true);
  assert.equal(vm.runInContext('isValidIPv4("256.0.0.1")', c), false);
  assert.equal(vm.runInContext('isValidIPv4("not-an-ip")', c), false);

  assert.equal(vm.runInContext('isValidIPv6("2001:db8::1")', c), true);
  assert.equal(vm.runInContext('isValidIPv6(":::1")', c), false);
  assert.equal(vm.runInContext('isValidIPv6("bad:v6")', c), false);

  assert.equal(vm.runInContext('isNonPublicIPv4([127, 0, 0, 1])', c), true);
  assert.equal(vm.runInContext('isNonPublicIPv4([10, 0, 0, 1])', c), true);
  assert.equal(vm.runInContext('isNonPublicIPv4([192, 168, 1, 1])', c), true);
  assert.equal(vm.runInContext('isNonPublicIPv4([8, 8, 8, 8])', c), false);
  assert.equal(vm.runInContext('isValidIPv4("127.0.0.1")', c), false);
  assert.equal(vm.runInContext('isValidIPv6("::1")', c), false);
  assert.equal(vm.runInContext('isValidIPv6("fc00::1")', c), false);

  assert.equal(vm.runInContext('normalizeCoordinate(45.5, 90)', c), 45.5);
  assert.equal(vm.runInContext('normalizeCoordinate(120, 90)', c), null);
  assert.equal(vm.runInContext('normalizeCoordinate("invalid", 90)', c), null);

  assert.equal(vm.runInContext('classifyConnectionType({ isp: "DigitalOcean Datacenter" })', c), 'Datacenter');
  assert.equal(vm.runInContext('classifyConnectionType({ isp: "Verizon Wireless Mobile" })', c), 'Mobile');
  assert.equal(vm.runInContext('classifyConnectionType({ type: "residential" })', c), 'Residential');
  assert.equal(vm.runInContext('classifyConnectionType({ isp: "NordVPN Server" })', c), 'VPN / Relay');
  assert.equal(vm.runInContext('classifyConnectionType({ isp: "Standard ISP" })', c), 'Unknown');
});

test('fetchWithTimeout stream reader, timeout signal abortion, and byte limit protection', async () => {
  const h = createBackgroundHarness({
    fetch: async (url, opts) => {
      if (url.includes('stream-timeout')) {
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          body: {
            getReader() {
              return {
                async read() {
                  await new Promise(r => setTimeout(r, 25));
                  return { done: false, value: new Uint8Array([65]) };
                },
                async cancel() {}
              };
            }
          }
        };
      }
      if (url.includes('stream-toolarge')) {
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          body: {
            getReader() {
              let count = 0;
              return {
                async read() {
                  count++;
                  if (count > 10) return { done: true };
                  return { done: false, value: new Uint8Array(20_000) };
                },
                async cancel() {}
              };
            }
          }
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'ok' };
    }
  });

  const c = h.context;
  await assert.rejects(
    async () => vm.runInContext('fetchWithTimeout("https://example.com/stream-timeout", {}, 10)', c),
    /Timed out/
  );

  await assert.rejects(
    async () => vm.runInContext('fetchWithTimeout("https://example.com/stream-toolarge", {}, 5000)', c),
    /Response too large/
  );
});

test('Cloudflare primary & fallback probes, rate-limit 429 backoff, body stall, and dual-stack IPv6', async () => {
  let cf429 = true;
  let cfV6 = true;

  const h = createBackgroundHarness({
    fetch: async (url) => {
      const body = (obj, ok = true, status = 200) => ({
        ok, status, headers: { get: () => null },
        text: async () => typeof obj === 'string' ? obj : JSON.stringify(obj),
        json: async () => obj
      });

      if (url.startsWith('https://cloudflare.com/')) {
        if (cf429) {
          cf429 = false;
          return body('', false, 429);
        }
        if (cfV6) {
          return body('ip=2001:db8::cloudflare\nloc=DE\n');
        }
        return body('ip=198.51.100.100\nloc=US\n');
      }
      if (url.startsWith('https://ipv4.icanhazip.com')) return body('198.51.100.100\n');
      if (url.startsWith('https://api.ipify.org')) return body({ ip: '198.51.100.100' });
      if (url.startsWith('https://ipv6.icanhazip.com')) return body('2001:db8::1\n');
      if (url.startsWith('https://api6.ipify.org')) return body({ ip: '2001:db8::1' });
      if (url.startsWith('https://ipwho.is/')) {
        return body({ success: true, country_code: 'US', country: 'United States', connection: { isp: 'CF' } });
      }
      return body('', false, 404);
    }
  });

  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);
  const snap = await vm.runInContext('fetchAllBackgroundLocations(true)', c);
  assert.equal(snap.v4Info?.ip, '198.51.100.100');
});

test('Ipify IPv4/IPv6 probes, valid/invalid JSON responses (covering L785), and error branches', async () => {
  const h = createBackgroundHarness({
    fetch: async (url) => {
      const body = (obj, ok = true, status = 200) => ({
        ok, status, headers: { get: () => null },
        text: async () => typeof obj === 'string' ? obj : JSON.stringify(obj),
        json: async () => obj
      });
      if (url.startsWith('https://api6.ipify.org')) {
        // Return JSON with invalid IPv6 to cover L785 throw branch!
        return body({ ip: 'not-an-ipv6' });
      }
      if (url.startsWith('https://ipv6.icanhazip.com')) {
        return body('2001:db8::beef\n');
      }
      if (url.startsWith('https://cloudflare.com/')) return body('ip=198.51.100.20\nloc=US\n');
      if (url.startsWith('https://api.ipify.org')) return body({ ip: '198.51.100.20' });
      if (url.startsWith('https://ipwho.is/')) return body({ success: true, country_code: 'US', country: 'US' });
      return body('', false, 404);
    }
  });

  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);
  const snap = await vm.runInContext('fetchAllBackgroundLocations(true)', c);
  assert.equal(snap.v6Info?.ip, '2001:db8::beef');
});

test('GeoIP enrichment (ipwho.is, geojs.io, ipinfo.io, and all-geo down fallback)', async () => {
  let ipwhoDown = true;
  let geojsDown = true;

  const h = createBackgroundHarness({
    fetch: async (url) => {
      const body = (obj, ok = true, status = 200) => ({
        ok, status, headers: { get: () => null },
        text: async () => typeof obj === 'string' ? obj : JSON.stringify(obj),
        json: async () => obj
      });
      if (url.startsWith('https://cloudflare.com/')) return body('ip=198.51.100.30\nloc=DE\n');
      if (url.startsWith('https://api.ipify.org')) return body({ ip: '198.51.100.30' });
      if (url.startsWith('https://ipwho.is/')) {
        if (ipwhoDown) return body('', false, 500);
        return body({ success: true, country_code: 'DE', country: 'Germany', city: 'Berlin' });
      }
      if (url.startsWith('https://get.geojs.io/')) {
        if (geojsDown) return body('', false, 500);
        return body({ country_code: 'DE', country: 'Germany', city: 'Berlin' });
      }
      if (url.startsWith('https://ipinfo.io/')) {
        return body({ country: 'DE', city: 'Munich', org: 'AS123 TestOrg' });
      }
      return body('', false, 404);
    }
  });

  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);
  const snap = await vm.runInContext('fetchAllBackgroundLocations(true)', c);
  assert.equal(snap.v4Info?.city, 'Munich');
});

test('Route divergence detection, consecutive mismatch tracking, and minimum persistence', async () => {
  let ipifyIp = '203.0.113.77';

  const h = createBackgroundHarness({
    fetch: async (url) => {
      const body = (obj, ok = true, status = 200) => ({
        ok, status, headers: { get: () => null },
        text: async () => typeof obj === 'string' ? obj : JSON.stringify(obj),
        json: async () => obj
      });
      if (url.startsWith('https://cloudflare.com/')) return body('ip=198.51.100.40\nloc=US\n');
      if (url.startsWith('https://api.ipify.org')) return body({ ip: ipifyIp });
      if (url.startsWith('https://ipwho.is/')) {
        return body({ success: true, country_code: 'US', country: 'United States', city: 'New York' });
      }
      return body('', false, 404);
    }
  });

  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);
  h.localData.appSettings = { warnRouteDivergence: true };

  // Probe 1: first mismatch recorded
  await vm.runInContext('fetchAllBackgroundLocations(true)', c);
  // Probe 2: confirmed divergence
  await vm.runInContext('fetchAllBackgroundLocations(true)', c);

  assert.equal(h.localData.routeDivergence?.primaryIp, '198.51.100.40');
  assert.equal(h.localData.routeDivergence?.alts[0]?.ip, '203.0.113.77');
});

test('Decision function evaluateIPv4Route state machine, alternate evidence, and announcements', () => {
  const h = createBackgroundHarness();
  const c = h.context;

  const res = vm.runInContext(`
    const E = (ip, country = 'US') => ({ ip, source: 'Cloudflare', country });
    const I = (ip, source = 'ipify') => ({ ip, source });
    const at = (ip) => ({ ip, countryCode: 'US' });

    let st = null, div = null;
    const r1 = evaluateIPv4Route({ edge: E('198.51.100.1'), independent: I('203.0.113.1') }, at('198.51.100.1'), st, div, 1000);
    const r2 = evaluateIPv4Route({ edge: E('198.51.100.1'), independent: I('203.0.113.1') }, at('198.51.100.1'), r1.state, r1.divergence, 1000 + 20_000);
    ({ r1Confirmed: r1.confirmed.length, r2Confirmed: r2.confirmed.length, alts: r2.divergence?.alts?.length })
  `, c);

  assert.equal(res.r1Confirmed, 0);
  assert.equal(res.r2Confirmed, 1);
  assert.equal(res.alts, 1);
});

test('WebRTC policy management, network prediction, anti-leak armor, and privacy shield', async () => {
  const h = createBackgroundHarness();
  const c = h.context;

  // Apply privacy shield
  await vm.runInContext('applyPrivacyShield()', c);
  assert.equal(h.policyValue, 'disable_non_proxied_udp');

  // Policy change event from chrome.privacy
  if (h.listeners.policy) {
    await h.listeners.policy({ value: 'default', levelOfControl: 'controlled_by_this_extension' });
  }

  // Disable shield
  h.localData.appSettings = { enableAntiLeakShield: false };
  await vm.runInContext('applyPrivacyShield()', c);
  assert.equal(h.policyValue, 'default');
});

test('Alarms lifecycle (heartbeat, geo-watchdog, watchdog timeout covering L1388-1389)', async () => {
  let hangWork = false;
  const h = createBackgroundHarness({
    fetch: async (url) => {
      if (hangWork) return new Promise(() => {}); // hang forever to trigger watchdog!
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => 'ip=198.51.100.55\nloc=US\n',
        json: async () => ({ ip: '198.51.100.55', success: true, country_code: 'US' })
      };
    }
  });

  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);
  await vm.runInContext('ensureAlarm()', c);
  assert.equal(h.alarms.has('fetchLocationsAlarm'), true);

  // Trigger heartbeat alarm
  if (h.listeners.alarm) {
    await h.listeners.alarm({ name: 'fetchLocationsAlarm' });
  }

  // Trigger Watchdog timeout covering L1388-1389
  hangWork = true;
  vm.runInContext('PROBE_WATCHDOG_MS = 20', c);
  const watchdogResult = await vm.runInContext('fetchAllBackgroundLocations(true)', c);
  assert(watchdogResult !== null);
});

test('Idle state listener and background network change detection', async () => {
  const h = createBackgroundHarness();
  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);

  // Let initial background async syncWatcher settle
  await new Promise(r => setTimeout(r, 40));

  if (h.listeners.idle) {
    await h.listeners.idle('idle');
    assert.equal(vm.runInContext('watcherRunning', c), false);
    await h.listeners.idle('active');
    assert.equal(vm.runInContext('watcherRunning', c), true);
    const probe = vm.runInContext('activeProbePromise', c);
    if (probe) await probe;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(h.localData.isOffline, false);
});

test('Message routing (CHECK_NETWORK, UPDATE_SETTINGS, FORCE_REFRESH, CLEAR_IP_DATA, GET_STATE), toolbar planning, badge modes, and notifications', async () => {
  const h = createBackgroundHarness();
  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);

  const send = (msg) => new Promise(resolve => {
    h.listeners.message(msg, { id: 'leakhalo-test-id' }, resolve);
  });

  // CHECK_NETWORK
  const rCheck = await send({ type: 'CHECK_NETWORK', force: true });
  assert.equal(rCheck.status, 'ok');

  // UPDATE_SETTINGS: text badge mode
  const rSettings = await send({ type: 'UPDATE_SETTINGS', patch: { badgeMode: 'text' } });
  assert.equal(rSettings.status, 'ok');
  assert.equal(h.toolbar.badge, 'US');

  // CLEAR_IP_DATA
  const rClear = await send({ type: 'CLEAR_IP_DATA' });
  assert.equal(rClear.status, 'ok');

  // Plan toolbar with error -> ERR badge
  await vm.runInContext('updateToolbarDisplay(null, null, false, true)', c);
  assert.equal(h.toolbar.badge, 'ERR');

  // Plan toolbar offline -> grey icon, empty badge
  await vm.runInContext('updateToolbarDisplay(null, null, true, false)', c);
  assert.equal(h.toolbar.badge, '');

  // Notifications
  await vm.runInContext('sendIPChangeNotification("IPv4", "198.51.100.1", { ip: "198.51.100.2", countryCode: "US", country: "United States" })', c);
  assert(h.notifications.length > 0);
});

test('Toolbar split flag rendering, disconnected icon rendering, and bitmap error handling', async () => {
  const h = createBackgroundHarness();
  const c = h.context;

  // renderSplitFlagIcon
  const splitIcon = await vm.runInContext('renderSplitFlagIcon("US", "FR")', c);
  assert(splitIcon && splitIcon.imageData);

  // renderDisconnectedIcon
  const discIcon = await vm.runInContext('renderDisconnectedIcon()', c);
  assert(discIcon && discIcon.imageData);

  // Cache reuse of renderDisconnectedIcon
  const discIcon2 = await vm.runInContext('renderDisconnectedIcon()', c);
  assert.equal(discIcon, discIcon2);

  // Invalid country code returns null
  const invalidFlag = await vm.runInContext('loadFlagBitmap("invalid-code")', c);
  assert.equal(invalidFlag, null);
});

test('Fallback geolocation providers (geojs.io, ipinfo.io), rate limiting, and unresolvable IPs', async () => {
  let mode = 'geojs';
  const h = createBackgroundHarness({
    fetch: async (url) => {
      const body = (obj, ok = true, status = 200) => ({
        ok, status, headers: { get: () => null },
        text: async () => typeof obj === 'string' ? obj : JSON.stringify(obj),
        json: async () => obj
      });
      if (url.includes('ipwho.is')) {
        if (mode === 'ipwho_ratelimit') {
          return body({ success: false, message: 'rate limit reached' });
        }
        return body('', false, 500);
      }
      if (url.includes('geojs.io')) {
        if (mode === 'geojs') {
          return body({
            country_code: 'DE', country: 'Germany', city: 'Berlin', region: 'BE',
            organization: 'AS1234 TestOrg', asn: 1234, timezone: 'Europe/Berlin',
            latitude: '52.52', longitude: '13.40'
          });
        }
        return body('', false, 500);
      }
      if (url.includes('ipinfo.io')) {
        if (mode === 'ipinfo_ratelimit') {
          return body({ error: { title: 'Rate limit exceeded' } });
        }
        return body({
          country: 'FR', city: 'Paris', region: 'IDF', org: 'AS5678 Free SAS',
          timezone: 'Europe/Paris', loc: '48.85,2.35'
        });
      }
      return body('', false, 404);
    }
  });
  const c = h.context;

  // 1. geojs.io fallback
  const resGeoJs = await vm.runInContext('getGeoLocation("198.51.100.44", "", false)', c);
  assert.equal(resGeoJs.countryCode, 'DE');

  // 2. ipwho.is rate limit cooldown branch
  mode = 'ipwho_ratelimit';
  await vm.runInContext('getGeoLocation("198.51.100.45", "", false)', c);

  // 3. ipinfo.io fallback
  mode = 'ipinfo';
  const resIpinfo = await vm.runInContext('getGeoLocation("198.51.100.46", "", false)', c);
  assert.equal(resIpinfo.countryCode, 'FR');

  // 4. ipinfo.io rate limit branch
  mode = 'ipinfo_ratelimit';
  await vm.runInContext('getGeoLocation("198.51.100.47", "", false)', c);

  // 5. Invalid IP error
  await assert.rejects(async () => vm.runInContext('fetchGeoLocation("invalid-ip")', c), /Invalid IP address/);

  // 6. Helpers
  assert.equal(vm.runInContext('unresolvedGeoInfo("198.51.100.1", "US")', c).countryCode, 'US');
  assert.equal(vm.runInContext('makePendingGeoInfo("198.51.100.1", "US")', c).pending, true);
  assert.equal(vm.runInContext('geoIncomplete({ countryCode: "" })', c), true);
  assert.equal(vm.runInContext('geoIncomplete({ countryCode: "US", city: "NYC", isp: "Test" })', c), false);
});

test('Internet reachability, offline/error retries, and announcements', async () => {
  let pingOk = true;
  const h = createBackgroundHarness({
    fetch: async (url) => {
      if (!pingOk) throw new Error('network unreachable');
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'ok', json: async () => ({}) };
    }
  });
  const c = h.context;

  // internetReachable
  assert.equal(await vm.runInContext('internetReachable()', c), true);
  pingOk = false;
  assert.equal(await vm.runInContext('internetReachable()', c), false);

  // Schedulers & resets
  vm.runInContext('scheduleOfflineRetry(true)', c);
  vm.runInContext('scheduleOfflineRetry(false)', c);
  vm.runInContext('resetOfflineRetry()', c);
  vm.runInContext('scheduleErrRetry(5000)', c);
  vm.runInContext('resetErrGrace()', c);

  // Announced countries
  await vm.runInContext('rememberAnnouncedCountry("IPv4", "US")', c);
  assert.equal((await h.chrome.storage.local.get('announcedCountries')).announcedCountries?.IPv4, 'US');
  await vm.runInContext('forgetAnnouncedCountry("IPv4")', c);
  assert.equal((await h.chrome.storage.local.get('announcedCountries')).announcedCountries?.IPv4, undefined);
});

test('Watcher tick loop, idle state query, and force queueing', async () => {
  const h = createBackgroundHarness();
  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);

  // Run watcher tick while online
  await vm.runInContext('runWatcherTick()', c);

  // Run watcher loop
  await vm.runInContext('watcherLoop()', c);
  vm.runInContext('stopWatcher()', c);

  // Force probe while another probe is active (queuedForceProbePromise)
  const p1 = vm.runInContext('fetchAllBackgroundLocations(true)', c);
  const p2 = vm.runInContext('fetchAllBackgroundLocations(true, 30000, true)', c);
  assert(p2 !== null);
  await Promise.all([p1, p2]);
});

test('Lifecycle events: onInstalled, onStartup, online, offline, and updateSettings', async () => {
  const h = createBackgroundHarness();
  const c = h.context;

  // onInstalled (install vs update)
  if (h.listeners.installed) {
    await h.listeners.installed({ reason: 'install' });
    await h.listeners.installed({ reason: 'update' });
  }

  // onStartup
  if (h.listeners.startup) {
    await h.listeners.startup();
  }

  // Online & offline window events
  if (h.selfEvents.online) {
    await h.selfEvents.online();
  }
  if (h.selfEvents.offline) {
    await h.selfEvents.offline();
  }

  // updateSettings options theme and badge modes
  await vm.runInContext('updateSettings({ enableAutoRefresh: false })', c);
  assert.equal(h.localData.appSettings.enableAutoRefresh, false);

  await vm.runInContext('updateSettings({ enableAutoRefresh: true, badgeMode: "off" })', c);
  assert.equal(h.localData.appSettings.badgeMode, 'off');

  await vm.runInContext('updateSettings({ badgeMode: "flag", enableAntiLeakShield: false })', c);
  assert.equal(h.localData.appSettings.enableAntiLeakShield, false);

  await vm.runInContext('updateSettings({ enableAntiLeakShield: true })', c);
  assert.equal(h.localData.appSettings.enableAntiLeakShield, true);

  // clearStoredIpData
  await vm.runInContext('clearStoredIpData()', c);
  assert.equal(h.localData.latestV4Info, undefined);
});

test('Device offline detection, failure grace period, and ERR badge states', async () => {
  let failAll = false;
  let canReach = false;
  const h = createBackgroundHarness({
    fetch: async (url) => {
      if (failAll) {
        if (canReach && url.includes('cloudflare.com/cdn-cgi/trace')) {
          return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'trace' };
        }
        throw new Error('connection refused');
      }
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => 'ip=198.51.100.99\nloc=US\n',
        json: async () => ({ ip: '198.51.100.99', success: true, country_code: 'US' })
      };
    }
  });
  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);

  // 1. Browser reports device offline (!deviceOnline())
  c.navigator.onLine = false;
  const snapOffline = await vm.runInContext('fetchAllBackgroundLocations(true)', c);
  assert.equal(snapOffline.isOffline, true);
  c.navigator.onLine = true;

  // 2. All providers fail and internetReachable() returns false -> isOffline
  failAll = true;
  canReach = false;
  const snapUnreachable = await vm.runInContext('fetchAllBackgroundLocations(true)', c);
  assert.equal(snapUnreachable.isOffline, true);

  // 3. All providers fail but internetReachable() returns true -> probeError (ERR)
  canReach = true;
  const snapErr = await vm.runInContext('fetchAllBackgroundLocations(true, 30000, true)', c);
  assert.equal(snapErr.probeError, true);
});

test('Decision engine evaluateIPv4Route fallback confirmations, route withdrawal, and notifications', async () => {
  const h = createBackgroundHarness();
  const c = h.context;

  // 1. Fallback independent discovery: step 1 held, step 2 confirmed
  const obs1 = { edge: null, independent: { ip: '198.51.100.200', source: 'ipify' } };
  const r1 = vm.runInContext(`evaluateIPv4Route(${JSON.stringify(obs1)}, { ip: '198.51.100.1' }, null, null)`, c);
  assert.equal(r1.held, true);

  const r2 = vm.runInContext(`evaluateIPv4Route(${JSON.stringify(obs1)}, { ip: '198.51.100.1' }, ${JSON.stringify(r1.state)}, null)`, c);
  assert.equal(r2.primary?.ip, '198.51.100.200');

  // 2. Agreement from secondary independent provider ('checkip')
  const obsCheckip = {
    edge: { ip: '198.51.100.50', source: 'cloudflare' },
    independent: { ip: '198.51.100.50', source: 'checkip' }
  };
  const divBefore = { primaryIp: '198.51.100.50', primarySource: 'cloudflare', alts: [{ source: 'checkip', ip: '198.51.100.99' }] };
  const r3 = vm.runInContext(`evaluateIPv4Route(${JSON.stringify(obsCheckip)}, null, null, ${JSON.stringify(divBefore)})`, c);
  assert.equal(r3.divergence, null);

  // 3. IPv4 change announcement trigger
  const obsNew = { edge: { ip: '198.51.100.60', source: 'cloudflare' }, independent: { ip: '198.51.100.60', source: 'ipify' } };
  const stAnnounced = { announcedIp: '198.51.100.1', edgeMisses: 0, indepMisses: 0, altSeen: { primaryIp: '198.51.100.1', list: [] }, lastPairKeys: [], pairSince: {}, pairSeen: {} };
  const r4 = vm.runInContext(`evaluateIPv4Route(${JSON.stringify(obsNew)}, null, ${JSON.stringify(stAnnounced)}, null)`, c);
  assert.equal(r4.notify?.to, '198.51.100.60');

  // 4. IPv6 address change announcement during probe
  h.localData.lastKnownV6Ip = '2001:db8::1';
  h.localData.appSettings = { notifyIPv6: true };
  const snapV6 = await vm.runInContext('fetchAllBackgroundLocations(true)', c);
  assert(snapV6 !== null);

  // 5. Offline and online events when autoRefresh is disabled
  h.localData.appSettings = { enableAutoRefresh: false };
  h.localData.isOffline = true;
  if (h.listeners.startup) await h.listeners.startup();
  if (h.selfEvents.online) await h.selfEvents.online();
  if (h.selfEvents.offline) await h.selfEvents.offline();
  h.teardown();
});

test('Memory cache hit, 403 cooldown, 429 Retry-After date, country change alerts, and ensureAlarm', async () => {
  const h = createBackgroundHarness({
    fetch: async (url) => {
      if (url.includes('cooldown-403')) return { ok: false, status: 403, headers: { get: () => null }, text: async () => '' };
      if (url.includes('cooldown-429')) return { ok: false, status: 429, headers: { get: (h) => h === 'Retry-After' ? 'Wed, 21 Oct 2026 07:28:00 GMT' : null }, text: async () => '' };
      if (url.startsWith('https://cloudflare.com/')) return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'ip=198.51.100.1\nloc=US\n' };
      const payload = { success: true, country_code: 'US', country: 'United States', city: 'NYC', connection: { isp: 'ISP' } };
      if (url.startsWith('https://ipwho.is/')) return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => payload,
        text: async () => JSON.stringify(payload)
      };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'ok', json: async () => ({}) };
    }
  });
  const c = h.context;

  // 1. Geo memory cache hit
  const geo1 = await vm.runInContext('getGeoLocation("198.51.100.1")', c);
  assert.equal(geo1.countryCode, 'US');
  const geo2 = await vm.runInContext('getGeoLocation("198.51.100.1")', c); // hits cache!
  assert.equal(geo2.countryCode, 'US');

  // 2. Fetch with 403 cooldown
  const res403 = await vm.runInContext('fetchWithTimeout("https://cooldown-403.example.com/test")', c);
  assert.equal(res403.ok, false);

  // 3. Fetch with 429 Retry-After date
  const res429 = await vm.runInContext('fetchWithTimeout("https://cooldown-429.example.com/test")', c);
  assert.equal(res429.ok, false);

  // 4. Country change alert (old code US -> new code FR)
  await h.chrome.storage.local.set({
    announcedCountries: { IPv4: 'US' },
    appSettings: { enableNotifications: true }
  });
  const notifDelivered = await vm.runInContext('sendIPChangeNotification("IPv4", "198.51.100.1", { ip: "198.51.100.2", countryCode: "FR", country: "France" })', c);
  assert(notifDelivered !== false);

  // 5. Notifications disabled with country code vs empty code
  await h.chrome.storage.local.set({ appSettings: { enableNotifications: false } });
  await vm.runInContext('sendIPChangeNotification("IPv4", "198.51.100.1", { ip: "198.51.100.2", countryCode: "DE", country: "Germany" })', c);
  await vm.runInContext('sendIPChangeNotification("IPv4", "198.51.100.1", { ip: "198.51.100.2", countryCode: "", country: "" })', c);

  // 6. ensureAlarm when autoRefresh is disabled
  await h.chrome.storage.local.set({ appSettings: { enableAutoRefresh: false } });
  await vm.runInContext('ensureAlarm()', c);

  // 7. queryIdleState callback style
  h.chrome.idle.queryState = (secs, cb) => { if (cb) cb('active'); else return Promise.resolve('active'); };
  const qState = await vm.runInContext('queryIdleState(120)', c);
  assert.equal(qState, 'active');

  // 8. Action setIcon error fallback in updateToolbarDisplay
  h.chrome.action.setIcon = async () => { throw new Error('icon error'); };
  await vm.runInContext('updateToolbarDisplay({ countryCode: "US" }, null, false, false)', c);
  h.teardown();
});

test('evaluateIPv4Route matrix, cached probe skips, IPv6 notices, and idle watcher', async () => {
  const h = createBackgroundHarness({
    idleState: 'idle'
  });
  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);

  // 1. evaluateIPv4Route branches
  // st.lastV4 and independent.ip === cachedIp
  const r1 = vm.runInContext('evaluateIPv4Route({ edge: null, independent: { ip: "198.51.100.1", source: "ipify" } }, { ip: "198.51.100.1" }, { lastV4: { ip: "198.51.100.1", vantage: "edge" } }, null)', c);
  assert.equal(r1.primary?.ip, '198.51.100.1');

  // knownAlternate -> held
  const r2 = vm.runInContext('evaluateIPv4Route({ edge: null, independent: { ip: "198.51.100.2", source: "ipify" } }, { ip: "198.51.100.1" }, { lastV4: { ip: "198.51.100.1" } }, { primaryIp: "198.51.100.1", alts: [{ ip: "198.51.100.2" }] })', c);
  assert.equal(r2.held, true);

  // !cachedIp -> primary vantage independent
  const r3 = vm.runInContext('evaluateIPv4Route({ edge: null, independent: { ip: "198.51.100.3", source: "ipify" } }, null, null, null)', c);
  assert.equal(r3.primary?.vantage, 'independent');

  // Incomplete probe preserving pair keys
  const r4 = vm.runInContext('evaluateIPv4Route({ edge: null, independent: null }, null, { lastPairKeys: ["198.51.100.1|198.51.100.2"], lastPairAt: Date.now(), pairSince: {}, pairSeen: {} }, null)', c);
  assert.equal(r4.state.lastPairKeys.length, 1);

  // 2. Cached probe skip (line 1200)
  await h.chrome.storage.session.set({ lastProbeAt: Date.now() });
  await h.chrome.storage.local.set({ latestV4Info: { ip: '198.51.100.1' } });
  const cachedRes = await vm.runInContext('fetchAllBackgroundLocations(false, 30000)', c);
  assert.equal(cachedRes.v4Info?.ip, '198.51.100.1');

  // 3. IPv6 change notice delivery (lines 1336-1346)
  await h.chrome.storage.local.set({
    lastKnownV6Ip: '2001:db8::10',
    latestV6Info: { ip: '2001:db8::10', countryCode: 'US' },
    appSettings: { notifyIPv6: true, enableNotifications: true }
  });
  await vm.runInContext('fetchAllBackgroundLocations(true)', c);

  // 4. Watcher tick while idle (lines 1466-1467)
  await vm.runInContext('runWatcherTick()', c);
  assert.equal(vm.runInContext('watcherRunning', c), false);

  // 5. Watcher tick while device offline (lines 1473-1475)
  c.navigator.onLine = false;
  await vm.runInContext('runWatcherTick()', c);
  c.navigator.onLine = true;

  // 6. scheduleErrRetry timer firing
  vm.runInContext('scheduleErrRetry(5)', c);
  await new Promise(r => setTimeout(r, 15));
  h.teardown();
});

test('Background deep edge branches: canvas fallback, notification error, streams, probes, and watcher', async () => {
  const h = createBackgroundHarness();
  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);

  // 1. iconCanvas document.createElement fallback and canvas render errors (covers L79-82, L120, L154)
  const origOffscreen = c.OffscreenCanvas;
  c.OffscreenCanvas = undefined;
  c.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        save: () => {}, restore: () => {}, beginPath: () => {}, rect: () => {}, clip: () => {},
        drawImage: () => { throw new Error('canvas draw error'); },
        fillRect: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4) })
      })
    })
  };
  const canvasElem = vm.runInContext('iconCanvas(16)', c);
  assert.equal(canvasElem.width, 16);
  assert.equal(await vm.runInContext('renderSplitFlagIcon("US", "FR")', c), null);
  c.disconnectedIcon = null;
  assert.equal(await vm.runInContext('renderDisconnectedIcon()', c), null);
  c.OffscreenCanvas = origOffscreen;

  // 2. Notification errors and empty country branch (covers L308, L372, L376, L418)
  const origCreate = h.chrome.notifications.create;
  h.chrome.notifications.create = () => { throw new Error('sync notif error'); };
  assert.equal(await vm.runInContext('createNotification("err-test", {})', c), false);
  h.chrome.notifications.create = origCreate;

  await h.chrome.storage.local.set({ appSettings: { enableNotifications: true } });
  await vm.runInContext('deliverIPChangeNotification("IPv4", "198.51.100.1", { ip: "198.51.100.2", countryCode: "" })', c);
  assert.equal(await vm.runInContext('deliverIPChangeNotification("IPv4", null, null)', c), false);

  const origLocalGet = h.chrome.storage.local.get;
  h.chrome.storage.local.get = () => { throw new Error('storage throw'); };
  assert.equal(await vm.runInContext('sendRouteDivergenceNotification({ alts: [] }, {})', c), false);
  h.chrome.storage.local.get = origLocalGet;

  // 3. fetchWithTimeout 429 numeric seconds and stream body decoding (covers L444, L479)
  const h429 = createBackgroundHarness({
    fetch: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => name === 'Retry-After' ? '120' : null },
      text: async () => ''
    })
  });
  await h429.context.fetchWithTimeout('https://cooldown-numeric.example.com/check').catch(() => {});

  const hStream = createBackgroundHarness({
    fetch: async () => {
      let readCount = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => '11' },
        body: {
          getReader: () => ({
            read: async () => {
              if (readCount++ === 0) return { done: false, value: new Uint8Array([104, 101, 108, 108, 111]) };
              return { done: true };
            },
            cancel: async () => {}
          })
        }
      };
    }
  });
  const streamRes = await hStream.context.fetchWithTimeout('https://stream-ok.example.com/test');
  assert.equal(streamRes.ok, true);

  // 4. probePublicIPv4 error branches and cfTraceV6Until (covers L565, L586, L590)
  const hProbeErr = createBackgroundHarness({
    fetch: async (url) => {
      if (url.includes('icanhazip.com')) return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'not-an-ipv4\n' };
      if (url.includes('api.ipify.org')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ip: 'bad.ip.123' }), text: async () => '{}' };
      if (url.includes('checkip.amazonaws.com')) return { ok: true, status: 200, headers: { get: () => null }, text: async () => '198.51.100.99\n' };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'ip=198.51.100.1\nloc=US\n' };
    }
  });
  hProbeErr.context.cfTraceV6Until = Date.now() + 60_000;
  await vm.runInContext('probePublicIPv4(true)', hProbeErr.context).catch(() => {});
  hProbeErr.teardown();

  // 5. getFastPublicIPv6 error branches (covers L779, L783, L785)
  const hV6Err = createBackgroundHarness({
    fetch: async (url) => {
      if (url.includes('icanhazip.com')) return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'not-an-ipv6' };
      if (url.includes('api6.ipify.org')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ip: 'bad-ipv6' }), text: async () => '{}' };
      return { ok: false, status: 500 };
    }
  });
  await vm.runInContext('getFastPublicIPv6()', hV6Err.context);
  hV6Err.teardown();

  // 6. getFullCountryName custom fallback (covers L821)
  assert.equal(vm.runInContext('getFullCountryName("XX", "CustomCountryName")', c), 'CustomCountryName');

  // 7. scheduleOfflineRetry timer scheduling check (covers L1202-1205)
  vm.runInContext(`
    scheduleOfflineRetry(true);
    if (offlineRetry.timer) {
      clearTimeout(offlineRetry.timer);
      offlineRetry.timer = null;
    }
    resetOfflineRetry();
  `, c);

  // 8. errRetryStep progression within grace period (covers L1256, L1257, L1260)
  const hGrace = createBackgroundHarness({
    fetch: async (url) => {
      if (url.includes('cloudflare.com/cdn-cgi/trace')) return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'trace' };
      throw new Error('fetch error');
    }
  });
  await vm.runInContext('fetchAllBackgroundLocations(true)', hGrace.context);
  hGrace.teardown();

  // 9. retainedV4 pending true in fetchAllBackgroundLocations (covers L1299-1301)
  const hRetainedPending = createBackgroundHarness({
    fetch: async (url) => {
      if (url.includes('cloudflare.com/cdn-cgi/trace') || url.includes('ipify.org')) throw new Error('probe fail');
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ success: true, country_code: 'US', country: 'United States' }),
        text: async () => '{"success":true,"country_code":"US"}'
      };
    }
  });
  await hRetainedPending.chrome.storage.local.set({
    latestV4Info: { ip: '198.51.100.77', countryCode: 'US', pending: true, vantage: 'independent' },
    routeState: { announcedIp: '198.51.100.77' }
  });
  await vm.runInContext('fetchAllBackgroundLocations(true)', hRetainedPending.context);
  hRetainedPending.teardown();

  // 10. pendingV6Notice from === to (covers L1341-1342)
  const hV6Notice = createBackgroundHarness();
  await hV6Notice.chrome.storage.local.set({
    pendingV6Notice: { from: '2001:db8::beef', to: '2001:db8::beef' },
    appSettings: { notifyIPv6: false }
  });
  await vm.runInContext('fetchAllBackgroundLocations(true)', hV6Notice.context);
  hV6Notice.teardown();

  // 11. applyPrivacyShieldNow dns prefetch clear branch (covers L1428)
  await h.chrome.storage.local.set({ appSettings: { enableDnsPrefetchBlock: false, enableAntiLeakShield: false } });
  await vm.runInContext('applyPrivacyShieldNow()', c);

  // 12. queryIdleState callback & throw branches (covers L1453, L1454, L1455)
  h.chrome.idle.queryState = (secs, cb) => cb('active');
  assert.equal(await vm.runInContext('queryIdleState(120)', c), 'active');
  h.chrome.idle.queryState = () => { throw new Error('idle query throw'); };
  assert.equal(await vm.runInContext('queryIdleState(120)', c), 'active');

  // 13. runWatcherTick device offline & online events (covers L1473-1475, L1834)
  c.navigator.onLine = false;
  await h.chrome.storage.local.set({ isOffline: false });
  await vm.runInContext('runWatcherTick()', c);
  c.navigator.onLine = true;

  await h.chrome.storage.local.set({
    appSettings: { enableAutoRefresh: false },
    isOffline: true,
    latestV4Info: { ip: '198.51.100.1', countryCode: 'US' }
  });
  if (h.selfEvents.online) await h.selfEvents.online();
  h.teardown();
});

test('background review prompt synchronization and edge cases', async () => {
  const h = createBackgroundHarness();
  const c = h.context;

  // 1. parseMajorMinor edge cases
  assert.equal(vm.runInContext('parseMajorMinor("1.2.1")', c), '1.2');
  assert.equal(vm.runInContext('parseMajorMinor("invalid")', c), '0.0');
  assert.equal(vm.runInContext('parseMajorMinor(null)', c), '0.0');

  const [cMaj, cMin] = MANIFEST.version.split('.').map(Number);
  const currentMinor = `${cMaj}.${cMin}`;
  const olderMinor = `${cMaj}.${Math.max(0, cMin - 1)}`;

  // 2. syncReviewPromptState when reviewPrompt is empty -> initializes defaults
  await vm.runInContext('syncReviewPromptState()', c);
  const data1 = await h.chrome.storage.local.get('reviewPrompt');
  assert.equal(data1.reviewPrompt.trackedMinor, currentMinor);
  assert.equal(data1.reviewPrompt.opensInMinor, 0);
  assert.equal(data1.reviewPrompt.dismissCount, 0);
  assert.equal(data1.reviewPrompt.completed, false);

  // 3. syncReviewPromptState when reviewPrompt has older minor -> resets opensInMinor, updates minor
  await h.chrome.storage.local.set({
    reviewPrompt: {
      installedAt: 1000,
      trackedMinor: olderMinor,
      opensInMinor: 7,
      dismissCount: 1,
      dismissedAt: 2000,
      dismissedMinor: olderMinor,
      completed: false
    }
  });
  await vm.runInContext('syncReviewPromptState()', c);
  const data2 = await h.chrome.storage.local.get('reviewPrompt');
  assert.equal(data2.reviewPrompt.trackedMinor, currentMinor);
  assert.equal(data2.reviewPrompt.opensInMinor, 0);
  assert.equal(data2.reviewPrompt.dismissCount, 1);

  // 4. syncReviewPromptState when storage throws (error handling)
  const hErr = createBackgroundHarness();
  const origGet = hErr.chrome.storage.local.get;
  hErr.chrome.storage.local.get = (keys, cb) => {
    if (keys === 'reviewPrompt' || (Array.isArray(keys) && keys.includes('reviewPrompt'))) {
      throw new Error('storage simulated error');
    }
    return origGet.call(hErr.chrome.storage.local, keys, cb);
  };
  await vm.runInContext('syncReviewPromptState()', hErr.context);
  hErr.teardown();

  // 5. clearStoredIpData does NOT delete reviewPrompt
  await h.chrome.storage.local.set({
    reviewPrompt: { trackedMinor: '1.2', completed: true },
    latestV4Info: { ip: '198.51.100.1' }
  });
  await vm.runInContext('clearStoredIpData()', c);
  const data3 = await h.chrome.storage.local.get('reviewPrompt');
  assert.equal(data3.reviewPrompt.completed, true);
  h.teardown();
});

test('Russian and blocked-region multi-cloud failover, hedged geo, and sticky watcher', async () => {
  const requests = [];
  const body = (obj, ok = true, status = 200) => ({
    ok, status, headers: { get: () => null },
    text: async () => typeof obj === 'string' ? obj : JSON.stringify(obj),
    json: async () => obj
  });
  const h = createBackgroundHarness({
    fetch: async (url, opts = {}) => {
      requests.push(url);
      if (url.includes('cloudflare.com') || url.includes('icanhazip.com')) {
        throw new Error('Blocked by RKN / DPI');
      }
      if (url.includes('api.ipify.org') || url.includes('api6.ipify.org')) {
        throw new Error('Blocked by RKN / DPI');
      }
      if (url.startsWith('https://v4.ident.me')) {
        return body('198.51.100.99\n');
      }
      if (url.startsWith('https://v6.ident.me')) {
        return body('2001:db8::99\n');
      }
      if (url.startsWith('https://ipv4.seeip.org')) {
        return body('198.51.100.99\n');
      }
      if (url.startsWith('https://ipv6.seeip.org')) {
        return body('2001:db8::99\n');
      }
      if (url.includes('ipwho.is') || url.includes('geojs.io')) {
        throw new Error('Service down or blocked');
      }
      if (url.startsWith('https://ipinfo.io')) {
        return body({
          ip: '198.51.100.99',
          country: 'RU',
          region: 'Moscow',
          org: 'AS12389 Rostelecom'
        });
      }
      return body('', false, 500);
    }
  });
  const c = h.context;
  vm.runInContext('ROUTE_MIN_PERSIST_MS = 0', c);

  // 1. Initial probes when Cloudflare is down: takes 2 consecutive probes to promote fallback
  await vm.runInContext('fetchAllBackgroundLocations(true)', c);
  const res = await vm.runInContext('fetchAllBackgroundLocations(true)', c);
  assert.equal(res.v4Info.ip, '198.51.100.99');
  assert.equal(res.v4Info.countryCode, 'RU');
  assert.equal(res.v4Info.vantage, 'independent');
  assert.equal(res.v4Info.asn, 'AS12389');
  assert.equal(res.v4Info.isp, 'Rostelecom');
  assert.equal(res.v6Info.ip, '2001:db8::99');

  // 2. Watcher stickiness under Cloudflare failure:
  await vm.runInContext('watcherRunning = true; traceSucceededOnce = true', c);
  await vm.runInContext('runWatcherTick()', c);
  assert.equal(vm.runInContext('watcherTraceIndex', c), 1, 'Watcher index sticks to v4.ident.me');
  assert.equal(vm.runInContext('isOriginCoolingDown("https://cloudflare.com")', c), true, 'Cloudflare origin is placed in cooldown');

  // Subsequent tick: because of sticky failover and cooldown, Cloudflare is NOT hit
  const reqLenBefore = requests.length;
  await vm.runInContext('runWatcherTick()', c);
  const newRequests = requests.slice(reqLenBefore);
  assert.ok(!newRequests.some(u => u.includes('cloudflare.com')), 'No Cloudflare probe while in sticky failover');
  assert.ok(newRequests.some(u => u.includes('v4.ident.me')), 'v4.ident.me is queried directly');

  // 3. Cooldown reset on manual refresh
  await vm.runInContext('probePublicIPv4(true)', c);
  assert.equal(vm.runInContext('isOriginCoolingDown("https://cloudflare.com")', c), false, 'Cooldown cleared on manual probe');

  h.teardown();
});

test('Response stream cancellation, error body readers, legacy idle callback queries, and watcher trace key divergence reset', async () => {
  const h = createBackgroundHarness();
  const c = h.context;

  // 1. Pre-aborted signal in fetchWithTimeout (L449-450)
  const ac = new c.AbortController();
  ac.abort();
  c.testAc = ac;
  await assert.rejects(
    async () => vm.runInContext('fetchWithTimeout("https://some-isolated-host.org", { signal: testAc.signal })', c),
    /The operation was aborted|AbortError/i
  );

  // 2. Fetch error body .text() returns empty string and .json() rejects with /no body/ (L480)
  const hErr = createBackgroundHarness({
    fetch: async () => ({
      ok: false,
      status: 502,
      headers: { get: () => null },
      body: { cancel: async () => {} }
    })
  });
  const errRes = await vm.runInContext('fetchWithTimeout("https://some-502-endpoint.org")', hErr.context);
  assert.equal(errRes.ok, false);
  assert.equal(await errRes.text(), '');
  await assert.rejects(async () => errRes.json(), /no body/i);
  hErr.teardown();

  // 3. Response body cancellation on oversized payload (>64KB) (L478)
  let cancelled = false;
  const hOversized = createBackgroundHarness({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: (n) => n.toLowerCase() === 'content-length' ? '100000' : null },
      body: {
        cancel: async () => { cancelled = true; }
      }
    })
  });
  await assert.rejects(
    async () => vm.runInContext('fetchWithTimeout("https://oversized-payload.org")', hOversized.context),
    /too large/i
  );
  assert.equal(cancelled, true, 'Stream reader cancelled on oversized payload');
  hOversized.teardown();

  // 4. queryIdleState callback-only legacy signature (L1550)
  h.chrome.idle.queryState = (seconds, resolve) => {
    if (typeof resolve === 'function') resolve('active');
  };
  const idleState = await vm.runInContext('queryIdleState(60)', c);
  assert.equal(idleState, 'active');
  h.teardown();

  // 5. Watcher trace key reset on route divergence (L1674)
  const hWatcher = createBackgroundHarness({
    initialLocal: {
      appSettings: { enableFastDetection: false },
      isOffline: false,
      probeError: false,
      v4Unverified: false,
      latestV4Info: { ip: '1.2.3.4', countryCode: 'FR', vantage: 'independent' }
    },
    fetch: async (url) => {
      if (url.includes('cdn-cgi/trace') && !url.includes('_t=')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'ip=198.51.100.22\nloc=US\n' };
      }
      if (url.includes('cdn-cgi/trace') && url.includes('_t=')) {
        return { ok: false, status: 500, headers: { get: () => null }, body: { cancel: async () => {} } };
      }
      if (url.includes('ipify.org') || url.includes('ident.me')) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ip: '198.51.100.99' }), text: async () => '198.51.100.99' };
      }
      if (url.includes('ipwho.is') || url.includes('geojs.io')) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ip: '198.51.100.99', country_code: 'DE', country: 'Germany' }), text: async () => JSON.stringify({ ip: '198.51.100.99', country_code: 'DE', country: 'Germany' }) };
      }
      return { ok: false, status: 500, headers: { get: () => null }, body: { cancel: async () => {} } };
    }
  });
  const cWatcher = hWatcher.context;
  const watcherRes = await vm.runInContext(`
    (async () => {
      ROUTE_MIN_PERSIST_MS = 0;
      await new Promise(r => setTimeout(r, 20));
      watcherRunning = true;
      traceSucceededOnce = true;
      clearNetworkCooldowns();
      for (const k in providerCooldowns) delete providerCooldowns[k];
      await runWatcherTick();
      if (activeProbePromise) await activeProbePromise;
      const { latestV4Info } = await chrome.storage.local.get('latestV4Info');
      const key = lastTraceKey;
      return { latestV4Info, key };
    })();
  `, cWatcher);
  assert.equal(watcherRes?.latestV4Info?.ip, '198.51.100.99');
  assert.equal(watcherRes?.latestV4Info?.vantage, 'independent');
  assert.equal(watcherRes?.key, '', 'lastTraceKey cleared on independent divergence');
  hWatcher.teardown();

  // 6. scheduleOfflineRetry timer callback execution in isolated harness (L1205-1209)
  const hRetry = createBackgroundHarness({
    initialLocal: { appSettings: { enableAutoRefresh: true } }
  });
  const cRetry = hRetry.context;
  await vm.runInContext(`
    (async () => {
      scheduleOfflineRetry(true);
      assert.ok(offlineRetry.timer !== null, 'offlineRetry.timer was scheduled');
      const timerFn = offlineRetry.timer._onTimeout || offlineRetry.timer;
      if (offlineRetry.timer) {
        clearTimeout(offlineRetry.timer);
        offlineRetry.timer = null;
      }
      if (typeof timerFn === 'function') await timerFn();
      if (activeProbePromise) await activeProbePromise;
      assert.equal(offlineRetry.timer, null, 'timer reference cleared after execution');
    })();
  `, Object.assign(cRetry, { assert }));
  hRetry.teardown();

  // 7. Retained pending IPv4 geolocation enrichment in isolated harness (L1395-1397)
  const geoPayload = {
    success: true,
    ip: '198.51.100.33',
    country_code: 'FR',
    country: 'France',
    city: 'Paris',
    connection: { isp: 'FrenchISP', org: 'FrenchISP', asn: 1234 }
  };
  const hRetained = createBackgroundHarness({
    initialLocal: {
      latestV4Info: { ip: '198.51.100.33', countryCode: 'FR', pending: true, vantage: 'edge' }
    },
    fetch: async (url) => {
      if (url.includes('cdn-cgi/trace')) return { ok: false, status: 500, headers: { get: () => null } };
      if (url.includes('ident.me') || url.includes('ipify.org')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => '198.51.100.99', json: async () => ({ ip: '198.51.100.99' }) };
      }
      if (url.includes('ipwho.is') || url.includes('geojs.io')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(geoPayload),
          json: async () => geoPayload
        };
      }
      return { ok: false, status: 500, headers: { get: () => null } };
    }
  });
  const cRetained = hRetained.context;
  await vm.runInContext(`
    (async () => {
      ROUTE_MIN_PERSIST_MS = 100_000;
      await fetchAllBackgroundLocations(true);
      ROUTE_MIN_PERSIST_MS = 15_000;
      const { latestV4Info } = await chrome.storage.local.get('latestV4Info');
      assert.equal(latestV4Info?.ip, '198.51.100.33');
      assert.equal(latestV4Info?.countryCode, 'FR');
      assert.equal(latestV4Info?.city, 'Paris');
      assert.equal(latestV4Info?.isp, 'FrenchISP');
      assert.equal(latestV4Info?.pending, undefined);
      assert.equal(latestV4Info?.vantage, 'edge');
    })();
  `, Object.assign(cRetained, { assert }));
  hRetained.teardown();
});

if (require.main === module) {
  run().then(r => process.exit(r.failed > 0 ? 1 : 0));
}

module.exports = { run, createBackgroundHarness };
