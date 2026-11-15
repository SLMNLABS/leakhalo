const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function createEventTarget() {
  const listeners = new Set();
  return {
    addListener(fn) { if (typeof fn === 'function') listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    hasListener(fn) { return listeners.has(fn); },
    get listeners() { return Array.from(listeners); },
    emit(...args) {
      return Array.from(listeners).map(fn => fn(...args));
    }
  };
}

function createChromeMock(options = {}) {
  const manifest = options.manifest || readJson('manifest.json');
  const enLocale = options.enLocale || readJson('_locales/en/messages.json');

  const localData = { ...(options.initialLocal || {}) };
  const sessionData = { ...(options.initialSession || {}) };

  const onInstalled = createEventTarget();
  const onStartup = createEventTarget();
  const onMessage = createEventTarget();
  const onStorageChanged = createEventTarget();
  const onAlarm = createEventTarget();
  const onNotifClicked = createEventTarget();
  const onIdleStateChanged = createEventTarget();
  const onPolicyChanged = createEventTarget();
  const onUserSettingsChanged = createEventTarget();

  let policyValue = options.initialPolicy || 'default';
  let policyLevel = options.initialLevelOfControl || 'controlled_by_this_extension';
  let networkPrediction = options.initialPrediction ?? true;
  let isOnToolbar = options.isOnToolbar ?? false;
  let idleState = options.idleState || 'active';
  let lastErrorValue = null;

  const state = {
    localData,
    sessionData,
    alarms: new Map(),
    notifications: [],
    clearedNotifications: [],
    createdTabs: [],
    openedOptionsCount: 0,
    openedPopupCount: 0,
    uninstallUrl: null,
    toolbar: {
      icon: null,
      badgeText: '',
      badgeColor: null,
      badgeTextColor: null,
      title: ''
    },
    idleInterval: 120,
    get policyValue() { return policyValue; },
    set policyValue(v) { policyValue = v; },
    get policyLevel() { return policyLevel; },
    set policyLevel(v) { policyLevel = v; },
    get networkPrediction() { return networkPrediction; },
    set networkPrediction(v) { networkPrediction = v; },
    get isOnToolbar() { return isOnToolbar; },
    set isOnToolbar(v) {
      isOnToolbar = !!v;
      onUserSettingsChanged.emit({ isOnToolbar });
    },
    get idleState() { return idleState; },
    set idleState(v) { idleState = v; },
    fireIdleState(newState) {
      idleState = newState;
      return Promise.all(onIdleStateChanged.emit(newState));
    },
    fireAlarm(name) {
      return Promise.all(onAlarm.emit({ name }));
    },
    firePolicyChange(details) {
      if (!details.incognitoSpecific) {
        if ('value' in details) policyValue = details.value;
        if ('levelOfControl' in details) policyLevel = details.levelOfControl;
      }
      return Promise.all(onPolicyChanged.emit(details));
    },
    clickNotification(id) {
      return onNotifClicked.emit(id);
    }
  };

  const hooks = {
    storageLocalGetLastError: null,
    storageLocalGetReject: null,
    storageLocalSetReject: null,
    storageSessionGetReject: null,
    storageSessionSetReject: null,
    storageSessionClearReject: null,
    setIconError: null,
    setIconDefaultError: null,
    alarmsGetReject: null,
    alarmsCreateReject: null,
    alarmsClearReject: null,
    notifCreateLastError: null,
    notifCreateThrow: false,
    webRtcSetReject: null,
    webRtcGetReject: null,
    webRtcClearReject: null,
    predictionSetReject: null,
    predictionClearReject: null,
    idleQueryThrow: false,
    idleQueryCallbackMode: false,
    idleSetIntervalThrow: false,
    openOptionsReject: null,
    openPopupReject: null,
    getUserSettingsReject: null,
    setUninstallUrlThrow: false,
    sendMessageLastError: null,
    sendMessageHandler: null
  };

  function pickKeys(store, keys) {
    if (keys === null || keys === undefined) return { ...store };
    const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
    const out = {};
    for (const k of list) {
      if (k in store) out[k] = store[k];
      else if (keys && !Array.isArray(keys) && typeof keys === 'object' && k in keys) out[k] = keys[k];
    }
    return out;
  }

  function cloneVal(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  const chrome = {
    runtime: {
      id: options.extensionId || 'leakhalo-test-ext-id',
      get lastError() { return lastErrorValue; },
      set lastError(v) { lastErrorValue = v; },
      getManifest: () => cloneVal(manifest),
      getURL: (p) => `chrome-extension://${chrome.runtime.id}/${String(p).replace(/^\/+/, '')}`,
      onInstalled,
      onStartup,
      onMessage,
      sendMessage(message, callback) {
        const respondWithPromise = () => new Promise((resolve, reject) => {
          if (hooks.sendMessageLastError) {
            lastErrorValue = { message: hooks.sendMessageLastError };
            if (callback) {
              try { callback(undefined); } finally { lastErrorValue = null; }
              return resolve(undefined);
            }
            lastErrorValue = null;
            return reject(new Error(hooks.sendMessageLastError));
          }
          if (typeof hooks.sendMessageHandler === 'function') {
            Promise.resolve(hooks.sendMessageHandler(message)).then((res) => {
              if (callback) callback(res);
              resolve(res);
            }, (err) => {
              if (callback) {
                lastErrorValue = { message: err.message };
                try { callback(undefined); } finally { lastErrorValue = null; }
                resolve(undefined);
              } else {
                reject(err);
              }
            });
            return;
          }
          let handledAsync = false;
          let settled = false;
          const sender = { id: options.senderId ?? chrome.runtime.id };
          const sendResponse = (resp) => {
            if (settled) return;
            settled = true;
            if (callback) callback(resp);
            resolve(resp);
          };
          for (const listener of onMessage.listeners) {
            const ret = listener(message, sender, sendResponse);
            if (ret === true) handledAsync = true;
          }
          if (!handledAsync && !settled) {
            settled = true;
            if (callback) callback(undefined);
            resolve(undefined);
          }
        });
        const p = respondWithPromise();
        if (typeof callback === 'function') return undefined;
        return p;
      },
      openOptionsPage: options.omitOpenOptionsPage ? undefined : async () => {
        if (hooks.openOptionsReject) throw hooks.openOptionsReject;
        state.openedOptionsCount++;
      },
      setUninstallURL(url) {
        if (hooks.setUninstallUrlThrow) throw new Error('setUninstallURL failed');
        state.uninstallUrl = url;
        return Promise.resolve();
      }
    },
    storage: {
      local: {
        get(keys, callback) {
          if (hooks.storageLocalGetReject) {
            if (callback) {
              lastErrorValue = { message: hooks.storageLocalGetReject.message };
              try { callback(undefined); } finally { lastErrorValue = null; }
              return;
            }
            return Promise.reject(hooks.storageLocalGetReject);
          }
          if (hooks.storageLocalGetLastError && callback) {
            lastErrorValue = { message: hooks.storageLocalGetLastError };
            try { callback(undefined); } finally { lastErrorValue = null; }
            return;
          }
          const found = cloneVal(pickKeys(localData, keys));
          if (typeof callback === 'function') {
            callback(found);
            return undefined;
          }
          return Promise.resolve(found);
        },
        set(values, callback) {
          if (hooks.storageLocalSetReject) return Promise.reject(hooks.storageLocalSetReject);
          const changes = {};
          for (const [k, v] of Object.entries(values || {})) {
            const oldValue = cloneVal(localData[k]);
            if (v === undefined) delete localData[k];
            else localData[k] = cloneVal(v);
            const newValue = cloneVal(localData[k]);
            if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
              changes[k] = { oldValue, newValue };
            }
          }
          if (Object.keys(changes).length) {
            queueMicrotask(() => onStorageChanged.emit(changes, 'local'));
          }
          if (typeof callback === 'function') {
            callback();
            return undefined;
          }
          return Promise.resolve();
        },
        remove(keys, callback) {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const k of list) {
            if (k in localData) {
              changes[k] = { oldValue: cloneVal(localData[k]), newValue: undefined };
              delete localData[k];
            }
          }
          if (Object.keys(changes).length) {
            queueMicrotask(() => onStorageChanged.emit(changes, 'local'));
          }
          if (typeof callback === 'function') {
            callback();
            return undefined;
          }
          return Promise.resolve();
        }
      },
      session: options.omitSessionStorage ? undefined : {
        get(keys) {
          if (hooks.storageSessionGetReject) return Promise.reject(hooks.storageSessionGetReject);
          return Promise.resolve(cloneVal(pickKeys(sessionData, keys)));
        },
        set(values) {
          if (hooks.storageSessionSetReject) return Promise.reject(hooks.storageSessionSetReject);
          for (const [k, v] of Object.entries(values || {})) {
            if (v === undefined) delete sessionData[k];
            else sessionData[k] = cloneVal(v);
          }
          return Promise.resolve();
        },
        clear() {
          if (hooks.storageSessionClearReject) return Promise.reject(hooks.storageSessionClearReject);
          for (const k of Object.keys(sessionData)) delete sessionData[k];
          return Promise.resolve();
        }
      },
      onChanged: onStorageChanged
    },
    action: {
      async setIcon(details) {
        const isDefault = details && details.path && details.path['16'] === '/assets/icons/icon16.png';
        if (isDefault) {
          if (hooks.setIconDefaultError) throw hooks.setIconDefaultError;
        } else if (hooks.setIconError) {
          throw hooks.setIconError;
        }
        state.toolbar.icon = details;
      },
      async setBadgeText({ text }) { state.toolbar.badgeText = text; },
      async setBadgeBackgroundColor({ color }) { state.toolbar.badgeColor = color; },
      async setBadgeTextColor({ color }) { state.toolbar.badgeTextColor = color; },
      async setTitle({ title }) { state.toolbar.title = title; },
      getUserSettings: options.omitGetUserSettings ? undefined : async () => {
        if (hooks.getUserSettingsReject) throw hooks.getUserSettingsReject;
        return { isOnToolbar };
      },
      onUserSettingsChanged: options.omitUserSettingsChanged ? undefined : onUserSettingsChanged,
      openPopup: options.omitOpenPopup ? undefined : async () => {
        if (hooks.openPopupReject) throw hooks.openPopupReject;
        state.openedPopupCount++;
      }
    },
    alarms: {
      async get(name) {
        if (hooks.alarmsGetReject) throw hooks.alarmsGetReject;
        return state.alarms.get(name);
      },
      async create(name, info) {
        if (hooks.alarmsCreateReject) throw hooks.alarmsCreateReject;
        state.alarms.set(name, { name, ...info });
      },
      async clear(name) {
        if (hooks.alarmsClearReject) throw hooks.alarmsClearReject;
        return state.alarms.delete(name);
      },
      onAlarm
    },
    notifications: {
      create(id, notifOpts, callback) {
        if (hooks.notifCreateThrow) throw new Error('notifications.create threw');
        if (hooks.notifCreateLastError) {
          lastErrorValue = { message: hooks.notifCreateLastError };
          try { callback?.(); } finally { lastErrorValue = null; }
          return;
        }
        state.notifications.push({ id, ...notifOpts });
        callback?.(id);
      },
      clear(id, callback) {
        state.clearedNotifications.push(id);
        callback?.(true);
      },
      onClicked: onNotifClicked
    },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: {
          async set({ value }) {
            if (hooks.webRtcSetReject) throw hooks.webRtcSetReject;
            policyValue = value;
          },
          async get() {
            if (hooks.webRtcGetReject) throw hooks.webRtcGetReject;
            return { value: policyValue, levelOfControl: policyLevel };
          },
          async clear() {
            if (hooks.webRtcClearReject) throw hooks.webRtcClearReject;
            policyValue = 'default';
          },
          onChange: onPolicyChanged
        },
        networkPredictionEnabled: {
          async set({ value }) {
            if (hooks.predictionSetReject) throw hooks.predictionSetReject;
            networkPrediction = value;
          },
          async clear() {
            if (hooks.predictionClearReject) throw hooks.predictionClearReject;
            networkPrediction = true;
          }
        }
      }
    },
    idle: options.omitIdle ? undefined : {
      queryState(seconds, cb) {
        if (hooks.idleQueryThrow) throw new Error('idle.queryState failed');
        if (hooks.idleQueryCallbackMode || typeof cb === 'function') {
          if (typeof cb === 'function') cb(idleState);
          return undefined;
        }
        return Promise.resolve(idleState);
      },
      setDetectionInterval(seconds) {
        if (hooks.idleSetIntervalThrow) throw new Error('setDetectionInterval failed');
        state.idleInterval = seconds;
      },
      onStateChanged: onIdleStateChanged
    },
    tabs: {
      async create(opts) {
        state.createdTabs.push(opts);
        return opts;
      }
    },
    i18n: {
      getMessage(key) { return enLocale[key]?.message || ''; },
      getUILanguage() { return options.uiLanguage || 'en-US'; }
    }
  };

  return { chrome, state, hooks };
}

module.exports = { createChromeMock, createEventTarget };
