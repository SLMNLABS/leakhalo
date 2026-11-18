
let activeProbePromise = null;
let queuedForceProbePromise = null;
let queuedForceIsManual = false;
const PROBE_INTERVAL_MS = 30_000;
const POPUP_PROBE_INTERVAL_MS = 3_000;
let POPUP_PROBE_WITH_WATCHER_MS = 10_000;
let WATCH_INTERVAL_MS = 3_000;
let IDLE_SECONDS = 120;
let ERR_GRACE_MS = 8_000;
const ERR_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
let errFailureStartedAt = 0;
let errRetryTimer = null;
let errRetryStep = 0;
let watcherRunning = false;
let watcherTimer = null;
let watcherGeneration = 0; // a loop from before a stop/start never schedules itself again
let watcherTraceIndex = 0;
let lastUnverifiedWatcherAt = 0;
let traceSucceededOnce = false;
let traceFailureTriggered = false;
let lastTraceKey = '';
const GEO_RETRY_INTERVAL_MS = 15 * 60_000;
const MANUAL_GEO_REFRESH_MS = 5 * 60_000;
const ALT_GEO_MANUAL_RETRY_MS = 30_000;
const GEO_MEMORY_CACHE_MS = 30 * 60_000;
// Upper bounds so no single step can leave the extension stuck (e.g. on "Locating...").
let GEO_LOOKUP_TIMEOUT_MS = 15_000;
let PROBE_WATCHDOG_MS = 30_000;
let TOOLBAR_WAIT_MS = 5_000;
let NOTIFY_GEO_WAIT_MS = 2_500;
let probeGeneration = 0;
let clearGeneration = 0;
// While a check reports "offline", retry soon so the return of the connection shows within seconds
// (the alarm alone would take up to 30 s), then every 15 s for as long as the worker runs.
// Requests fail locally while offline, so this is cheap.
const OFFLINE_RETRY_MS = [3_000, 5_000, 10_000, 15_000];
const offlineRetry = { timer: null, step: 0 };
const deviceOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise(resolve => { timer = setTimeout(() => resolve(onTimeout()), ms); })
  ]).finally(() => clearTimeout(timer));
}
const geoMemoryCache = new Map();
const providerCooldowns = {};
const providerCooldownReady = chrome.storage.local.get('providerCooldowns').then(({ providerCooldowns: saved }) => {
  if (saved && typeof saved === 'object') Object.assign(providerCooldowns, saved);
}).catch(() => {});

// Keeps a provider out of rotation until `until`, and drops cooldowns that have run out.
async function markProviderCooldown(origin, delayMs) {
  const now = Date.now();
  if (origin) providerCooldowns[origin] = now + delayMs;
  for (const [key, until] of Object.entries(providerCooldowns)) if (!(until > now)) delete providerCooldowns[key];
  await chrome.storage.local.set({ providerCooldowns: { ...providerCooldowns } }).catch(() => {});
}

const networkCooldowns = {};
function markNetworkCooldown(origin, delayMs = 10 * 60_000) {
  if (origin) networkCooldowns[origin] = Date.now() + delayMs;
}
function clearNetworkCooldowns() {
  for (const key of Object.keys(networkCooldowns)) delete networkCooldowns[key];
}
function isOriginCoolingDown(origin) {
  const now = Date.now();
  if ((providerCooldowns[origin] || 0) > now) return true;
  if ((networkCooldowns[origin] || 0) > now) return true;
  return false;
}

async function loadBitmap(path) {
  try {
    const response = await fetch(chrome.runtime.getURL(path));
    if (!response.ok) return null;
    return await createImageBitmap(await response.blob());
  } catch (e) {
    return null;
  }
}

function loadFlagBitmap(countryCode) {
  if (!/^[a-z]{2}$/i.test(countryCode || '')) return Promise.resolve(null);
  return loadBitmap(`assets/flags/flag-${countryCode.toLowerCase()}.png`);
}

function iconCanvas(size) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

const ICON_SIZES = [16, 32, 48];

// Both flags are decoded once and drawn at every toolbar size; the bitmaps are released after.
async function renderSplitFlagIcon(code1, code2) {
  const [bitmap1, bitmap2] = await Promise.all([loadFlagBitmap(code1), loadFlagBitmap(code2)]);
  try {
    if (!bitmap1 || !bitmap2) return null;
    const imageData = {};
    for (const size of ICON_SIZES) {
      const canvas = iconCanvas(size);
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      const splitX = Math.round(size / 2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, size);
      ctx.clip();
      ctx.drawImage(bitmap1, 0, 0, size, size);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, size - splitX, size);
      ctx.clip();
      ctx.drawImage(bitmap2, 0, 0, size, size);
      ctx.restore();
      // A whole-pixel divider (fillRect, not a half-pixel stroke) drawn only over the flags
      // themselves, so it stays sharp at 16 and 32 px and never runs past rounded corners.
      const width = Math.max(1, Math.round(size / 24));
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = '#0b0e14';
      ctx.fillRect(splitX - Math.floor(width / 2), 0, width, size);
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    return { imageData };
  } catch (err) {
    return null;
  } finally {
    bitmap1?.close?.();
    bitmap2?.close?.();
  }
}

// The grey offline icon never changes, so it is drawn once per worker and reused.
let disconnectedIcon = null;
async function renderDisconnectedIcon() {
  if (disconnectedIcon) return disconnectedIcon;
  const bitmap = await loadBitmap('assets/icons/icon48.png');
  try {
    if (!bitmap) return null;
    const imageData = {};
    for (const size of ICON_SIZES) {
      const canvas = iconCanvas(size);
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, size, size);
      const imgData = ctx.getImageData(0, 0, size, size);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const avg = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
        d[i] = avg;
        d[i + 1] = avg;
        d[i + 2] = avg;
        d[i + 3] = Math.round(d[i + 3] * 0.45);
      }
      imageData[size] = imgData;
    }
    disconnectedIcon = { imageData };
    return disconnectedIcon;
  } catch (e) {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

const DEFAULT_ACTION_ICON = { path: { "16": "/assets/icons/icon16.png", "32": "/assets/icons/icon32.png", "48": "/assets/icons/icon48.png" } };
let toolbarRenderSeq = 0;
let toolbarApplyChain = Promise.resolve();
// What the toolbar shows now, so an unchanged state (most checks) costs no rendering or API calls.
let appliedToolbarKey = '';

// Badge text colours chosen for contrast on each badge background.
const BADGE_TEXT = { '#f59e0b': '#192b35', '#0284c7': '#ffffff', '#64748b': '#ffffff' };

// Works out icon, badge and title for the current state without rendering anything: the icon is
// described ({ kind, codes }) so an unchanged state can be recognised before any drawing.
async function planToolbar(v4Info, v6Info, isOffline, probeError) {
  const res = await chrome.storage.local.get(['appSettings', 'routeDivergence', 'v4Unverified']);
  const badgeMode = (res.appSettings && res.appSettings.badgeMode) ? res.appSettings.badgeMode : 'flag';

  // Failure states take precedence over cached locations: a stale flag must not look verified.
  if (isOffline || probeError) {
    return {
      icon: { kind: 'grey' },
      // Offline is the grey icon alone; only a provider error adds a badge.
      badgeText: probeError ? 'ERR' : '',
      badgeColor: probeError ? '#f59e0b' : '#64748b',
      title: probeError ? 'LeakHalo: Unable to verify network' : 'LeakHalo: Disconnected / No Internet Connection'
    };
  }
  if (!v4Info?.ip && !v6Info?.ip) {
    const isPaused = res.appSettings?.enableAutoRefresh === false;
    return {
      icon: { kind: 'default' },
      badgeText: '',
      badgeColor: null,
      title: isPaused ? 'LeakHalo: Auto-check paused (click to check)' : (chrome.i18n?.getMessage?.('defaultTitle') || 'LeakHalo: Checking your connection…')
    };
  }

  // The split-route warning is opt-in (Settings): by default the main country is shown alone.
  const divergence = res.appSettings?.warnRouteDivergence === true &&
    res.routeDivergence && v4Info?.ip && v4Info.ip === res.routeDivergence.primaryIp &&
    Array.isArray(res.routeDivergence.alts) && res.routeDivergence.alts.length ? res.routeDivergence : null;
  const v4Code = normalizeCountryCode(v4Info?.countryCode);
  const v6Code = normalizeCountryCode(v6Info?.countryCode);
  const altCode = divergence
    ? divergence.alts.map(alt => normalizeCountryCode(alt.geo?.countryCode)).find(code => code && code !== v4Code) || ''
    : '';
  const primaryCode = v4Code || v6Code;
  const primaryName = primaryCode ? getFullCountryName(primaryCode, v4Code ? v4Info.country : v6Info.country) : '';
  const isV4V6Split = !v4Info?.pending && !v6Info?.pending && !res.v4Unverified &&
    !!(v4Code && v6Code && v4Code !== v6Code);

  const lines = [];
  if (divergence) {
    lines.push('Sites see different IPs',
      `${divergence.primarySource}: ${divergence.primaryIp}${v4Code ? ` (${v4Code})` : ''}`,
      ...divergence.alts.map(alt => {
        const code = normalizeCountryCode(alt.geo?.countryCode);
        return `${alt.source}: ${alt.ip}${code ? ` (${code})` : ''}`;
      }));
  }
  if (isV4V6Split) {
    lines.push('Split Route Detected', `IPv4: ${getFullCountryName(v4Code, v4Info?.country)} (${v4Code}) | IPv6: ${getFullCountryName(v6Code, v6Info?.country)} (${v6Code})`);
  }
  const locating = v4Info?.pending === true || (!v4Info?.ip && v6Info?.pending === true);
  lines.push(primaryCode ? `Location: ${primaryName} (${primaryCode})`
    : `LeakHalo: ${locating ? 'locating…' : 'location unknown'} · ${v4Info?.ip || v6Info?.ip}`);
  const title = lines.join('\n');
  const warning = !!divergence || isV4V6Split;

  if (badgeMode === 'off') {
    return { icon: { kind: 'default' }, badgeText: warning ? '!' : '', badgeColor: '#f59e0b', title };
  }

  // Two flags: IPv4/IPv6 split first, otherwise a divergence whose routes are in different countries.
  const secondCode = isV4V6Split ? v6Code : (v4Code ? altCode : '');
  const icon = primaryCode && secondCode ? { kind: 'split', codes: [v4Code || primaryCode, secondCode] }
    : primaryCode ? { kind: 'flag', codes: [primaryCode] } : { kind: 'default' };

  let badgeText = '';
  let badgeColor = null;
  if (badgeMode === 'text' && primaryCode) {
    badgeText = primaryCode;
    badgeColor = warning ? '#f59e0b' : '#0284c7';
  } else if (divergence) {
    // Same-country or unknown-country divergence still needs a visible marker.
    badgeText = '!';
    badgeColor = '#f59e0b';
  }
  return { icon, badgeText, badgeColor, title };
}

async function renderPlannedIcon(icon) {
  if (icon.kind === 'grey') return (await renderDisconnectedIcon().catch(() => null)) || DEFAULT_ACTION_ICON;
  if (icon.kind === 'split') {
    const split = await renderSplitFlagIcon(icon.codes[0], icon.codes[1]).catch(() => null);
    if (split) return split;
  }
  if (icon.kind === 'split' || icon.kind === 'flag') {
    const flagPath = `/assets/flags/flag-${icon.codes[0].toLowerCase()}.png`;
    return { path: { "16": flagPath, "32": flagPath, "48": flagPath } };
  }
  return DEFAULT_ACTION_ICON;
}

// Renders are planned concurrently but applied one at a time, and a plan superseded by a newer
// call is dropped, so an older render can never overwrite newer state.
async function updateToolbarDisplay(v4Info, v6Info, isOffline = false, probeError = false) {
  const seq = ++toolbarRenderSeq;
  const plan = await planToolbar(v4Info, v6Info, isOffline, probeError).catch(() => null);
  if (!plan) return;
  toolbarApplyChain = toolbarApplyChain.catch(() => {}).then(async () => {
    if (seq !== toolbarRenderSeq) return;
    const key = JSON.stringify(plan);
    if (key === appliedToolbarKey) return;
    appliedToolbarKey = '';
    let iconOk = true;
    try {
      const rendered = await renderPlannedIcon(plan.icon);
      if (seq !== toolbarRenderSeq) return;
      await chrome.action.setIcon(rendered);
    } catch (e) {
      if (seq !== toolbarRenderSeq) return;
      try {
        await chrome.action.setIcon(DEFAULT_ACTION_ICON);
      } catch (err) {
        iconOk = false;
      }
    }
    if (seq !== toolbarRenderSeq) return;
    await chrome.action.setBadgeText({ text: plan.badgeText });
    if (seq !== toolbarRenderSeq) return;
    if (plan.badgeColor) {
      await chrome.action.setBadgeBackgroundColor({ color: plan.badgeColor });
      await chrome.action.setBadgeTextColor?.({ color: BADGE_TEXT[plan.badgeColor] || '#ffffff' });
    }
    if (seq !== toolbarRenderSeq) return;
    await chrome.action.setTitle({ title: plan.title });
    if (iconOk) appliedToolbarKey = key;
  });
  return toolbarApplyChain;
}

// Returns true when the change counts as announced (shown, or notifications are switched off) and
// false when it was throttled or failed, so the caller can retry it on a later probe.
// Resolves true only when Chrome actually created the notification.
function createNotification(id, options) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.create(id, options, () => resolve(!chrome.runtime.lastError));
    } catch (e) {
      resolve(false);
    }
  });
}

// One alert at a time per address family, so the throttle check and its timestamp cannot
// interleave between two checks.
const notifyChains = {};
function sendIPChangeNotification(type, oldIp, newGeo) {
  const run = (notifyChains[type] || Promise.resolve()).catch(() => false).then(() => deliverIPChangeNotification(type, oldIp, newGeo));
  notifyChains[type] = run;
  return run;
}

async function deliverIPChangeNotification(type, oldIp, newGeo) {
  try {
    const now = Date.now();
    // Throttled per address family, so an IPv4 and an IPv6 change in the same check both arrive.
    const throttleKey = `lastNotifTime${type}`;
    const stored = await chrome.storage.local.get([throttleKey, 'appSettings', 'announcedCountries']);
    const enableNotifs = stored.appSettings ? stored.appSettings.enableNotifications !== false : true;
    const newCode = normalizeCountryCode(newGeo.countryCode);
    const oldCode = normalizeCountryCode(stored.announcedCountries?.[type]);
    if (!enableNotifs) {
      if (newCode) await rememberAnnouncedCountry(type, newCode);
      else await forgetAnnouncedCountry(type);
      return true;
    }
    const lastNotif = stored[throttleKey] || 0;
    if (now - lastNotif < 4000) return false;

    // One notification per kind: a newer alert replaces the older one instead of piling up.
    const notifId = `leakhalo_ip_change_${type}`;
    // A new country is what matters most (a VPN that dropped, say), so it gets its own alert;
    // a new address in the same country is a routine change.
    const countryChanged = !!(oldCode && newCode && oldCode !== newCode);
    const flagEmoji = newCode ? ` (${newCode})` : '';
    const newCountryName = newCode ? getFullCountryName(newCode, newGeo.country) : '';
    const knownCountry = newCountryName ? ` in ${newCountryName}` : '';
    const message = countryChanged
      ? `Changed from ${oldIp} to ${newGeo.ip}: ${getFullCountryName(oldCode, '')} → ${newCountryName}`
      : oldIp
        ? `Changed from ${oldIp} to ${newGeo.ip}${knownCountry}`
        : `Connected with ${newGeo.ip}${knownCountry}`;

    let iconUrl = chrome.runtime.getURL('assets/icons/icon48.png');
    if (newCode) {
      const flagCandidate = chrome.runtime.getURL(`assets/flags/flag-${newCode.toLowerCase()}.png`);
      try {
        const flagRes = await fetch(flagCandidate, { method: 'HEAD' });
        if (flagRes.ok) iconUrl = flagCandidate;
      } catch (e) {}
    }

    const delivered = await createNotification(notifId, {
      type: 'basic',
      iconUrl: iconUrl,
      title: countryChanged ? `Country changed: ${oldCode} → ${newCode}` : `${type} IP Changed${flagEmoji}`,
      message: message,
      priority: 2
    });
    if (delivered) {
      await chrome.storage.local.set({ [throttleKey]: now });
      if (newCode) await rememberAnnouncedCountry(type, newCode);
      else await forgetAnnouncedCountry(type);
    }
    return delivered;
  } catch (e) {
    return false;
  }
}

// The country of the address the user was last told about, per family, so an alert can say
// whether the country changed.
async function rememberAnnouncedCountry(type, code) {
  const { announcedCountries } = await chrome.storage.local.get('announcedCountries');
  if (announcedCountries?.[type] !== code) await chrome.storage.local.set({ announcedCountries: { ...(announcedCountries || {}), [type]: code } });
}

async function forgetAnnouncedCountry(type) {
  const { announcedCountries } = await chrome.storage.local.get('announcedCountries');
  if (announcedCountries?.[type]) {
    const updated = { ...announcedCountries };
    delete updated[type];
    await chrome.storage.local.set({ announcedCountries: updated });
  }
}

// Resolves true once the divergence counts as announced (shown, or notifications are off). False
// while the opt-in warning is off or the alert was throttled or failed, so it is retried later.
async function sendRouteDivergenceNotification(divergence, primaryInfo) {
  try {
    const now = Date.now();
    // Separate throttle: an IP-change notification a moment earlier must not swallow this one.
    const stored = await chrome.storage.local.get(['lastRouteNotifTime', 'appSettings']);
    if (stored.appSettings?.warnRouteDivergence !== true) return false; // warning is opt-in
    if (stored.appSettings && stored.appSettings.enableNotifications === false) return true;
    if (now - (stored.lastRouteNotifTime || 0) < 4000) return false;
    const where = (ip, info) => normalizeCountryCode(info?.countryCode) ? `${ip} (${info.country})` : ip;
    const alts = divergence.alts.map(alt => `${alt.source}: ${where(alt.ip, alt.geo)}`).join('\n');
    const delivered = await createNotification('leakhalo_route_divergence', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon48.png'),
      title: 'Sites see different IPs',
      message: `${divergence.primarySource}: ${where(divergence.primaryIp, primaryInfo)}\n${alts}\nA proxy, VPN rule or your internet provider's routing sends some sites through a different IP.`,
      priority: 2
    });
    if (delivered) await chrome.storage.local.set({ lastRouteNotifTime: now });
    return delivered;
  } catch (e) {
    return false;
  }
}

chrome.notifications?.onClicked?.addListener((id) => chrome.notifications.clear(id));

// Answers from IP and location services are a few hundred bytes; anything far larger is not one.
const MAX_RESPONSE_BYTES = 64 * 1024;
async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
  await providerCooldownReady;
  const origin = new URL(url).origin;
  if (isOriginCoolingDown(origin)) throw new Error('Provider cooling down');
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  let onExternalAbort = null;
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(id);
      controller.abort();
    } else {
      onExternalAbort = () => controller.abort();
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  try {
    const res = await fetch(url, {
      ...options,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    });
    if (res.status === 429) {
      const retryAfter = res.headers?.get?.('Retry-After');
      const seconds = Number(retryAfter);
      const parsed = Number.isFinite(seconds) && seconds > 0
        ? seconds * 1000
        : Math.max(0, Date.parse(retryAfter || '') - Date.now());
      await markProviderCooldown(origin, Math.min(24 * 60 * 60_000, Math.max(5 * 60_000, parsed || 0)));
    }
    if (res.status === 403) {
      await markProviderCooldown(origin, 120_000);
    }
    // Error answers are never read by the callers: release the body instead of downloading it.
    const length = Number(res.headers?.get?.('Content-Length'));
    if (!res.ok || length > MAX_RESPONSE_BYTES) {
      res.body?.cancel?.().catch(() => {});
      if (res.ok) throw new Error('Response too large');
      return { ok: false, status: res.status, headers: res.headers, text: async () => '', json: async () => { throw new Error('No body'); } };
    }
    let body = '';
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let totalBytes = 0;
      const onAbort = () => { reader.cancel().catch(() => {}); };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw new Error('Timed out');
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error('Response too large');
          }
          body += decoder.decode(value, { stream: true });
        }
        if (controller.signal.aborted) throw new Error('Timed out');
        body += decoder.decode();
      } catch (err) {
        if (controller.signal.aborted) throw new Error('Timed out');
        throw err;
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }
    } else {
      const aborted = new Promise((_, reject) => {
        if (controller.signal.aborted) reject(new Error('Timed out'));
        controller.signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
      });
      body = await Promise.race([res.text(), aborted]);
      if (body.length > MAX_RESPONSE_BYTES) throw new Error('Response too large');
    }
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text: async () => body,
      json: async () => JSON.parse(body)
    };
  } finally {
    clearTimeout(id);
    if (options.signal && onExternalAbort) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

// A public IP is never in these ranges: a captive portal or local proxy answering a request must
// not be taken for the address websites see. (Documentation ranges stay valid; tests use them.)
function isNonPublicIPv4(parts) {
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 0) || (a === 198 && (b === 18 || b === 19));
}

function isValidIPv4(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.trim().split('.');
  return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) &&
    !isNonPublicIPv4(parts.map(Number));
}

function isValidIPv6(ip) {
  if (typeof ip !== 'string') return false;
  ip = ip.trim();
  if (!ip.includes(':') || ip.length > 39 || !/^[0-9a-f:]+$/i.test(ip)) return false;
  let canonical;
  try {
    canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch (e) {
    return false;
  }
  // Unspecified, loopback, IPv4-mapped, NAT64, discard-only, link-local, site-local, unique-local and multicast addresses.
  return !(canonical === '::' || canonical === '::1' || canonical.startsWith('::ffff:') ||
    canonical.startsWith('64:ff9b:') || canonical.startsWith('100::') || /^fe[89abcdef][0-9a-f]:/.test(canonical) ||
    /^f[cd][0-9a-f]{2}:/.test(canonical) || /^ff[0-9a-f]{2}:/.test(canonical));
}

// IPv4 is discovered from two independent vantage points at once:
//   edge        – Cloudflare's network (trace endpoint, then icanhazip, which Cloudflare operates)
//   independent – ipify, then Amazon's checkip
// Proxies, VPN rules and provider routing can send some destinations through another public IP,
// so the two may legitimately see different public IPs. The displayed IP always comes from the
// edge group (falling back to the independent group), so the answer never depends on which
// endpoint happened to respond first or on whether the popup is open.
async function firstIPv4(sources) {
  for (const source of sources) {
    try { return await source(); } catch (e) {}
  }
  return null;
}

// On dual-stack networks Chrome reaches cloudflare.com over IPv6, so its trace reports the IPv6
// address. Then icanhazip (IPv4-only, also on Cloudflare's network) answers instead, and for a
// while the trace is skipped rather than costing every check an extra round trip.
const CF_TRACE_V6_SKIP_MS = 10 * 60_000;
let cfTraceV6Until = 0;

async function probePublicIPv4(isManual = false) {
  if (isManual) {
    cfTraceV6Until = 0;
    clearNetworkCooldowns();
  }
  const buster = `_t=${Date.now()}`;
  const plain = (url, source) => () => fetchWithTimeout(url, {}, 2000).then(async (res) => {
    if (!res.ok) throw new Error();
    const ip = ((await res.text()) || '').trim();
    if (isValidIPv4(ip)) return { ip, countryCode: '', source };
    throw new Error();
  });
  const cloudflare = () => fetchWithTimeout(`https://cloudflare.com/cdn-cgi/trace?${buster}`, {}, 2000).then(async (res) => {
    if (!res.ok) throw new Error();
    const text = await res.text();
    const ipMatch = text.match(/^ip=([^\r\n]+)/m);
    const locMatch = text.match(/^loc=([^\r\n]+)/m);
    if (ipMatch && ipMatch[1].includes(':')) cfTraceV6Until = Date.now() + CF_TRACE_V6_SKIP_MS;
    if (ipMatch && isValidIPv4(ipMatch[1].trim())) {
      return {
        ip: ipMatch[1].trim(),
        countryCode: locMatch && locMatch[1] ? normalizeCountryCode(locMatch[1]) : '',
        source: 'Cloudflare'
      };
    }
    throw new Error();
  });
  const ipify = () => fetchWithTimeout(`https://api.ipify.org?format=json&${buster}`, {}, 2000).then(async (res) => {
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data && isValidIPv4(data.ip)) return { ip: data.ip.trim(), countryCode: '', source: 'ipify' };
    throw new Error();
  });
  const identMe = () => plain(`https://v4.ident.me?${buster}`, 'ident.me')();
  const seeIp = () => plain(`https://ipv4.seeip.org?${buster}`, 'seeip')();

  const edgeSources = [];
  if (Date.now() >= cfTraceV6Until && !isOriginCoolingDown('https://cloudflare.com')) {
    edgeSources.push(cloudflare);
  }
  edgeSources.push(plain(`https://ipv4.icanhazip.com?${buster}`, 'icanhazip'));

  const [edge, independent] = await Promise.all([
    firstIPv4(edgeSources),
    firstIPv4([ipify, identMe, seeIp])
  ]);

  return { edge, independent };
}

const ROUTE_PAIR_TTL_MS = 2 * 60_000;   // "consecutive" probes must also be close in time
// A mismatch must also last this long: while a VPN connects, old connections keep the previous
// route for a few seconds, and fast checks would otherwise report that transition as a split.
let ROUTE_MIN_PERSIST_MS = 15_000;
const PRIMARY_INDEPENDENT_SOURCE = 'ipify'; // the independent group's first provider
const FALLBACK_CONFIRMATIONS = 2;        // independent-only answers needed to replace an edge IP
const GROUP_MISSES_AS_KNOWN = 2;         // a group silent this long no longer vouches for an old IP
// After the edge group has been silent this long, earlier alternate-route evidence no longer holds
// the shown IP: a new independent answer is then accepted after FALLBACK_CONFIRMATIONS probes.
let EDGE_SILENT_RELEASE_MS = 3 * 60_000;

// Pure decision step for one IPv4 probe (no I/O). Inputs:
//   observation  { edge, independent } answers ({ ip, countryCode, source }) or null
//   cachedV4     the IPv4 currently shown ({ ip, vantage: 'edge' | 'independent', ... }) or null
//   state        persisted { announcedIp, lastPairKeys, lastPairAt, edgeMisses, indepMisses, fallback }
//   divergence   persisted { primaryIp, primarySource, alts: [{ source, ip, geo, geoAt, since }], since }
// Model:
//   * Shown IP: the edge answer. Without it, an independent answer that is known alternate-route
//     evidence never replaces the shown IP (held, "Verifying"); a new independent value replaces an
//     edge-derived IP only after it is seen in FALLBACK_CONFIRMATIONS consecutive probes.
//   * Divergence evidence is kept per independent provider. A provider's evidence is confirmed by
//     the same mismatch in two strictly consecutive probes and removed only when that provider
//     itself agrees with the edge or reports a different IP. Fallback providers never erase it.
//   * Notifications compare the shown IP with announcedIp, the last IP the user was told about.
//     A change is announced once no vantage point that could still see the old IP does, so
//     staggered switches, reverts and successive changes produce exactly one correct message.
function evaluateIPv4Route(observation, cachedV4, state, divergence, now = Date.now()) {
  const { edge, independent } = observation;
  // IPv4 identity survives probes where IPv4 is briefly absent (IPv6-only answers), so evidence
  // and holds keep applying when it returns.
  const ref = cachedV4?.ip ? cachedV4 : (state?.lastV4?.ip ? state.lastV4 : null);
  const cachedIp = ref?.ip || null;
  const st = {
    announcedIp: state?.announcedIp || cachedIp,
    // A split candidate survives while it keeps being observed (TTL between observations).
    lastPairKeys: (state?.lastPairKeys || []).filter(k => now - (state?.pairSeen?.[k] || state?.lastPairAt || 0) <= ROUTE_PAIR_TTL_MS),
    pairSince: {},
    pairSeen: {},
    lastPairAt: now,
    edgeMisses: edge ? 0 : Math.min(GROUP_MISSES_AS_KNOWN, (state?.edgeMisses || 0) + 1),
    indepMisses: independent ? 0 : Math.min(GROUP_MISSES_AS_KNOWN, (state?.indepMisses || 0) + 1),
    edgeSilentSince: edge ? null : (state?.edgeSilentSince || now),
    fallback: null, // strictly consecutive: only the independent-only branch below keeps it
    lastV4: ref ? { ip: ref.ip, vantage: ref.vantage || 'edge' } : null,
    // Independent IPs seen disagreeing with the edge for the IP currently shown (confirmed or not).
    altSeen: state?.altSeen && state.altSeen.primaryIp === cachedIp ? { primaryIp: cachedIp, list: [...state.altSeen.list] } : { primaryIp: cachedIp, list: [] }
  };
  let div = divergence && cachedIp && divergence.primaryIp === cachedIp && Array.isArray(divergence.alts)
    ? { ...divergence, alts: divergence.alts.map(alt => ({ ...alt })) }
    : null;

  // 1. The IPv4 to show.
  let primary = null;
  let held = false;
  if (edge) {
    primary = { ...edge, vantage: 'edge' };
    st.fallback = null;
  } else if (independent) {
    const edgeLongSilent = now - st.edgeSilentSince >= EDGE_SILENT_RELEASE_MS;
    const knownAlternate = !edgeLongSilent && ((!!div && div.alts.some(alt => alt.ip === independent.ip)) ||
      st.altSeen.list.some(seen => seen.ip === independent.ip));
    if (independent.ip === cachedIp) {
      primary = { ...independent, vantage: ref.vantage || 'independent' };
    } else if (cachedIp && knownAlternate) {
      held = true;
    } else if (!cachedIp || ref.vantage === 'independent') {
      primary = { ...independent, vantage: 'independent' };
    } else {
      const prev = state?.fallback;
      st.fallback = prev?.ip === independent.ip
        ? { ip: independent.ip, count: prev.count + 1 }
        : { ip: independent.ip, count: 1 };
      if (st.fallback.count >= FALLBACK_CONFIRMATIONS) {
        primary = { ...independent, vantage: 'independent' };
        st.fallback = null;
      } else {
        held = true;
      }
    }
  }
  // With no IPv4 answer at all nothing was learned, so keep what is shown and all evidence. The
  // shown IPv4 is held ("Verifying") until both groups have missed GROUP_MISSES_AS_KNOWN probes in
  // a row: a single timeout on a dual-stack network must not drop the IPv4 card.
  const noAnswer = !edge && !independent;
  if (noAnswer && cachedIp && !(st.edgeMisses >= GROUP_MISSES_AS_KNOWN && st.indepMisses >= GROUP_MISSES_AS_KNOWN)) held = true;
  const shownIp = primary ? primary.ip : (held ? cachedIp : null);
  if (div && shownIp !== div.primaryIp) div = null; // the shown IP moved: old evidence is stale
  if (st.altSeen.primaryIp !== shownIp) st.altSeen = { primaryIp: shownIp, list: [] };
  if (primary) st.lastV4 = { ip: primary.ip, vantage: primary.vantage };

  // 2. Divergence evidence, per independent provider.
  const confirmed = [];
  const pairKeys = [];
  if (edge && independent) {
    const own = div ? div.alts.find(alt => alt.source === independent.source) : null;
    if (edge.ip === independent.ip) {
      if (independent.source === PRIMARY_INDEPENDENT_SOURCE) {
        // The independent group's main provider agrees: evidence a fallback provider left while it
        // was unavailable is no longer backed by anything (that fallback is asked only when it fails).
        if (div) div.alts = [];
        st.altSeen.list = [];
      } else {
        if (own) div.alts = div.alts.filter(alt => alt !== own); // this provider now agrees
        st.altSeen.list = st.altSeen.list.filter(seen => seen.source !== independent.source);
      }
    } else {
      if (edge.ip === shownIp && !st.altSeen.list.some(seen => seen.source === independent.source && seen.ip === independent.ip)) {
        st.altSeen.list = [...st.altSeen.list.filter(seen => seen.source !== independent.source), { source: independent.source, ip: independent.ip }].slice(-4);
      }
      // Keyed by the IP pair, not the provider: ipify and its fallback seeing the same alternate
      // IP is the same evidence.
      const key = `${edge.ip}|${independent.ip}`;
      pairKeys.push(key);
      const since = st.lastPairKeys.includes(key) && state?.pairSince?.[key] ? state.pairSince[key] : now;
      st.pairSince[key] = since;
      st.pairSeen[key] = now;
      if (own && own.ip !== independent.ip) div.alts = div.alts.filter(alt => alt !== own); // contradicted
      const still = !!div && div.alts.some(alt => alt.ip === independent.ip);
      if (!still && st.lastPairKeys.includes(key) && now - since >= ROUTE_MIN_PERSIST_MS) {
        if (!div) div = { primaryIp: edge.ip, primarySource: edge.source, alts: [], since: now };
        const alt = { source: independent.source, ip: independent.ip, geo: null, geoAt: 0, since: now };
        div.alts.push(alt);
        confirmed.push(alt);
      }
    }
    if (div) div.primarySource = edge.source;
  } else if (independent) {
    // Without an edge answer a provider can still withdraw its own evidence: it no longer sees
    // the alternate IP it reported.
    if (div) div.alts = div.alts.filter(alt => alt.source !== independent.source || alt.ip === independent.ip);
    st.altSeen.list = st.altSeen.list.filter(seen => seen.source !== independent.source || seen.ip === independent.ip);
  }
  if (div && !div.alts.length) div = null;
  if (edge && independent) {
    st.lastPairKeys = pairKeys; // agreement or a different pair replaces the candidate
  } else {
    // An incomplete probe (one side or both missing) is neutral unless an answering side
    // contradicts the candidate; on a flaky network it must not restart the persistence clock.
    st.lastPairKeys = st.lastPairKeys.filter(k => {
      const [kEdge, kAlt] = k.split('|');
      return !(edge && edge.ip !== kEdge) && !(independent && independent.ip !== kAlt);
    });
    for (const k of st.lastPairKeys) {
      st.pairSince[k] = state?.pairSince?.[k] || now;
      st.pairSeen[k] = state?.pairSeen?.[k] || state?.lastPairAt || now;
    }
  }

  // 3. Change notification against the last announced IP.
  let notify = null;
  if (!st.announcedIp) {
    st.announcedIp = shownIp; // first result: a baseline, not a change
  } else if (!noAnswer && shownIp && shownIp !== st.announcedIp) {
    const stillSeen = [edge?.ip, independent?.ip].includes(st.announcedIp);
    const edgeSettled = !!edge || st.edgeMisses >= GROUP_MISSES_AS_KNOWN;
    const indepSettled = !!independent || st.indepMisses >= GROUP_MISSES_AS_KNOWN;
    const isKnownSplit = !!div && div.alts.some(alt => alt.ip === st.announcedIp);
    // The caller advances announcedIp only after the notification is delivered (or notifications
    // are off), so a throttled announcement is retried with the correct "from".
    if (!stillSeen && !isKnownSplit && edgeSettled && indepSettled) notify = { from: st.announcedIp, to: shownIp };
  }

  return { primary, held, state: st, divergence: div, confirmed, notify };
}

// Canonical (compressed, lower-case) IPv6, so two spellings of one address compare equal.
function canonicalIPv6(ip) {
  try { return new URL(`http://[${ip.trim()}]/`).hostname.slice(1, -1); } catch (e) { return ip.trim().toLowerCase(); }
}

// Cloudflare's edge first (icanhazip), like IPv4, so a Split Route compares the two address
// families from the same vantage point. Networks that silently drop IPv6 (VPN kill switches)
// would otherwise cost two full timeouts: ipify starts after IPV6_HEDGE_MS or as soon as
// icanhazip fails, and the wait never exceeds IPV6_TIMEOUT_MS.
const IPV6_TIMEOUT_MS = 2200;
const IPV6_HEDGE_MS = 700;
function getFastPublicIPv6() {
  const buster = `_t=${Date.now()}`;
  const icanhazip = () => fetchWithTimeout(`https://ipv6.icanhazip.com?${buster}`, {}, IPV6_TIMEOUT_MS).then(async (res) => {
    if (!res.ok) throw new Error();
    const text = await res.text();
    if (isValidIPv6(text?.trim())) return canonicalIPv6(text);
    throw new Error();
  });
  const ipify = (timeoutMs) => fetchWithTimeout(`https://api6.ipify.org?format=json&${buster}`, {}, timeoutMs).then(async (res) => {
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data && isValidIPv6(data.ip)) return canonicalIPv6(data.ip);
    throw new Error();
  });
  const identMe = (timeoutMs) => fetchWithTimeout(`https://v6.ident.me?${buster}`, {}, timeoutMs).then(async (res) => {
    if (!res.ok) throw new Error();
    const text = await res.text();
    if (isValidIPv6(text?.trim())) return canonicalIPv6(text);
    throw new Error();
  });
  const seeIp = (timeoutMs) => fetchWithTimeout(`https://ipv6.seeip.org?${buster}`, {}, timeoutMs).then(async (res) => {
    if (!res.ok) throw new Error();
    const text = await res.text();
    if (isValidIPv6(text?.trim())) return canonicalIPv6(text);
    throw new Error();
  });
  return new Promise((resolve) => {
    const started = Date.now();
    let primaryDone = false, primaryIp = null, backup = null, settled = false;
    const finish = (ip) => { if (!settled) { settled = true; clearTimeout(hedge); resolve(ip); } };
    const startBackup = () => {
      if (backup) return;
      const remainingMs = Math.max(300, IPV6_TIMEOUT_MS - (Date.now() - started));
      backup = Promise.any([
        ipify(remainingMs),
        identMe(remainingMs),
        seeIp(remainingMs)
      ])
        .then(ip => { if (!primaryDone || !primaryIp) finish(ip); return ip; })
        .catch(() => { if (primaryDone) finish(primaryIp); return null; });
    };
    const hedge = setTimeout(startBackup, IPV6_HEDGE_MS);
    icanhazip().then(ip => { primaryDone = true; primaryIp = ip; finish(ip); }).catch(() => {
      primaryDone = true;
      if (backup) backup.then(() => finish(null)); else { clearTimeout(hedge); startBackup(); backup.then(() => finish(null)); }
    });
  });
}

const regionNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { return null; }
})();

function getFullCountryName(code, fallbackName) {
  const cleanCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const shortNames = { PS: 'Palestine' };
  if (cleanCode && shortNames[cleanCode]) return shortNames[cleanCode];
  if (cleanCode && regionNames) {
    try {
      const name = regionNames.of(cleanCode);
      if (name && name !== cleanCode) return name;
    } catch (e) {}
  }
  const cleanFallback = (typeof fallbackName === 'string' && !fallbackName.startsWith('Unknown') && !fallbackName.startsWith('Detected')) ? fallbackName : '';
  if (cleanFallback && cleanFallback.length > 2) {
    return cleanFallback;
  }
  return cleanCode || cleanFallback || 'Unknown Country';
}

// Pseudo codes that are not countries: XX/ZZ unknown, T1 Tor, A1/A2 anonymous proxy and
// satellite, O1 other, EU/AP regions. They must never show as a country or a flag.
const PSEUDO_COUNTRY_CODES = new Set(['XX', 'ZZ', 'T1', 'A1', 'A2', 'O1', 'EU', 'AP']);
function normalizeCountryCode(code) {
  if (typeof code !== 'string' || !/^[a-z]{2}$/i.test(code.trim())) return '';
  const upper = code.trim().toUpperCase();
  return PSEUDO_COUNTRY_CODES.has(upper) ? '' : upper;
}

function normalizeCoordinate(value, limit) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

// Some services answer 0,0 ("Null Island") when they have no location: that is no location.
function normalizeLatLon(lat, lon) {
  const la = normalizeCoordinate(lat, 90), lo = normalizeCoordinate(lon, 180);
  return la === null || lo === null || (la === 0 && lo === 0) ? { lat: null, lon: null } : { lat: la, lon: lo };
}

// Placeholder words some services use for an unknown city or region.
function cleanPlace(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^(unknown|n\/?a|none|null|-+)$/i.test(text) ? '' : text;
}

// "AS13335 Cloudflare, Inc." → { asn: 'AS13335', name: 'Cloudflare, Inc.' }
function splitAsnPrefix(org) {
  const match = (org || '').match(/^(AS\d+)\s*[-_:|]?\s*(.*)$/i);
  return match ? { asn: match[1].toUpperCase(), name: match[2] || match[1].toUpperCase() } : { asn: '', name: org || '' };
}

// Matched as whole words, so "cloud" no longer catches an ISP in St. Cloud and "aws" no word
// that merely contains it. Relay and mobile networks are checked before datacenters: Cloudflare
// WARP runs on Cloudflare's network but is a relay, not a hosting provider.
const RELAY_PATTERN = /\b(cloudflare warp|icloud private relay|private relay|mullvad|proton ?vpn|proton ag|nordvpn|nord security|expressvpn|express vpn|surfshark|windscribe|ivpn|private internet access|cyberghost|hide\.me|tor exit|vpn)\b/i;
const MOBILE_PATTERN = /\b(mobile|cellular|irancell|mtn irancell|mobile communication company of iran|rightel|t-mobile|verizon wireless|vodafone mobile)\b/i;
const DATACENTER_PATTERN = new RegExp('\\b(' + [
  'hetzner', 'ovh', 'ovhcloud', 'digitalocean', 'amazon', 'aws', 'google cloud', 'linode', 'akamai',
  'vultr', 'm247', 'leaseweb', 'choopa', 'oracle', 'cloudflare', 'fastly', 'serverius', 'contabo',
  'hostinger', 'tencent', 'alibaba', 'azure', 'microsoft', 'datacenter', 'data center', 'data centre', 'hosting',
  '(?<!st\\.? )cloud', 'servers?', 'vps', 'dedicated', 'colocation', 'hivelocity', 'cogent', 'psychz', 'quadranet',
  'scaleway', 'equinix', 'ipvolume', 'datacamp', 'stark industries', 'aeza',
  'frantech', 'buyvm', 'constant company', 'amanah', 'tzulo', 'zenlayer', 'packet', 'iomart', 'upcloud', 'kamatera',
  'worldstream', 'velia', 'ionos', '1and1', 'strato', 'aruba', 'selectel', 'timeweb', 'reg\\.ru', 'beget',
  'gcore', 'edgecenter', 'cdn77', 'latitude\\.sh', 'cherry servers'
].join('|') + ')\\b', 'i');

function classifyConnectionType(data) {
  const text = [data.isp, data.org, data.domain].filter(Boolean).join(' ');
  const rawType = (data.type || '').toLowerCase();

  if (data.isVpn || data.isProxy || rawType === 'vpn' || rawType === 'proxy') return 'VPN / Relay';
  if (RELAY_PATTERN.test(text)) return 'VPN / Relay';
  if (data.isMobile || rawType === 'cellular' || rawType === 'mobile') return 'Mobile';
  if (MOBILE_PATTERN.test(text)) return 'Mobile';
  if (data.isHosting || rawType === 'hosting' || rawType === 'datacenter') return 'Datacenter';
  if (DATACENTER_PATTERN.test(text)) return 'Datacenter';
  if (['residential', 'isp', 'broadband'].includes(rawType)) return 'Residential';
  return 'Unknown';
}

// Recent lookups survive the service worker being stopped (session storage is memory only), so
// switching back and forth between VPN exits does not ask the location services again.
const GEO_CACHE_KEY = 'geoMemoryCache';
const geoCacheReady = (chrome.storage.session?.get(GEO_CACHE_KEY) || Promise.resolve({})).then((saved) => {
  for (const [ip, info] of Object.entries(saved?.[GEO_CACHE_KEY] || {})) if (!geoMemoryCache.has(ip)) geoMemoryCache.set(ip, info);
}).catch(() => {});

function rememberGeo(ip, info) {
  const now = Date.now();
  for (const [k, v] of geoMemoryCache.entries()) {
    if (!v?.updatedAt || now - v.updatedAt >= GEO_MEMORY_CACHE_MS) geoMemoryCache.delete(k);
  }
  geoMemoryCache.delete(ip);
  geoMemoryCache.set(ip, info);
  if (geoMemoryCache.size > 8) geoMemoryCache.delete(geoMemoryCache.keys().next().value);
  chrome.storage.session?.set({ [GEO_CACHE_KEY]: Object.fromEntries(geoMemoryCache) }).catch(() => {});
}

async function getGeoLocation(ip, initialCountryCode = '', useRecentCache = true) {
  await geoCacheReady;
  const cached = useRecentCache ? geoMemoryCache.get(ip) : null;
  if (cached && Date.now() - cached.updatedAt < GEO_MEMORY_CACHE_MS) {
    geoMemoryCache.delete(ip);
    geoMemoryCache.set(ip, cached);
    return { ...cached, updatedAt: Date.now() };
  }
  const deadline = Date.now() + GEO_LOOKUP_TIMEOUT_MS;
  const result = await withTimeout(fetchGeoLocation(ip, initialCountryCode, deadline), GEO_LOOKUP_TIMEOUT_MS,
    () => unresolvedGeoInfo(ip, initialCountryCode));
  // Only complete answers are remembered: a failed or country-only lookup is retried later.
  if (!geoIncomplete(result)) rememberGeo(ip, result);
  return result;
}

// After a provider fails, the next one is tried only while the lookup's deadline has not passed,
// so a lookup that already timed out stops sending requests.
// Hedged waterfall: starts primary geo provider, and hedges with fallbacks if delayed or errored.
async function fetchGeoLocation(ip, initialCountryCode = '', deadline = Infinity) {
  if (!isValidIPv4(ip) && !isValidIPv6(ip)) throw new Error('Invalid IP address');
  const hedgeController = new AbortController();
  const hedgeSignal = hedgeController.signal;
  const timeLeft = (ms) => Math.min(ms, deadline - Date.now());

  const tryIpwho = async () => {
    if (timeLeft(3000) <= 0) throw new Error('Timeout');
    const res = await fetchWithTimeout(`https://ipwho.is/${ip}`, { signal: hedgeSignal }, timeLeft(3000));
    if (!res.ok) throw new Error('ipwho failed');
    const data = await res.json();
    if (data && data.success === false && /limit|quota|too many/i.test(data.message || '')) {
      await markProviderCooldown('https://ipwho.is', 15 * 60_000);
    }
    if (!data || !data.success) throw new Error('ipwho invalid');
    const countryCode = normalizeCountryCode(data.country_code) || normalizeCountryCode(initialCountryCode);
    const countryName = getFullCountryName(countryCode, data.country);
    const ispStr = (data.connection && (data.connection.isp || data.connection.org)) || 'N/A';
    const connType = classifyConnectionType({
      isp: ispStr,
      org: data.connection?.org,
      domain: data.connection?.domain,
      type: data.connection?.type,
      isVpn: data.connection?.is_vpn,
      isProxy: data.connection?.is_proxy,
      isHosting: data.connection?.is_datacenter
    });
    return {
      ip, country: countryName, countryCode,
      city: cleanPlace(data.city), region: cleanPlace(data.region),
      isp: ispStr, asn: data.connection && data.connection.asn ? `AS${data.connection.asn}` : 'N/A',
      timezone: (data.timezone && data.timezone.id) || 'N/A',
      connectionType: connType, ...normalizeLatLon(data.latitude, data.longitude), updatedAt: Date.now()
    };
  };

  const tryGeojs = async () => {
    if (timeLeft(3000) <= 0) throw new Error('Timeout');
    const res = await fetchWithTimeout(`https://get.geojs.io/v1/ip/geo/${ip}.json`, { signal: hedgeSignal }, timeLeft(3000));
    if (!res.ok) throw new Error('geojs failed');
    const data = await res.json();
    if (!data || (!data.country_code && !data.country)) throw new Error('geojs invalid');
    const countryCode = normalizeCountryCode(data.country_code) || normalizeCountryCode(initialCountryCode);
    const countryName = getFullCountryName(countryCode, data.country);
    const org = splitAsnPrefix(data.organization);
    const asnStr = data.asn ? `AS${data.asn}` : (org.asn || 'N/A');
    const ispStr = data.organization_name || org.name || 'N/A';
    const connType = classifyConnectionType({ isp: ispStr, org: data.organization || data.organization_name });
    return {
      ip, country: countryName, countryCode,
      city: cleanPlace(data.city), region: cleanPlace(data.region),
      isp: ispStr, asn: asnStr, timezone: data.timezone || 'N/A',
      connectionType: connType, ...normalizeLatLon(data.latitude, data.longitude), updatedAt: Date.now()
    };
  };

  const trySeeip = async () => {
    if (timeLeft(3000) <= 0) throw new Error('Timeout');
    const res = await fetchWithTimeout(`https://api.seeip.org/geoip/${ip}`, { signal: hedgeSignal }, timeLeft(3000));
    if (!res.ok) throw new Error('seeip failed');
    const data = await res.json();
    if (!data || (!data.country_code && !data.country)) throw new Error('seeip invalid');
    const countryCode = normalizeCountryCode(data.country_code) || normalizeCountryCode(initialCountryCode);
    const countryName = getFullCountryName(countryCode, data.country);
    const org = splitAsnPrefix(data.organization);
    const asnStr = data.asn ? (String(data.asn).startsWith('AS') ? String(data.asn) : `AS${data.asn}`) : (org.asn || 'N/A');
    const ispStr = org.name || data.organization || 'N/A';
    const connType = classifyConnectionType({ isp: ispStr, org: data.organization });
    return {
      ip, country: countryName, countryCode,
      city: cleanPlace(data.city), region: cleanPlace(data.region),
      isp: ispStr, asn: asnStr, timezone: data.timezone || 'N/A',
      connectionType: connType, ...normalizeLatLon(data.latitude, data.longitude), updatedAt: Date.now()
    };
  };

  const tryIpinfo = async () => {
    if (timeLeft(3000) <= 0) throw new Error('Timeout');
    const res = await fetchWithTimeout(`https://ipinfo.io/${ip}/json`, { signal: hedgeSignal }, timeLeft(3000));
    if (!res.ok) throw new Error('ipinfo failed');
    const data = await res.json();
    if (data?.error && /limit|quota|too many/i.test(JSON.stringify(data.error))) {
      await markProviderCooldown('https://ipinfo.io', 15 * 60_000);
    }
    if (!data || (!data.country && !data.org) || data.error) throw new Error('ipinfo invalid');
    const countryCode = normalizeCountryCode(data.country) || normalizeCountryCode(initialCountryCode);
    const countryName = getFullCountryName(countryCode, '');
    const [lat, lon] = typeof data.loc === 'string' ? data.loc.split(',') : [];
    const org = splitAsnPrefix(data.org);
    const asnStr = org.asn || 'N/A';
    const ispStr = org.name || 'N/A';
    const connType = classifyConnectionType({ isp: ispStr, org: data.org });
    return {
      ip, country: countryName, countryCode,
      city: cleanPlace(data.city), region: cleanPlace(data.region),
      isp: ispStr, asn: asnStr, timezone: data.timezone || 'N/A',
      connectionType: connType, ...normalizeLatLon(lat, lon), updatedAt: Date.now()
    };
  };

  return new Promise((resolve) => {
    let resolved = false;
    let pendingCount = 0;
    const timers = [];

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      timers.forEach(t => clearTimeout(t));
      try { hedgeController.abort(); } catch (e) {}
      resolve(result || unresolvedGeoInfo(ip, initialCountryCode));
    };

    let p2Started = false;
    let p34Started = false;

    const startP34 = () => {
      if (p34Started || resolved) return;
      p34Started = true;
      pendingCount += 2;
      trySeeip().then(finish).catch(() => {
        pendingCount--;
        if (pendingCount <= 0) finish(null);
      });
      tryIpinfo().then(finish).catch(() => {
        pendingCount--;
        if (pendingCount <= 0) finish(null);
      });
    };

    const startP2 = () => {
      if (p2Started || resolved) return;
      p2Started = true;
      pendingCount++;
      const timerP34 = setTimeout(startP34, 1200);
      timers.push(timerP34);
      tryGeojs().then(finish).catch(() => {
        clearTimeout(timerP34);
        startP34();
        pendingCount--;
        if (pendingCount <= 0) finish(null);
      });
    };

    pendingCount++;
    const timerP2 = setTimeout(startP2, 1200);
    timers.push(timerP2);
    tryIpwho().then(finish).catch(() => {
      clearTimeout(timerP2);
      startP2();
      pendingCount--;
      if (pendingCount <= 0) finish(null);
    });
  });
}

// Result when no geolocation provider answered: never a "Locating..." placeholder.
function unresolvedGeoInfo(ip, initialCountryCode = '') {
  const resolvedCode = normalizeCountryCode(initialCountryCode);
  return {
    ip: ip,
    country: getFullCountryName(resolvedCode, ''),
    countryCode: resolvedCode,
    city: '',
    region: '',
    isp: 'N/A',
    asn: 'N/A',
    timezone: 'N/A',
    connectionType: 'Unknown',
    lat: null,
    lon: null,
    updatedAt: Date.now()
  };
}

function makePendingGeoInfo(ip, countryCode = '') {
  const code = normalizeCountryCode(countryCode);
  return {
    ip,
    country: code ? getFullCountryName(code, '') : 'Locating...',
    countryCode: code,
    pending: true, // placeholder until geolocation answers; always re-enriched on the next probe
    city: '',
    region: '',
    isp: 'N/A',
    asn: 'N/A',
    timezone: 'N/A',
    connectionType: 'Unknown',
    lat: null,
    lon: null,
    updatedAt: Date.now()
  };
}

// Plain reachability check, independent of CORS headers and provider cooldowns: any HTTP answer,
// even an error page, proves a working connection.
async function internetReachable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  const ping = (url) => fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
  const urls = ['https://cloudflare.com/cdn-cgi/trace', 'https://api.ipify.org/', 'https://checkip.amazonaws.com/'];
  try {
    await Promise.any(urls.map(ping));
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort(); // the first answer decides; the others need not finish
  }
}

// repeat: keep retrying every 15 s after the quick steps. Without it (the browser itself reports
// offline, so the 'online' event will follow) only the quick steps run, as a safety net in case
// that event never reaches this worker, e.g. when Chrome starts before the network is up.
// A lookup that produced no country, or only a country (every location service failed and the
// country came from Cloudflare), is retried on GEO_RETRY_INTERVAL_MS.
function geoIncomplete(info) {
  return !normalizeCountryCode(info?.countryCode) || (!info.city && (!info.isp || info.isp === 'N/A'));
}

function scheduleOfflineRetry(repeat = true) {
  if (offlineRetry.timer || (!repeat && offlineRetry.step >= OFFLINE_RETRY_MS.length)) return;
  const delay = OFFLINE_RETRY_MS[Math.min(offlineRetry.step++, OFFLINE_RETRY_MS.length - 1)];
  offlineRetry.timer = setTimeout(async () => {
    offlineRetry.timer = null;
    if (!(await autoChecksEnabled())) return;
    fetchAllBackgroundLocations(true).catch(() => {});
  }, delay);
}

async function autoChecksEnabled() {
  const { appSettings } = await chrome.storage.local.get('appSettings');
  return appSettings?.enableAutoRefresh !== false;
}

function resetOfflineRetry() {
  clearTimeout(offlineRetry.timer);
  offlineRetry.timer = null;
  offlineRetry.step = 0;
}

function resetErrGrace() {
  errFailureStartedAt = 0;
  errRetryStep = 0;
  clearTimeout(errRetryTimer);
  errRetryTimer = null;
}

function scheduleErrRetry(delay) {
  clearTimeout(errRetryTimer);
  errRetryTimer = setTimeout(async () => {
    errRetryTimer = null;
    if (!(await autoChecksEnabled())) return;
    fetchAllBackgroundLocations(true).catch(() => {});
  }, delay);
  if (typeof errRetryTimer === 'object' && typeof errRetryTimer?.unref === 'function') errRetryTimer.unref();
}

// Probe bookkeeping that only matters while the browser runs lives in session storage (memory),
// so frequent checks do not rewrite the disk; it falls back to local storage where unavailable.
const sessionStore = chrome.storage.session || chrome.storage.local;

// Same fields as routeState apart from the probe timestamp, to skip rewriting an unchanged state.
const sameRouteState = (a, b) => JSON.stringify({ ...(a || {}), lastPairAt: 0, pairSeen: null }) === JSON.stringify({ ...(b || {}), lastPairAt: 0, pairSeen: null });

async function fetchAllBackgroundLocations(forceRefresh = false, minimumIntervalMs = PROBE_INTERVAL_MS, isManual = false) {
  if (activeProbePromise) {
    if (!forceRefresh) return activeProbePromise;
    if (isManual) queuedForceIsManual = true;
    if (!queuedForceProbePromise) {
      const qGen = probeGeneration;
      queuedForceProbePromise = activeProbePromise.catch(() => {}).then(() => {
        if (qGen !== probeGeneration) return null;
        const manual = queuedForceIsManual;
        queuedForceProbePromise = null;
        queuedForceIsManual = false;
        return fetchAllBackgroundLocations(true, minimumIntervalMs, manual);
      });
    }
    return queuedForceProbePromise;
  }

  // A probe abandoned by the watchdog may still finish later; it must not overwrite newer state.
  const generation = ++probeGeneration;
  const current = () => generation === probeGeneration;
  const commit = async (values) => { if (current() && Object.keys(values).length) await chrome.storage.local.set(values); };
  const work = (async () => {
    {
      const stored = await chrome.storage.local.get([
        'latestV4Info',
        'latestV6Info',
        'isOffline',
        'probeError',
        'v4Unverified',
        'appSettings',
        'routeState',
        'routeDivergence',
        'pendingV6Notice',
        'lastKnownV6Ip'
      ]);
      const { lastProbeAt } = await sessionStore.get('lastProbeAt').catch(() => ({}));

      const cachedV4 = stored.latestV4Info || null;
      const cachedV6 = stored.latestV6Info || null;
      const result = (v4Info, v6Info, isOffline = false, probeError = false) => ({ v4Info, v6Info, isOffline, probeError });
      // Without any stored result there is nothing to fall back on, so the interval never applies.
      const hasPending = cachedV4?.pending === true || cachedV6?.pending === true;
      const hasResult = !!((cachedV4 && !cachedV4.pending) || (cachedV6 && !cachedV6.pending) || stored.isOffline || stored.probeError);
      // The slower interval does not apply after a failed or offline check (recovery shows at
      // once) or while a different route is shown: the server only sees its own route.
      const watchRoutes = !!stored.routeDivergence && stored.appSettings?.warnRouteDivergence === true;
      const fastPopupWatch = minimumIntervalMs < PROBE_INTERVAL_MS && (stored.isOffline || stored.probeError || watchRoutes);
      const interval = fastPopupWatch ? Math.min(minimumIntervalMs, POPUP_PROBE_INTERVAL_MS) : minimumIntervalMs;
      if (!forceRefresh && !hasPending && hasResult && Date.now() - (lastProbeAt || 0) < interval) {
        return result(cachedV4, cachedV6, stored.isOffline === true, stored.probeError === true);
      }

      if (current()) await sessionStore.set({ lastProbeAt: Date.now() }).catch(() => {});

      // The browser knows it has no network: show that at once, without requests that can only fail.
      // Mostly the 'online' event (or the alarm, if the worker slept) ends this state.
      if (!deviceOnline()) {
        resetErrGrace();
        await commit({ isOffline: true, probeError: false, lastCheckedAt: Date.now() });
        if (stored.appSettings?.enableAutoRefresh !== false && current()) scheduleOfflineRetry(false);
        await withTimeout(current() && updateToolbarDisplay(cachedV4, cachedV6, true, false).catch(() => {}), TOOLBAR_WAIT_MS, () => {});
        return result(cachedV4, cachedV6, true, false);
      }

      const [observation, fastV6] = await Promise.all([
        probePublicIPv4(isManual),
        getFastPublicIPv6()
      ]);
      if (!current()) return result(cachedV4, cachedV6, stored.isOffline === true, stored.probeError === true);
      const route = evaluateIPv4Route(observation, cachedV4, stored.routeState, stored.routeDivergence || null);
      const fastV4 = route.primary;
      const v4Held = route.held;

      if (!fastV4 && !fastV6 && (!v4Held || (!observation.edge && !observation.independent))) {
        // Every provider failed. If not even a plain request gets an answer, there is no working
        // connection, although the browser may still report one (virtual network adapters, Wi-Fi
        // without internet). Otherwise the providers are the problem ("ERR"). Either way nothing
        // was learned about the routes, so the route state is left as it was.
        const isOffline = !deviceOnline() || !(await internetReachable());
        const autoEnabled = stored.appSettings?.enableAutoRefresh !== false;
        if (isOffline) {
          resetErrGrace();
          await commit({ isOffline: true, probeError: false, lastCheckedAt: Date.now() });
          if (autoEnabled && current()) scheduleOfflineRetry();
          await withTimeout(current() && updateToolbarDisplay(cachedV4, cachedV6, true, false).catch(() => {}), TOOLBAR_WAIT_MS, () => {});
          return result(cachedV4, cachedV6, true, false);
        }

        resetOfflineRetry();
        if (stored.isOffline === true) {
          await chrome.storage.local.set({ isOffline: false, lastCheckedAt: Date.now() }).catch(() => {});
          if (current()) await updateToolbarDisplay(cachedV4, cachedV6, false, false).catch(() => {});
        }
        if (!errFailureStartedAt) {
          errFailureStartedAt = Date.now();
          errRetryStep = 0;
        }
        const failureDuration = Date.now() - errFailureStartedAt;
        if (!autoEnabled || isManual || failureDuration >= ERR_GRACE_MS) {
          await commit({ isOffline: false, probeError: true, lastCheckedAt: Date.now() });
          if (autoEnabled && current()) scheduleErrRetry(10_000);
          await withTimeout(current() && updateToolbarDisplay(cachedV4, cachedV6, false, true).catch(() => {}), TOOLBAR_WAIT_MS, () => {});
          return result(cachedV4, cachedV6, false, true);
        }

        const delay = errRetryStep < ERR_RETRY_DELAYS_MS.length
          ? ERR_RETRY_DELAYS_MS[errRetryStep++]
          : 8_000;
        if (current()) scheduleErrRetry(delay);
        return result(cachedV4, cachedV6, false, false);
      }
      resetOfflineRetry();
      resetErrGrace();

      const effectiveHeld = v4Held && !!cachedV4?.ip;
      const v4Changed = !!fastV4 && cachedV4?.ip !== fastV4.ip;
      const v6Changed = !!fastV6 && (!cachedV6?.ip || canonicalIPv6(cachedV6.ip) !== fastV6);
      const retainedV4 = effectiveHeld ? cachedV4 : null;
      const pendingV4 = fastV4
        ? (v4Changed ? { ...makePendingGeoInfo(fastV4.ip, fastV4.countryCode), vantage: fastV4.vantage } : cachedV4)
        : retainedV4;
      const pendingV6 = fastV6 ? (v6Changed ? makePendingGeoInfo(fastV6) : cachedV6) : null;
      const updateObj = { lastCheckedAt: Date.now() };
      if (stored.isOffline !== false) updateObj.isOffline = false;
      if (stored.probeError !== false) updateObj.probeError = false;
      if (stored.v4Unverified !== effectiveHeld) updateObj.v4Unverified = effectiveHeld;

      if (v4Changed || v6Changed) {
        // Shown at once ("Locating…"); the change alerts follow once the new location is known.
        await commit({ ...updateObj, latestV4Info: pendingV4, latestV6Info: pendingV6, routeState: route.state });
        await withTimeout(current() && updateToolbarDisplay(pendingV4, pendingV6, false).catch(() => {}), TOOLBAR_WAIT_MS, () => {});
      }

      // Geolocate alternate routes when first confirmed, and retry missing metadata on the same
      // schedule as the primary IP (a manual refresh retries a missing country after 30 s).
      const divergence = route.divergence;
      if (divergence && route.confirmed.length) divergence.notified = false;
      const altsNeedingGeo = divergence && stored.appSettings?.warnRouteDivergence === true ? divergence.alts.filter(alt => {
        const age = Date.now() - (alt.geoAt || 0);
        return !normalizeCountryCode(alt.geo?.countryCode) &&
          (age >= GEO_RETRY_INTERVAL_MS || (forceRefresh && age >= ALT_GEO_MANUAL_RETRY_MS));
      }) : [];
      // A refresh of an unchanged IP must not replace a complete location with a failed lookup.
      const keepComplete = (cached, info) => cached && !cached.pending && !geoIncomplete(cached) && geoIncomplete(info)
        ? { ...cached, updatedAt: Date.now() } : info;
      const geoV4 = (async () => {
          if (!fastV4) {
            // A held IP may still be an unfinished placeholder from an interrupted probe.
            if (!retainedV4?.pending) return retainedV4;
            const info = await getGeoLocation(retainedV4.ip, retainedV4.countryCode);
            return { ...info, vantage: retainedV4.vantage };
          }
          const age = Date.now() - (cachedV4?.updatedAt || 0);
          const needsEnrichment = v4Changed || !cachedV4?.updatedAt || cachedV4.pending === true ||
            (geoIncomplete(cachedV4) && (age >= GEO_RETRY_INTERVAL_MS || isManual)) ||
            (forceRefresh && age >= MANUAL_GEO_REFRESH_MS);
          // The memory cache serves a new or unfinished IP; retries and manual refreshes ask again.
          const useCache = v4Changed || cachedV4?.pending === true;
          let info = needsEnrichment ? await getGeoLocation(fastV4.ip, fastV4.countryCode, useCache) : cachedV4;
          if (needsEnrichment && !v4Changed) info = keepComplete(cachedV4, info);
          return info && info.vantage !== fastV4.vantage ? { ...info, vantage: fastV4.vantage } : info;
        })();
      const geoV6 = (async () => {
          if (!fastV6) return null;
          const age = Date.now() - (cachedV6?.updatedAt || 0);
          const needsEnrichment = v6Changed || !cachedV6?.updatedAt || cachedV6.pending === true ||
            (geoIncomplete(cachedV6) && (age >= GEO_RETRY_INTERVAL_MS || isManual)) ||
            (forceRefresh && age >= MANUAL_GEO_REFRESH_MS);
          if (!needsEnrichment) return cachedV6;
          const info = await getGeoLocation(fastV6, '', v6Changed || cachedV6?.pending === true);
          return v6Changed ? info : keepComplete(cachedV6, info);
        })();
      const geoAlts = Promise.all(altsNeedingGeo.map(alt => getGeoLocation(alt.ip).catch(() => null)));

      // Change alerts carry the new country when geolocation answers within NOTIFY_GEO_WAIT_MS;
      // a slow lookup must not delay the alert itself.
      const [alertV4, alertV6] = await Promise.all([
        withTimeout(geoV4, NOTIFY_GEO_WAIT_MS, () => pendingV4),
        withTimeout(geoV6, NOTIFY_GEO_WAIT_MS, () => pendingV6)
      ]);
      let v6Notice = null;
      if (current()) {
        // IPv6: compared with the last address seen, even if IPv6 was briefly absent in between.
        const v6From = cachedV6?.ip ? canonicalIPv6(cachedV6.ip) : (stored.lastKnownV6Ip ? canonicalIPv6(stored.lastKnownV6Ip) : null);
        v6Notice = v6Changed && v6From && v6From !== fastV6
          ? { from: stored.pendingV6Notice?.from || v6From, to: fastV6 }
          : (stored.pendingV6Notice || null);
        if (v6Notice) {
          const superseded = !!fastV6 && alertV6?.ip !== v6Notice.to;
          if (v6Notice.from === v6Notice.to || superseded || stored.appSettings?.notifyIPv6 === false) {
            v6Notice = null;
            if (stored.pendingV6Notice) await commit({ pendingV6Notice: null });
          } else if (fastV6 && alertV6?.ip === v6Notice.to) {
            const delivered = await sendIPChangeNotification('IPv6', v6Notice.from, alertV6);
            v6Notice = delivered ? null : v6Notice;
            await commit({ pendingV6Notice: v6Notice });
          }
        }
        // announcedIp advances only after delivery, so a throttled alert is retried.
        if (route.notify && await sendIPChangeNotification('IPv4', route.notify.from, alertV4)) {
          route.state.announcedIp = route.notify.to;
        }
      }
      const [finalV4, finalV6, altGeos] = await Promise.all([geoV4, geoV6, geoAlts]);

      altsNeedingGeo.forEach((alt, i) => {
        const geo = altGeos[i];
        alt.geoAt = Date.now();
        if (geo && (normalizeCountryCode(geo.countryCode) || geo.isp !== 'N/A')) {
          alt.geo = { country: geo.country, countryCode: geo.countryCode, city: geo.city, isp: geo.isp, asn: geo.asn };
        }
      });
      // Retried on later checks until delivered, like the IP change alerts.
      if (divergence && !divergence.notified && current() && await sendRouteDivergenceNotification(divergence, finalV4)) {
        divergence.notified = true;
      }
      if (!sameRouteState(route.state, stored.routeState) || v4Changed || v6Changed) updateObj.routeState = route.state;
      if (JSON.stringify(divergence || null) !== JSON.stringify(stored.routeDivergence || null)) updateObj.routeDivergence = divergence;
      if (finalV6?.ip && finalV6.ip !== stored.lastKnownV6Ip) updateObj.lastKnownV6Ip = finalV6.ip;
      // The announced address's country, once known: the "from" of the next country-change alert.
      if (current()) {
        const v4Code = normalizeCountryCode(finalV4?.countryCode);
        if (v4Code && finalV4.ip === route.state.announcedIp) await rememberAnnouncedCountry('IPv4', v4Code);
        const v6Code = normalizeCountryCode(finalV6?.countryCode);
        if (v6Code && !v6Notice) await rememberAnnouncedCountry('IPv6', v6Code);
      }

      if (JSON.stringify(cachedV4) !== JSON.stringify(finalV4)) updateObj.latestV4Info = finalV4;
      if (JSON.stringify(cachedV6) !== JSON.stringify(finalV6)) updateObj.latestV6Info = finalV6;
      await commit(updateObj);
      await withTimeout(current() && updateToolbarDisplay(finalV4, finalV6, false).catch(() => {}), TOOLBAR_WAIT_MS, () => {});

      return result(finalV4, finalV6);
    }
  })();
  // Watchdog: a probe that hangs anywhere must not block every later check.
  const probe = withTimeout(work, PROBE_WATCHDOG_MS, async () => {
    const saved = await chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline', 'probeError']);
    return { v4Info: saved.latestV4Info || null, v6Info: saved.latestV6Info || null, isOffline: saved.isOffline === true, probeError: saved.probeError === true };
  }).finally(() => {
    if (activeProbePromise === probe) activeProbePromise = null;
  });
  activeProbePromise = probe;
  return probe;
}

// Serialized: an older application finishing late must not overwrite a newer result.
let privacyChain = Promise.resolve();
function applyPrivacyShield() {
  const run = privacyChain.catch(() => false).then(() => applyPrivacyShieldNow());
  privacyChain = run;
  return run;
}

const WEBRTC_POLICIES = ['disable_non_proxied_udp', 'default_public_interface_only'];
const requestedWebRtcPolicy = (settings) => WEBRTC_POLICIES.includes(settings?.antiLeakPolicy) ? settings.antiLeakPolicy : WEBRTC_POLICIES[0];

// The two browser settings are applied independently: a failure of one never skips the other.
async function applyPrivacyShieldNow() {
  let effective = false;
  const settings = (await chrome.storage.local.get('appSettings').catch(() => ({}))).appSettings || {};
  const network = chrome.privacy?.network;
  try {
    if (network?.webRTCIPHandlingPolicy) {
      if (settings.enableAntiLeakShield !== false) {
        const policyMode = requestedWebRtcPolicy(settings);
        await network.webRTCIPHandlingPolicy.set({ value: policyMode });
        const current = await network.webRTCIPHandlingPolicy.get({});
        effective = current.value === policyMode && current.levelOfControl === 'controlled_by_this_extension';
      } else {
        await network.webRTCIPHandlingPolicy.clear({});
      }
    }
  } catch (err) {}
  try {
    if (network?.networkPredictionEnabled) {
      if (settings.enableDnsPrefetchBlock !== false) await network.networkPredictionEnabled.set({ value: false });
      else await network.networkPredictionEnabled.clear({});
    }
  } catch (err) {}
  await chrome.storage.local.set({ shieldEffective: effective });
  return effective;
}

/* ---------- Fast change detection (Serverless Watcher) ----------
 * Periodically queries Cloudflare's trace endpoint every WATCH_INTERVAL_MS (3 s) while the user
 * is actively using the computer, without keeping an open socket or contacting any developer-operated
 * server. Calling an extension API (chrome.idle.queryState) each tick keeps the background service
 * worker alive in Chrome MV3 without needing a persistent socket. When idle or locked, the loop pauses
 * so the worker can sleep; the 30-second alarm continues. When the user becomes active again, the
 * watcher resumes.
 */
const WATCHER_TRACE_URLS = [
  'https://cloudflare.com/cdn-cgi/trace',
  'https://v4.ident.me',
  'https://api.seeip.org'
];

async function queryIdleState(seconds) {
  if (!chrome.idle?.queryState) return 'active';
  try {
    const res = chrome.idle.queryState(seconds);
    if (res && typeof res.then === 'function') return await res;
    return await new Promise(resolve => chrome.idle.queryState(seconds, resolve));
  } catch (e) {
    return 'active';
  }
}

async function runWatcherTick() {
  const cGen = clearGeneration;
  // While active, queries idle state to detect whether the user is active or away. In modern
  // Chromium (120+), the service worker is governed by Chrome's lifecycle and alarms ensure
  // ongoing 30s checks even after the worker sleeps; the 3s watcher loop runs while the worker is active.
  const idleState = await queryIdleState(IDLE_SECONDS);
  if (idleState === 'idle' || idleState === 'locked') {
    stopWatcher();
    return;
  }

  // Offline: no request. The 'offline' event normally records it; if that event never reached
  // this worker, the check (which makes no requests while offline) records it now.
  if (!deviceOnline()) {
    const { isOffline } = await chrome.storage.local.get('isOffline');
    if (isOffline !== true && !activeProbePromise) fetchAllBackgroundLocations(true).catch(() => {});
    return;
  }

  await providerCooldownReady;
  const now = Date.now();
  const candidates = [];
  for (let i = 0; i < WATCHER_TRACE_URLS.length; i++) {
    const index = (watcherTraceIndex + i) % WATCHER_TRACE_URLS.length;
    const candidate = WATCHER_TRACE_URLS[index];
    const origin = new URL(candidate).origin;
    if (!isOriginCoolingDown(origin)) candidates.push({ url: candidate, index });
  }
  if (!candidates.length) return;

  let traceText = null;
  const failedOrigins = [];
  let successfulIndex = -1;

  for (const item of candidates) {
    const origin = new URL(item.url).origin;
    try {
      const res = await fetchWithTimeout(item.url, {}, 2000);
      if (cGen !== clearGeneration) return;
      if (res?.ok) {
        traceText = await res.text();
        successfulIndex = item.index;
        break;
      }
      failedOrigins.push(origin);
    } catch (e) {
      failedOrigins.push(origin);
    }
  }

  if (successfulIndex >= 0) {
    watcherTraceIndex = successfulIndex;
    for (const origin of failedOrigins) {
      markNetworkCooldown(origin, 10 * 60_000);
    }
  } else {
    traceText = null;
  }

  let traceIp = null;
  let traceLoc = '';
  if (traceText) {
    const ipMatch = traceText.match(/^ip=([^\r\n]+)/m);
    const locMatch = traceText.match(/^loc=([^\r\n]+)/m);
    let ip = ipMatch ? ipMatch[1].trim() : traceText.trim();
    if (!isValidIPv4(ip) && !isValidIPv6(ip)) {
      try {
        const parsed = JSON.parse(traceText);
        if (parsed && typeof parsed.ip === 'string') ip = parsed.ip.trim();
      } catch (e) {}
    }
    if (isValidIPv4(ip) || isValidIPv6(ip)) {
      traceIp = ip;
      traceLoc = locMatch && locMatch[1] ? normalizeCountryCode(locMatch[1].trim()) : '';
    }
  }

  const stored = await chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline', 'probeError', 'v4Unverified']);
  if (cGen !== clearGeneration) return;
  if (stored.v4Unverified !== true) lastUnverifiedWatcherAt = 0;

  // A probe is started only when the trace answer itself changes (or after a failed check): the
  // shown IP can legitimately differ from the trace (Cloudflare's country database, an IPv6 the
  // main check cannot confirm, a fallback IP), and that must not cause a probe every tick.
  let shouldTrigger = false;
  let key = lastTraceKey;
  if (traceIp) {
    traceSucceededOnce = true;
    traceFailureTriggered = false;
    const isV6 = traceIp.includes(':');
    if (!isV6) cfTraceV6Until = 0;
    const ip = isV6 ? canonicalIPv6(traceIp) : traceIp;
    const shown = isV6 ? stored.latestV6Info : stored.latestV4Info;
    const shownIp = shown?.ip ? (isV6 ? canonicalIPv6(shown.ip) : shown.ip) : null;
    const shownCountry = normalizeCountryCode(shown?.countryCode);
    const effectiveLoc = traceLoc || (shownIp === ip ? shownCountry : '');
    key = `${ip}|${effectiveLoc}`;
    const differs = !shownIp || ip !== shownIp || (!!shownCountry && !!traceLoc && shownCountry !== traceLoc);
    const retryUnverified = !isV6 && stored.v4Unverified === true && (now - lastUnverifiedWatcherAt >= 15_000);
    shouldTrigger = stored.isOffline === true || stored.probeError === true || retryUnverified || (differs && key !== lastTraceKey);
  } else {
    // A connection lost or changing: one probe for the whole failure streak (it decides between
    // offline and ERR, with its own grace period).
    shouldTrigger = traceSucceededOnce && !traceFailureTriggered;
  }

  // While a probe runs, the trigger is kept for the next tick instead of being dropped.
  if (!watcherRunning) return;
  if (shouldTrigger && activeProbePromise) return;
  lastTraceKey = key;
  if (shouldTrigger) {
    if (!traceIp) traceFailureTriggered = true;
    else if (stored.v4Unverified === true && !traceIp.includes(':')) lastUnverifiedWatcherAt = now;
    const expectedIp = traceIp ? (traceIp.includes(':') ? canonicalIPv6(traceIp) : traceIp) : '';
    const isV6Trace = !!traceIp && traceIp.includes(':');
    fetchAllBackgroundLocations(true).then((res) => {
      if (!expectedIp || isV6Trace) return;
      if (res?.v4Info?.vantage !== 'edge' && lastTraceKey === key && res?.v4Info?.ip !== expectedIp) {
        lastTraceKey = '';
      }
    }).catch(() => {});
  }
}

async function watcherLoop(generation = watcherGeneration) {
  if (!watcherRunning || generation !== watcherGeneration) return;
  try {
    await runWatcherTick();
  } catch (e) {}
  if (watcherRunning && generation === watcherGeneration) {
    clearTimeout(watcherTimer);
    watcherTimer = setTimeout(() => watcherLoop(generation), WATCH_INTERVAL_MS);
    if (typeof watcherTimer === 'object' && typeof watcherTimer?.unref === 'function') watcherTimer.unref();
  }
}

function startWatcher(delayMs = 0) {
  if (watcherRunning) return;
  watcherRunning = true;
  const generation = ++watcherGeneration;
  try { chrome.idle?.setDetectionInterval?.(IDLE_SECONDS); } catch (e) {}
  clearTimeout(watcherTimer);
  watcherTimer = setTimeout(() => watcherLoop(generation), delayMs);
  if (typeof watcherTimer === 'object' && typeof watcherTimer?.unref === 'function') watcherTimer.unref();
}

function stopWatcher() {
  watcherRunning = false;
  clearTimeout(watcherTimer);
  watcherTimer = null;
}

function fastDetectionEnabled(settings) {
  return settings?.enableFastDetection !== false && settings?.enableAutoRefresh !== false;
}

async function syncWatcher() {
  const { appSettings } = await chrome.storage.local.get('appSettings');
  if (fastDetectionEnabled(appSettings)) {
    startWatcher();
  } else {
    stopWatcher();
  }
}

if (chrome.idle?.onStateChanged) {
  try { chrome.idle.setDetectionInterval(IDLE_SECONDS); } catch (e) {}
  chrome.idle.onStateChanged.addListener(async (state) => {
    if (state === 'active') {
      const { appSettings } = await chrome.storage.local.get('appSettings');
      if (appSettings?.enableAutoRefresh !== false) {
        if (fastDetectionEnabled(appSettings)) startWatcher(WATCH_INTERVAL_MS);
        fetchAllBackgroundLocations(true).finally(() => syncWatcher().catch(() => {}));
      }
    } else if (state === 'idle' || state === 'locked') {
      stopWatcher();
    }
  });
}

// The 30-second alarm exists only while automatic checks are on, so with them off the worker is
// not woken twice a minute for nothing.
const PROBE_ALARM = 'fetchLocationsAlarm';
let alarmCheck = null;
function ensureAlarm() {
  alarmCheck = alarmCheck || (async () => {
    try {
      if (!(await autoChecksEnabled())) {
        await chrome.alarms.clear(PROBE_ALARM);
        return;
      }
      const alarm = await chrome.alarms.get(PROBE_ALARM);
      if (alarm?.periodInMinutes !== 0.5) await chrome.alarms.create(PROBE_ALARM, { periodInMinutes: 0.5 });
    } catch (e) {} finally {
      alarmCheck = null;
    }
  })();
  return alarmCheck;
}
ensureAlarm();

async function autoRefresh() {
  // Revive the watcher if the worker was restarted; the worker stays busy until both finish.
  const { appSettings } = await chrome.storage.local.get('appSettings');
  // Slightly below the alarm period, so a probe that ran just before does not skip a whole tick.
  await Promise.all([
    syncWatcher().catch(() => {}),
    appSettings?.enableAutoRefresh !== false ? fetchAllBackgroundLocations(false, PROBE_INTERVAL_MS - 5_000).catch(() => {}) : null
  ]);
}

function parseMajorMinor(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/);
  return m ? `${Number(m[1])}.${Number(m[2])}` : '0.0';
}

async function syncReviewPromptState() {
  try {
    const currentMinor = parseMajorMinor(chrome.runtime.getManifest?.()?.version);
    const { reviewPrompt } = await chrome.storage.local.get('reviewPrompt');
    const now = Date.now();
    if (!reviewPrompt || typeof reviewPrompt !== 'object') {
      await chrome.storage.local.set({
        reviewPrompt: {
          installedAt: now,
          trackedMinor: currentMinor,
          opensInMinor: 0,
          dismissCount: 0,
          dismissedAt: 0,
          dismissedMinor: '',
          completed: false
        }
      });
      return;
    }
    if (reviewPrompt.trackedMinor !== currentMinor) {
      await chrome.storage.local.set({
        reviewPrompt: {
          ...reviewPrompt,
          trackedMinor: currentMinor,
          opensInMinor: 0
        }
      });
    }
  } catch (e) {}
}

// Every worker start already runs the setup at the bottom of this file (alarm, policies, toolbar,
// watcher); these events add only what is specific to them.
chrome.runtime.onInstalled.addListener((details) => {
  syncReviewPromptState().catch(() => {});
  syncWatcher().catch(() => {});
  if (details?.reason === 'install') {
    fetchAllBackgroundLocations(true).catch(() => {});
  } else {
    autoChecksEnabled().then(on => {
      if (on) fetchAllBackgroundLocations(true).catch(() => {});
    }).catch(() => {});
  }
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  syncWatcher().catch(() => {});
  autoChecksEnabled().then(on => {
    if (on) return fetchAllBackgroundLocations(true);
    if (deviceOnline()) {
      chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline'], (res) => {
        if (res.isOffline === true) {
          chrome.storage.local.set({ isOffline: false });
          updateToolbarDisplay(res.latestV4Info || null, res.latestV6Info || null, false, false);
        }
      });
    }
  }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PROBE_ALARM) autoRefresh().catch(() => {});
});

// Everything LeakHalo has stored about your addresses and routes, without your settings. A fresh
// check follows (when automatic checks are on), so the popup and toolbar fill again.
const IP_DATA_KEYS = ['latestV4Info', 'latestV6Info', 'routeState', 'routeDivergence', 'pendingV6Notice', 'lastKnownV6Ip',
  'fastChannelIp', 'announcedCountries', 'lastNotifTimeIPv4', 'lastNotifTimeIPv6', 'lastRouteNotifTime', 'providerCooldowns',
  'isOffline', 'probeError', 'v4Unverified', 'lastCheckedAt', 'lastProbeAt'];
async function clearStoredIpData() {
  clearGeneration++;
  probeGeneration++; // a check still running must not write its result back
  await providerCooldownReady;
  resetErrGrace();
  resetOfflineRetry();
  cfTraceV6Until = 0;
  lastTraceKey = '';
  lastUnverifiedWatcherAt = 0;
  traceSucceededOnce = false;
  traceFailureTriggered = false;
  await chrome.storage.local.remove(IP_DATA_KEYS);
  await chrome.storage.session?.clear().catch(() => {});
  geoMemoryCache.clear();
  for (const key of Object.keys(providerCooldowns)) delete providerCooldowns[key];
  clearNetworkCooldowns();
  appliedToolbarKey = '';
  activeProbePromise = null;
  queuedForceProbePromise = null;
  queuedForceIsManual = false;
  await updateToolbarDisplay(null, null, false, false);
  if (await autoChecksEnabled()) fetchAllBackgroundLocations(true).catch(() => {});
}

// The settings pages may change, with their allowed values. Anything else in a patch is ignored.
const BOOLEAN_SETTINGS = ['enableNotifications', 'notifyIPv6', 'enableAutoRefresh', 'enableFastDetection', 'warnRouteDivergence',
  'showMap', 'enableAntiLeakShield', 'enableDnsPrefetchBlock', 'enableWebRtcScan', 'showTimeZone', 'maskIp'];
const CHOICE_SETTINGS = { antiLeakPolicy: WEBRTC_POLICIES, badgeMode: ['flag', 'text', 'off'], optionsTheme: ['light', 'dark', 'system'] };
function validSettingsPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clean;
  for (const [key, value] of Object.entries(patch)) {
    if (BOOLEAN_SETTINGS.includes(key) ? typeof value === 'boolean' : CHOICE_SETTINGS[key]?.includes(value)) clean[key] = value;
  }
  return clean;
}
const PRIVACY_KEYS = ['enableAntiLeakShield', 'antiLeakPolicy', 'enableDnsPrefetchBlock'];
const TOOLBAR_KEYS = ['badgeMode', 'warnRouteDivergence'];

// Every page changes settings through this queue, field by field, so two pages saving at the same
// time can never overwrite each other's choice with a stale copy.
let settingsChain = Promise.resolve();
// patch: fields to set, or a function of the current settings returning those fields. Only the
// effects of fields that actually changed run (browser policies, toolbar, checks).
function updateSettings(patch) {
  const run = settingsChain.catch(() => {}).then(async () => {
    const { appSettings, shieldEffective: storedEffective } = await chrome.storage.local.get(['appSettings', 'shieldEffective']);
    const previous = appSettings || {};
    const fields = validSettingsPatch(typeof patch === 'function' ? patch(previous) : patch);
    const next = { ...previous, ...fields };
    const changed = (key) => key in fields && fields[key] !== previous[key];
    if (Object.keys(fields).some(changed)) await chrome.storage.local.set({ appSettings: next });
    // Re-applied when a privacy field changed, and as a retry while the policy is not confirmed.
    const privacyChanged = PRIVACY_KEYS.some(changed);
    const retryNeeded = next.enableAntiLeakShield !== false && storedEffective !== true;
    const shieldEffective = privacyChanged || retryNeeded
      ? await applyPrivacyShield() : (next.enableAntiLeakShield === false ? false : true);
    const autoWasOff = previous.enableAutoRefresh === false;
    if (next.enableAutoRefresh === false) {
      resetOfflineRetry();
      resetErrGrace();
      await chrome.alarms.clear(PROBE_ALARM).catch(() => {});
    } else if (autoWasOff) {
      ensureAlarm();
    }
    if (changed('enableFastDetection') || changed('enableAutoRefresh')) {
      syncWatcher().catch(() => {});
    }
    if (TOOLBAR_KEYS.some(changed)) {
      const res = await chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline', 'probeError']);
      await updateToolbarDisplay(res.latestV4Info || null, res.latestV6Info || null, res.isOffline || false, res.probeError === true);
    }
    // Checks switched back on, or the route warning turned on (its other routes still need a
    // location): check now instead of waiting for the next alarm.
    if ((autoWasOff && next.enableAutoRefresh !== false) || (changed('warnRouteDivergence') && next.warnRouteDivergence === true)) {
      fetchAllBackgroundLocations(true).catch(() => {});
    }
    return { settings: next, shieldEffective };
  });
  settingsChain = run;
  return run;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only this extension's own pages talk to the worker.
  if (!request || typeof request !== 'object' || sender?.id !== chrome.runtime.id) return false;
  if (request.type === 'UPDATE_SETTINGS' && request.patch && typeof request.patch === 'object' && !Array.isArray(request.patch)) {
    updateSettings(request.patch)
      .then(({ settings, shieldEffective }) => sendResponse({ status: 'ok', settings, shieldEffective }))
      .catch(() => sendResponse({ status: 'error' }));
    return true;
  }
  if (request.type === 'CLEAR_IP_DATA') {
    clearStoredIpData().then(() => sendResponse({ status: 'ok' })).catch(() => sendResponse({ status: 'error' }));
    return true;
  }
  if (request.type === 'REFRESH_NOW') {
    fetchAllBackgroundLocations(true, PROBE_INTERVAL_MS, true).then((data) => sendResponse({ status: 'ok', data })).catch(() => sendResponse({ status: 'error' }));
    return true;
  }
  if (request.type === 'CHECK_NETWORK') {
    // While the watcher is running it reports a changed IP within seconds, so the open popup asks
    // the providers less often.
    const interval = watcherRunning ? POPUP_PROBE_WITH_WATCHER_MS : POPUP_PROBE_INTERVAL_MS;
    fetchAllBackgroundLocations(request.force === true, interval).then((data) => sendResponse({ status: 'ok', data })).catch(() => sendResponse({ status: 'error' }));
    return true;
  }
  if (request.type === 'TOGGLE_SHIELD') {
    (async () => {
      const explicit = typeof request.explicitState === 'boolean' ? request.explicitState : null;
      const { settings, shieldEffective } = await updateSettings(current =>
        ({ enableAntiLeakShield: explicit ?? current.enableAntiLeakShield === false }));
      sendResponse({ status: 'ok', shieldActive: settings.enableAntiLeakShield, shieldEffective });
    })().catch(() => sendResponse({ status: 'error' }));
    return true;
  }
});

chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline', 'probeError'], (res) => {
  updateToolbarDisplay(res.latestV4Info || null, res.latestV6Info || null, res.isOffline || false, res.probeError === true);
});
applyPrivacyShield();
chrome.storage.local.remove?.('fastChannelIp');
// Removing the extension opens a one-tap "why?" page; it receives only the version and UI language.
try {
  const lang = chrome.i18n?.getUILanguage?.() || '';
  chrome.runtime.setUninstallURL?.(`https://slmn-labs.github.io/leakhalo/bye.html?v=${encodeURIComponent(chrome.runtime.getManifest().version)}&l=${encodeURIComponent(lang)}`)?.catch?.(() => {});
} catch (e) {}
syncWatcher().catch(() => {});
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.appSettings) syncWatcher().catch(() => {});
});
// Network events: back online, reconnect and check right away; offline, show it right away.
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('online', () => {
    cfTraceV6Until = 0;
    clearNetworkCooldowns();
    syncWatcher().catch(() => {});
    resetOfflineRetry();
    resetErrGrace();
    autoChecksEnabled().then(async (on) => {
      if (on) return fetchAllBackgroundLocations(true);
      const res = await chrome.storage.local.get(['latestV4Info', 'latestV6Info', 'isOffline']);
      if (res.isOffline !== true) return;
      await chrome.storage.local.set({ isOffline: false });
      await updateToolbarDisplay(res.latestV4Info || null, res.latestV6Info || null, false, false);
    }).catch(() => {});
  });
  // Lost the network: show it in the toolbar at once (the check makes no requests while offline).
  // With automatic checks off, the lost connection is still shown (a local fact, no requests) and
  // cleared again when it returns, so the grey icon never outlives the outage.
  self.addEventListener('offline', () => {
    autoChecksEnabled().then(async (on) => {
      if (on) return fetchAllBackgroundLocations(true);
      const res = await chrome.storage.local.get(['latestV4Info', 'latestV6Info']);
      await chrome.storage.local.set({ isOffline: true, probeError: false });
      await updateToolbarDisplay(res.latestV4Info || null, res.latestV6Info || null, true, false);
    }).catch(() => {});
  });
}

const webRtcPolicy = chrome.privacy?.network?.webRTCIPHandlingPolicy;
if (webRtcPolicy?.onChange) {
  // Queued behind any policy change in progress, so a late event cannot overwrite a newer result.
  webRtcPolicy.onChange.addListener((details) => {
    if (details.incognitoSpecific) return;
    privacyChain = privacyChain.catch(() => false).then(async () => {
      const { appSettings } = await chrome.storage.local.get('appSettings');
      const shieldEffective = appSettings?.enableAntiLeakShield !== false &&
        details.value === requestedWebRtcPolicy(appSettings) && details.levelOfControl === 'controlled_by_this_extension';
      await chrome.storage.local.set({ shieldEffective });
      return shieldEffective;
    });
    return privacyChain;
  });
}
