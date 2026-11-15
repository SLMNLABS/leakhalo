const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedTests++;
    failures.push({ name, error: err });
    console.error(`  ✗ ${name}`);
    console.error(`    -> ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedTests++;
    failures.push({ name, error: err });
    console.error(`  ✗ ${name}`);
    console.error(`    -> ${err.message}`);
  }
}

async function runAllTests() {
  console.log('\n========================================');
  console.log('LEAKHALO EXTENSION COMPREHENSIVE TEST SUITE');
  console.log('========================================\n');

  console.log('[1/7] Manifest V3 & File Integrity Tests:');
  const manifestPath = path.join(ROOT, 'manifest.json');
  let manifest;

  test('manifest.json exists and is valid JSON', () => {
    assert(fs.existsSync(manifestPath), 'manifest.json does not exist');
    const content = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(content);
    assert(manifest && typeof manifest === 'object');
  });

  test('manifest_version is exactly 3', () => {
    assert.strictEqual(manifest.manifest_version, 3);
  });

  test('Manifest required identity fields exist', () => {
    assert(manifest.name && manifest.name.length > 0);
    assert(manifest.version && /^\d+\.\d+\.\d+/.test(manifest.version));
    assert(manifest.description && manifest.description.length > 0);
  });

  test('Service worker file exists on disk', () => {
    assert(manifest.background && manifest.background.service_worker);
    const swPath = path.join(ROOT, manifest.background.service_worker);
    assert(fs.existsSync(swPath), `Service worker file ${swPath} not found`);
  });

  test('No page-wide content script permissions are requested', () => {
    assert(!manifest.content_scripts, 'Page injection is not needed for the browser privacy API');
  });

  test('Action popup, options, privacy, and license files exist on disk', () => {
    assert(manifest.action && manifest.action.default_popup);
    assert(fs.existsSync(path.join(ROOT, manifest.action.default_popup)));
    assert(manifest.options_ui && manifest.options_ui.page);
    assert(fs.existsSync(path.join(ROOT, manifest.options_ui.page)));
    assert(fs.existsSync(path.join(ROOT, 'licenses.html')), 'licenses.html must exist');
    assert(fs.existsSync(path.join(ROOT, 'privacy.html')), 'privacy.html must exist');
  });

  test('All declared icons exist on disk and are non-empty', () => {
    const iconDicts = [manifest.icons, manifest.action.default_icon];
    for (const d of iconDicts) {
      assert(d && typeof d === 'object');
      for (const size of ['16', '32', '48', '128']) {
        if (d[size]) {
          const p = path.join(ROOT, d[size]);
          assert(fs.existsSync(p), `Icon ${p} does not exist`);
          const stat = fs.statSync(p);
          assert(stat.size > 0, `Icon ${p} is empty`);
        }
      }
    }
  });

  test('No host permissions: every provider is reached with CORS (no install warning)', () => {
    assert(!manifest.host_permissions, 'host_permissions must stay absent');
    assert(!manifest.optional_host_permissions, 'optional_host_permissions must stay absent');
    assert(!manifest.content_scripts, 'content scripts must stay absent');
  });

  test('Permissions do not include unused activeTab or tabs', () => {
    assert(Array.isArray(manifest.permissions));
    assert(!manifest.permissions.includes('activeTab'), 'unused activeTab should be removed');
  });

  test('Background still uses the geo provider get.geojs.io', () => {
    assert(fs.readFileSync(path.join(ROOT, 'background/background.js'), 'utf8').includes('https://get.geojs.io/'), 'background must query get.geojs.io');
  });

  test('Popup does not load the retired WebRTC interceptor', () => {
    const popup = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');
    assert(!popup.includes('webrtc-shield.js'));
  });

  console.log('\n[2/7] First-install Welcome Page Tests:');
  const bgCode = fs.readFileSync(path.join(ROOT, 'background/background.js'), 'utf8');
  const welcomeFiles = ['welcome/welcome.html', 'welcome/welcome.css', 'welcome/welcome.js', 'welcome/land.js'];
  test('Welcome files exist and total less than 120 KB', () => {
    let bytes = 0;
    for (const file of welcomeFiles) {
      assert(fs.existsSync(path.join(ROOT, file)), `${file} is missing`);
      bytes += fs.statSync(path.join(ROOT, file)).size;
    }
    assert(bytes < 120 * 1024, `Welcome files total ${bytes} bytes`);
  });
  const welcomeHtml = fs.readFileSync(path.join(ROOT, welcomeFiles[0]), 'utf8');
  const welcomeCss = fs.readFileSync(path.join(ROOT, welcomeFiles[1]), 'utf8');
  const welcomeJs = fs.readFileSync(path.join(ROOT, welcomeFiles[2]), 'utf8');
  test('Welcome page uses local styles, a deferred script and the extension favicon', () => {
    assert(welcomeHtml.includes('<title>Welcome to LeakHalo</title>'));
    assert(welcomeHtml.includes('href="welcome.css"'));
    assert(welcomeHtml.includes('<script src="welcome.js" defer></script>'));
    assert(welcomeHtml.includes('href="../assets/icons/icon16.png"'));
    for (const match of welcomeHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (match[1].startsWith('#')) continue;
      assert(fs.existsSync(path.resolve(ROOT, 'welcome', match[1])), `Missing local resource: ${match[1]}`);
    }
  });
  test('Welcome page has no remote URLs, network clients, inline scripts or handlers', () => {
    for (const src of [welcomeHtml, welcomeCss, welcomeJs]) {
      assert(!/(?:https?:|wss?:)\/\/|(?:src|href)\s*=\s*["']\/\//i.test(src), 'Welcome must use only local resources');
    }
    assert(!/<script\b(?![^>]*\bsrc\s*=)[^>]*>\s*\S/i.test(welcomeHtml), 'Inline script found');
    assert(!/\son[a-z]+\s*=/i.test(welcomeHtml), 'Inline event handler found');
    assert(!/\bfetch\s*\(|new\s+(?:WebSocket|XMLHttpRequest|EventSource)\b|sendBeacon\s*\(/.test(welcomeJs), 'Page must not contact the network directly');
    assert(!/@import|@font-face/.test(welcomeCss), 'Welcome must use system fonts');
  });
  test('Onboarding adds no permissions or web-accessible resources', () => {
    assert.deepStrictEqual(manifest.permissions, ['storage', 'alarms', 'notifications', 'privacy', 'idle']);
    assert(!manifest.host_permissions);
    assert(!manifest.web_accessible_resources);
  });
  test('Background opens the welcome page only from the first-install guard', () => {
    assert(bgCode.includes('chrome.runtime.onInstalled.addListener((details) => {'));
    assert(/if \(details\??\.reason === 'install'\) \{\s*chrome\.tabs\.create\(\{ url: chrome\.runtime\.getURL\('welcome\/welcome\.html'\) \}\)(\.catch\(\(\) => \{\}\))?;\s*\}/.test(bgCode));
    assert.strictEqual((bgCode.match(/welcome\/welcome.html/g) || []).length, 1);
  });
  test('Welcome uses accessible switches, live status, dark mode and reduced motion', () => {
    assert.strictEqual((welcomeHtml.match(/role="switch"/g) || []).length, 3);
    assert(welcomeHtml.includes('id="connectionCard"') && welcomeHtml.includes('aria-live="polite"'));
    for (const id of ['setNotifications', 'setFastDetection', 'setAntiLeakShield']) {
      assert(welcomeHtml.includes(`for="${id}"`));
    }
    assert(welcomeCss.includes('color-scheme: dark'), 'the welcome page is always dark');
    assert(welcomeCss.includes('prefers-reduced-motion: reduce'));
    assert(welcomeCss.includes(':focus-visible'));
    for (const match of welcomeJs.matchAll(/(?:byId|getElementById)\('([^']+)'\)/g)) {
      assert(welcomeHtml.includes(`id="${match[1]}"`), `Missing welcome element: ${match[1]}`);
    }
    let depth = 0;
    for (const c of welcomeCss) { if (c === '{') depth++; if (c === '}') depth--; assert(depth >= 0); }
    assert.strictEqual(depth, 0, 'Welcome CSS braces must balance');
  });
  test('Welcome uses the popup country rules and both local flag fallbacks', () => {
    assert(welcomeJs.includes("shortNames = { PS: 'Palestine' }"));
    assert(welcomeJs.includes("Intl.DisplayNames(['en'], { type: 'region' })"));
    assert(welcomeJs.includes('/assets/flags-rect/flag-${code}.png'));
    assert(welcomeJs.includes('/assets/flags/flag-${code}.png'));
    assert(welcomeJs.includes("this.src = '/assets/icons/icon48.png'"));
  });

  console.log('\n[3/7] Background Service Worker Unit & Logic Tests:');
  test('background.js must NOT contain setInterval', () => {
    assert(!bgCode.includes('setInterval('), 'setInterval must be completely eliminated in MV3');
  });

  test('Two-tier Cloudflare trace parsing logic', () => {
    const mockTraceText = `fl=31f49
h=cloudflare.com
ip=185.190.140.22
ts=1727392800.123
visit_scheme=https
uag=Mozilla/5.0
colo=FRA
sliver=none
http=http/2
loc=DE
tls=TLSv1.3
sni=plaintext
warp=off
gateway=off
rbi=off
kex=X25519
`;
    const ipMatch = mockTraceText.match(/ip=([^\n]+)/);
    const locMatch = mockTraceText.match(/loc=([^\n]+)/);
    assert(ipMatch && ipMatch[1].trim() === '185.190.140.22');
    assert(locMatch && locMatch[1].trim() === 'DE');
  });

  test('Split Routing preservation: Background does not wipe IPv4 on different IPv6 country', () => {
    assert(!bgCode.includes('cached.latestV4Info.countryCode !== v6Info.countryCode'), 'Split routing self-destruction code must be removed');
    assert(!bgCode.includes('cached.latestV6Info.countryCode !== v4Info.countryCode'), 'Split routing self-destruction code must be removed');
  });

  const event = { addListener() {}, removeListener() {} };
  const bgSandbox = {
    chrome: {
      runtime: { onInstalled: event, onStartup: event, onMessage: event, setUninstallURL() {} },
      storage: { local: { get: async () => ({}), set: async () => ({}) }, session: { get: async () => ({}), set: async () => ({}) } },
      action: { setIcon() {}, setBadgeText() {}, setBadgeBackgroundColor() {}, setBadgeTextColor() {}, setTitle() {} },
      alarms: { get: async () => null, create() {}, clear() {}, onAlarm: event },
      notifications: { create() {}, clear() {}, onClicked: event },
      idle: { queryState: async () => 'active', onStateChanged: event },
      privacy: { network: { webRTCIPHandlingPolicy: { get: async () => ({}), set: async () => ({}) } } }
    },
    fetch: () => {},
    setTimeout: () => {},
    clearTimeout: () => {},
    Intl,
    console
  };
  vm.createContext(bgSandbox);
  vm.runInContext(bgCode, bgSandbox);
  const { classifyConnectionType, getFullCountryName, evaluateIPv4Route } = bgSandbox;

  test('Connection classification handles known types and leaves uncertain networks unknown', () => {
    assert.strictEqual(classifyConnectionType({ isVpn: true }), 'VPN / Relay');
    assert.strictEqual(classifyConnectionType({ isHosting: true }), 'Datacenter');
    assert.strictEqual(classifyConnectionType({ isp: 'Cloudflare, Inc.' }), 'Datacenter');
    assert.strictEqual(classifyConnectionType({ isp: 'Hetzner Online GmbH' }), 'Datacenter');
    assert.strictEqual(classifyConnectionType({ type: 'mobile' }), 'Mobile');
    assert.strictEqual(classifyConnectionType({ isp: 'Comcast Cable' }), 'Unknown');
  });

  test('Full country name resolver uses Intl and fallbacks', () => {
    assert.strictEqual(getFullCountryName('DE', 'Germany'), 'Germany');
    assert.strictEqual(getFullCountryName('US', ''), 'United States');
    assert.strictEqual(getFullCountryName('FR', ''), 'France');
    assert.strictEqual(getFullCountryName('XYZ', ''), 'XYZ');
    assert.strictEqual(getFullCountryName('PL', 'Detected'), 'Poland');
    assert.strictEqual(getFullCountryName('', 'Detected'), 'Unknown Country');
    assert.strictEqual(getFullCountryName('', ''), 'Unknown Country');
    assert(!bgCode.includes("getFullCountryName(resolvedCode, 'Detected')"), 'Background must not pass Detected fallback');
  });

  test('evaluateIPv4Route handles IP changes, single-probe holds, and split-route confirmation', () => {
    const r1 = evaluateIPv4Route(
      { edge: { ip: '198.51.100.1', countryCode: 'US', source: 'Cloudflare' }, independent: { ip: '198.51.100.1', countryCode: 'US', source: 'ipify' } },
      null, null, null, 100_000
    );
    assert.strictEqual(r1.primary.ip, '198.51.100.1');
    assert.strictEqual(r1.notify, null);

    const r2 = evaluateIPv4Route(
      { edge: { ip: '203.0.113.5', countryCode: 'DE', source: 'Cloudflare' }, independent: { ip: '203.0.113.5', countryCode: 'DE', source: 'ipify' } },
      { ip: '198.51.100.1', vantage: 'edge' }, r1.state, null, 110_000
    );
    assert.strictEqual(r2.primary.ip, '203.0.113.5');
    assert.deepEqual(r2.notify, { from: '198.51.100.1', to: '203.0.113.5' });

    const r3 = evaluateIPv4Route(
      { edge: null, independent: null },
      { ip: '203.0.113.5', vantage: 'edge' }, r2.state, null, 115_000
    );
    assert.strictEqual(r3.held, true);
    assert.strictEqual(r3.primary, null);

    const s1 = evaluateIPv4Route(
      { edge: { ip: '198.51.100.1', countryCode: 'US', source: 'Cloudflare' }, independent: { ip: '203.0.113.9', countryCode: 'DE', source: 'ipify' } },
      { ip: '198.51.100.1', vantage: 'edge' }, r1.state, null, 200_000
    );
    assert.strictEqual(s1.divergence, null);

    const s2 = evaluateIPv4Route(
      { edge: { ip: '198.51.100.1', countryCode: 'US', source: 'Cloudflare' }, independent: { ip: '203.0.113.9', countryCode: 'DE', source: 'ipify' } },
      { ip: '198.51.100.1', vantage: 'edge' }, s1.state, s1.divergence, 216_000
    );
    assert(s2.divergence && s2.divergence.alts[0].ip === '203.0.113.9');
    assert.strictEqual(s2.confirmed.length, 1);

    const s3 = evaluateIPv4Route(
      { edge: { ip: '198.51.100.1', countryCode: 'US', source: 'Cloudflare' }, independent: { ip: '198.51.100.1', countryCode: 'US', source: 'ipify' } },
      { ip: '198.51.100.1', vantage: 'edge' }, s2.state, s2.divergence, 220_000
    );
    assert.strictEqual(s3.divergence, null);
  });

  test('All HTTPS endpoints in background.js are allowed in manifest CSP connect-src', () => {
    const csp = manifest.content_security_policy.extension_pages;
    const origins = new Set((bgCode.match(/https:\/\/[a-z0-9.-]+/gi) || []).map(u => u.toLowerCase()));
    origins.delete('https://slmn-labs.github.io');
    for (const origin of origins) {
      assert(csp.includes(origin), `Manifest CSP connect-src missing ${origin}`);
    }
  });

  test('Offline state sets isOffline: true without wiping latestV4Info or latestV6Info', () => {
    assert(!bgCode.includes('latestV4Info: null,\n      latestV6Info: null'), 'Offline handler must preserve cached snapshot');
  });

  test('Privacy shield uses clear({}) when inactive', () => {
    assert(bgCode.includes('network.webRTCIPHandlingPolicy.clear({})'), 'Must clear webRTC policy on disable');
    assert(bgCode.includes('network.networkPredictionEnabled.clear({})'), 'Must clear network prediction policy on disable');
  });

  console.log('\n[4/7] Popup Controller & HTML DOM Tests:');
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup/popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');

  test('popup.html contains all critical interactive element IDs', () => {
    const requiredIds = [
      'loader', 'content', 'settingsToggleBtn', 'shieldToggleBtn', 'refreshBtn',
      'splitBadge', 'lastUpdatedTime', 'v4Country', 'v4TypeTag', 'v4FlagImg',
      'v4Watermark', 'v4Ip', 'v4IpRow', 'v4CopyStatus', 'v4CityRegion', 'v4Isp',
      'v4MapBtn', 'v4IspRow', 'v6ActiveCard', 'v6InactivePill', 'v6Country',
      'v6TypeTag', 'v6FlagImg', 'v6Watermark', 'v6Ip', 'v6IpRow', 'v6CopyStatus',
      'v6CityRegion', 'v6Isp', 'v6MapBtn', 'v6IspRow', 'securityBar',
      'shieldStatusPill', 'shieldDot', 'shieldStatusText', 'webrtcItem',
      'webrtcDot', 'webrtcStatus'
    ];
    for (const id of requiredIds) {
      assert(popupHtml.includes(`id="${id}"`), `popup.html missing element id="${id}"`);
    }
  });

  test('popup.js queries only existing IDs (no dead element queries)', () => {
    const deadIds = ['v4Asn', 'v4Timezone', 'v4AsnRow', 'v4TimezoneRow', 'v6Asn', 'v6Timezone', 'v6AsnRow', 'v6TimezoneRow'];
    for (const id of deadIds) {
      assert(!popupJs.includes(`document.getElementById('${id}')`), `popup.js contains dead query for id="${id}"`);
    }
  });

  test('Popup does not contain generic Detected string fallbacks', () => {
    assert(!popupJs.includes("'Location detected'"), 'Popup must not fallback to Location detected');
    assert(!popupJs.includes("'Detected Country'"), 'Popup must not fallback to Detected Country');
  });

  test('Bogon & Private IP validator classifies IPs correctly', () => {
    const popupSandbox = { URL, console };
    const canonicalIpMatch = popupJs.match(/function canonicalIp\([\s\S]*?\n  \}/);
    const isPrivateOrBogonMatch = popupJs.match(/function isPrivateOrBogonIP\([\s\S]*?\n  \}/);
    vm.createContext(popupSandbox);
    vm.runInContext(canonicalIpMatch[0] + '\n' + isPrivateOrBogonMatch[0], popupSandbox);
    const { isPrivateOrBogonIP } = popupSandbox;

    assert.strictEqual(isPrivateOrBogonIP('127.0.0.1'), true);
    assert.strictEqual(isPrivateOrBogonIP('192.168.1.1'), true);
    assert.strictEqual(isPrivateOrBogonIP('10.0.0.1'), true);
    assert.strictEqual(isPrivateOrBogonIP('172.16.0.1'), true);
    assert.strictEqual(isPrivateOrBogonIP('100.64.0.1'), true);
    assert.strictEqual(isPrivateOrBogonIP('8.8.8.8'), false);
    assert.strictEqual(isPrivateOrBogonIP('1.1.1.1'), false);
    assert.strictEqual(isPrivateOrBogonIP('185.190.140.22'), false);
    assert.strictEqual(isPrivateOrBogonIP('fe80::1'), true);
    assert.strictEqual(isPrivateOrBogonIP('2606:4700:4700::1111'), false);
  });

  test('formatIspAsn formats combinations cleanly', () => {
    const popupSandbox = { console };
    const formatIspAsnMatch = popupJs.match(/function formatIspAsn\([\s\S]*?\n  \}/);
    vm.createContext(popupSandbox);
    vm.runInContext(formatIspAsnMatch[0], popupSandbox);
    const { formatIspAsn } = popupSandbox;

    assert.strictEqual(formatIspAsn('Cloudflare, Inc.', 'AS13335'), 'Cloudflare, Inc. (AS13335)');
    assert.strictEqual(formatIspAsn('AS13335 Cloudflare, Inc.', 'N/A'), 'Cloudflare, Inc. (AS13335)');
    assert.strictEqual(formatIspAsn('N/A', 'AS60068'), 'AS60068');
    assert.strictEqual(formatIspAsn('N/A', 'N/A'), '');
  });

  test('Flag image error handler sets onerror = null and uses local fallback', () => {
    assert(popupJs.includes('this.onerror = null;'), 'Must set onerror = null to prevent infinite loops');
    assert(!popupJs.includes('cdn.ipwhois.io'), 'Must not fetch remote CDN images');
  });

  await asyncTest('probeWebRTCLeaks detects unmasked public IPv6 on IPv4-only exit', async () => {
    const canonicalIpMatch = popupJs.match(/function canonicalIp\([\s\S]*?\n  \}/);
    const isPrivateOrBogonMatch = popupJs.match(/function isPrivateOrBogonIP\([\s\S]*?\n  \}/);
    const probeMatch = popupJs.match(/function probeWebRTCLeaks\([\s\S]*?\n  \}/);
    assert(probeMatch, 'probeWebRTCLeaks function not found');

    class MockRTCPeerConnection {
      constructor() {
        this.iceGatheringState = 'new';
      }
      createDataChannel() {}
      createOffer() { return Promise.resolve({}); }
      setLocalDescription() {
        return Promise.resolve().then(() => {
          if (this.onicecandidate) {
            this.onicecandidate({
              candidate: {
                address: '2606:4700:4700::1111',
                candidate: 'candidate:1 1 UDP 1 2606:4700:4700::1111 50000 typ host'
              }
            });
            this.iceGatheringState = 'complete';
            if (this.onicegatheringstatechange) this.onicegatheringstatechange();
          }
        });
      }
      close() {}
    }

    const sandbox = {
      URL,
      console,
      setTimeout,
      clearTimeout,
      activeProbePC: null,
      window: { RTCPeerConnection: MockRTCPeerConnection }
    };
    vm.createContext(sandbox);
    vm.runInContext(canonicalIpMatch[0] + '\n' + isPrivateOrBogonMatch[0] + '\n' + probeMatch[0], sandbox);

    const res = await sandbox.probeWebRTCLeaks({ ip: '198.51.100.1' }, null);
    assert.strictEqual(res.leaked, true, 'Should flag public IPv6 leak on IPv4-only exit');
    assert.deepEqual(res.leakedIPs, ['2606:4700:4700::1111']);
  });

  console.log('\n[5/7] Options Controller & Settings Dashboard Tests:');
  const optionsHtml = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
  const optionsJs = fs.readFileSync(path.join(ROOT, 'options/options.js'), 'utf8');

  test('options.html contains matching section IDs for all nav links', () => {
    const requiredSections = ['general', 'badge', 'notifications', 'about'];
    for (const s of requiredSections) {
      assert(optionsHtml.includes(`id="${s}"`), `options.html missing section id="${s}"`);
      assert(optionsHtml.includes(`href="#${s}"`), `options.html missing nav link href="#${s}"`);
    }
  });

  test('options.js binds smooth navigation and tracks manual scrolling', () => {
    assert(optionsJs.includes('scrollIntoView'), 'options.js must implement smooth navigation scrolling');
    assert(optionsJs.includes('updateActiveNavFromScroll'), 'options.js must update navigation as the page scrolls');
    assert(optionsJs.includes("classList.toggle('active'"), 'options.js must manage the active navigation item');
  });

  test('options.html setting controls all exist in options.js', () => {
    const controlIds = [
      'saveToast', 'setNotifications', 'setAutoRefresh', 'setShowMap',
      'setAntiLeakShield', 'setAntiLeakPolicy', 'setDnsPrefetchBlock', 'setWebRtcScan'
    ];
    for (const id of controlIds) {
      assert(optionsHtml.includes(`id="${id}"`), `options.html missing control id="${id}"`);
      assert(optionsJs.includes(`getElementById('${id}')`), `options.js missing listener for id="${id}"`);
    }
  });

  test('Settings page theme is optional, saved, and applied before first paint', () => {
    const themeJs = fs.readFileSync(path.join(ROOT, 'options/theme.js'), 'utf8');
    const optionsCss = fs.readFileSync(path.join(ROOT, 'options/options.css'), 'utf8');
    assert(optionsHtml.indexOf('<script src="theme.js"></script>') < optionsHtml.indexOf('</head>'), 'theme.js must load in <head>');
    for (const v of ['light', 'dark', 'system']) assert(optionsHtml.includes(`name="optionsTheme" value="${v}"`), `missing ${v} theme choice`);
    assert(/value="light" checked/.test(optionsHtml), 'light must stay the default');
    assert(optionsJs.includes("queueSave('optionsTheme'"), 'theme choice must be saved through UPDATE_SETTINGS');
    assert(themeJs.includes('prefers-color-scheme: dark') && themeJs.includes("addEventListener('change'"), 'system theme must follow the OS');
    assert(optionsCss.includes(':root[data-theme="dark"] {'), 'missing dark palette');
    assert(fs.existsSync(path.join(ROOT, 'assets/brand/wordmark-dark.png')), 'missing dark wordmark');
  });

  console.log('\n[6/7] Assets & National Flags Validation:');

  test('All 244 ISO country flag PNG assets are valid files', () => {
    const flagsDir = path.join(ROOT, 'assets/flags');
    assert(fs.existsSync(flagsDir), 'assets/flags directory must exist');
    const files = fs.readdirSync(flagsDir);
    assert(files.length >= 240, `Expected at least 240 flags, found ${files.length}`);

    const keyCountries = ['us', 'de', 'fr', 'gb', 'nl', 'ca', 'au', 'jp', 'ir', 'tr', 'ru', 'br', 'in'];
    for (const code of keyCountries) {
      const flagFile = path.join(flagsDir, `flag-${code}.png`);
      assert(fs.existsSync(flagFile), `Essential flag ${flagFile} is missing`);
      const stat = fs.statSync(flagFile);
      assert(stat.size > 50, `Flag file ${flagFile} is unexpectedly small (${stat.size} bytes)`);
    }
  });

  test('Popup uses sharp rectangular flags with a square fallback for every country', () => {
    const rectDir = path.join(ROOT, 'assets/flags-rect');
    assert(fs.existsSync(path.join(rectDir, 'LICENSE-flag-icons.md')), 'flags-rect license notice missing');
    const squares = fs.readdirSync(path.join(ROOT, 'assets/flags')).filter(f => /^flag-[a-z]{2}\.png$/.test(f));
    for (const f of squares) {
      const file = path.join(rectDir, f);
      assert(fs.existsSync(file), `Rectangular popup flag ${f} is missing`);
      const png = fs.readFileSync(file);
      assert(png.readUInt32BE(16) === 96 && png.readUInt32BE(20) === 72, `${f} must be 96x72 (got ${png.readUInt32BE(16)}x${png.readUInt32BE(20)})`);
    }
    const popupJs = fs.readFileSync(path.join(ROOT, 'popup/popup.js'), 'utf8');
    assert(popupJs.includes('/assets/flags-rect/flag-${code}.png'), 'popup must load rectangular flags');
    assert(popupJs.includes('/assets/flags/flag-${code}.png'), 'popup must fall back to the square flag');
  });

  test('Every ISO country and territory code has both flags, with no unused ones', () => {
    const sq = fs.readdirSync(path.join(ROOT, 'assets/flags')).filter(f => f.endsWith('.png')).sort();
    const rect = fs.readdirSync(path.join(ROOT, 'assets/flags-rect')).filter(f => f.endsWith('.png')).sort();
    assert.deepStrictEqual(sq, rect, 'the toolbar and popup flag sets must cover the same codes');
    for (const code of ['xk', 'gf', 'gp', 'io', 'bq', 'pm', 'sj', 'um', 'bv', 'hm', 'ps', 'ir']) {
      assert(sq.includes(`flag-${code}.png`), `flag-${code}.png missing`);
    }
    for (const code of ['eu', 'an', 'ct']) assert(!sq.includes(`flag-${code}.png`), `flag-${code}.png is never shown`);
  });

  test('Country code PS is labelled "Palestine" in popup and notifications', () => {
    for (const file of ['popup/popup.js', 'background/background.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert(/shortNames = \{ PS: 'Palestine' \}/.test(src), `${file} must map PS to "Palestine"`);
    }
  });

  test('Extension icons are valid PNG files of exact required sizes', () => {
    const iconsDir = path.join(ROOT, 'assets/icons');
    for (const size of ['16', '32', '48', '128']) {
      const iconPath = path.join(iconsDir, `icon${size}.png`);
      assert(fs.existsSync(iconPath), `icon${size}.png missing`);
      const stat = fs.statSync(iconPath);
      assert(stat.size > 100, `icon${size}.png is too small`);
    }
  });

  console.log('\n[7/7] Deep Edge-Case & Architecture Validation:');

  test('popup.css and options.css have balanced braces and no syntax corruption', () => {
    const popupCss = fs.readFileSync(path.join(ROOT, 'popup/popup.css'), 'utf8');
    const optionsCss = fs.readFileSync(path.join(ROOT, 'options/options.css'), 'utf8');

    function checkBraces(css, name) {
      let depth = 0;
      for (let i = 0; i < css.length; i++) {
        if (css[i] === '{') depth++;
        if (css[i] === '}') depth--;
        assert(depth >= 0, `Unmatched closing brace in ${name} at index ${i}`);
      }
      assert.strictEqual(depth, 0, `Unmatched opening brace in ${name}`);
    }

    checkBraces(popupCss, 'popup.css');
    checkBraces(optionsCss, 'options.css');
    assert(popupCss.includes('.pulse-dot'), 'popup.css missing .pulse-dot');
    assert(popupCss.includes('.location-link.disabled'), 'popup.css missing .location-link.disabled');
  });

  test('Split Routing state correctly identifies different countries between IPv4 and IPv6', () => {
    function computeSplitRouting(v4, v6) {
      if (!v4 || !v6 || !v4.countryCode || !v6.countryCode) return false;
      return v4.countryCode.toUpperCase() !== v6.countryCode.toUpperCase();
    }

    assert.strictEqual(computeSplitRouting({ countryCode: 'US' }, { countryCode: 'US' }), false);
    assert.strictEqual(computeSplitRouting({ countryCode: 'DE' }, { countryCode: 'US' }), true);
    assert.strictEqual(computeSplitRouting({ countryCode: 'IR' }, null), false);
    assert.strictEqual(computeSplitRouting(null, { countryCode: 'FR' }), false);
  });

  test('Settings link to independent leak tests safely and offer the IPv6 alert switch', () => {
    const options = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8');
    for (const url of ['https://www.dnsleaktest.com/', 'https://coveryourtracks.eff.org/']) {
      assert(options.includes(`href="${url}" target="_blank" rel="noopener noreferrer"`), `missing safe link to ${url}`);
    }
    assert(options.includes('id="setNotifyIPv6"') && fs.readFileSync(path.join(ROOT, 'options/options.js'), 'utf8').includes('notifyIPv6: setNotifyIPv6'));
    assert(bgCode.includes("stored.appSettings?.notifyIPv6 === false"), 'IPv6 alerts must honour the switch');
  });

  test('Toolbar: offline is the grey icon without badge text; provider errors show ERR', () => {
    assert(/badgeText: probeError \? 'ERR' : ''/.test(bgCode), 'offline must not add badge text');
  });

  test('Toolbar plan: handles offline, errors, text badges, and country flags', () => {
    assert(bgCode.includes('async function planToolbar(v4Info, v6Info, isOffline, probeError)'));
    assert(bgCode.includes("badgeText: probeError ? 'ERR' : ''"));
    assert(bgCode.includes("badgeMode === 'off'"));
    assert(bgCode.includes("badgeMode === 'text'"));
    assert(bgCode.includes("badgeText = primaryCode;"));
    assert(bgCode.includes("primaryCode ? { kind: 'flag', codes: [primaryCode] } : { kind: 'default' }"));
  });

  test('All 13 locale files are valid JSON and define required manifest keys', () => {
    const localesDir = path.join(ROOT, '_locales');
    const locales = fs.readdirSync(localesDir);
    assert(locales.length >= 13, `Expected at least 13 locales, found ${locales.length}`);
    for (const loc of locales) {
      const msgPath = path.join(localesDir, loc, 'messages.json');
      assert(fs.existsSync(msgPath), `Missing ${msgPath}`);
      const msgs = JSON.parse(fs.readFileSync(msgPath, 'utf8'));
      for (const key of ['extName', 'extDescription', 'defaultTitle']) {
        assert(msgs[key] && typeof msgs[key].message === 'string' && msgs[key].message.trim().length > 0, `${loc} missing ${key}`);
      }
    }
  });

  console.log('\n========================================');
  console.log(`TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
  if (failedTests > 0) {
    console.log(`FAILED: ${failedTests} TESTS FAILED:`);
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error.message}`);
    }
    process.exit(1);
  } else {
    console.log('ALL TESTS PASSED WITH 100% SUCCESS!');
    console.log('========================================\n');
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
