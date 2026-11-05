const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const root = path.resolve(__dirname, '../miniprogram');

function preferenceStore(initial) {
  const values = new Map(initial === undefined ? [] : [['qwenPreferences', initial]]);
  const context = {module: {exports: {}}, wx: {getStorageSync: key => values.get(key), setStorageSync: (key, value) => values.set(key, value)}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/preferences.js'), 'utf8'), context);
  return {preferences: context.module.exports, values};
}

function harness(pageName, api) {
  const timers = new Map(), navigation = [], storage = new Map(), toasts = [], requests = [];
  const store = preferenceStore(); let definition, timerId = 0;
  const mockApi = Object.assign({
    config: () => ({baseUrl: 'http://192.168.1.10:8766', clientToken: 'test-token', deviceId: 'esp32_01'}),
    request: async route => route === '/api/status' ? {engine: {state: 'ready', message: '已预热'}, hardware: {}, backend: 'gguf-cpu-stateful-codec', active_jobs: 0} : []
  }, api);
  const actualRequest = mockApi.request;
  mockApi.request = (...args) => { requests.push(args); return actualRequest(...args); };
  const sandbox = {
    require: name => name.includes('preferences') ? store.preferences : mockApi,
    Page: value => { definition = value; },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, {fn, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    wx: {
      showToast: value => toasts.push(value),
      navigateTo: value => navigation.push(value), navigateBack: value => navigation.push(value),
      setStorageSync: (key, value) => storage.set(key, value)
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', pageName, 'index.js'), 'utf8'), sandbox);
  const updates = [];
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { updates.push(patch); Object.assign(this.data, patch); }
  });
  page.onLoad();
  return {page, definition, mockApi, requests, timers, navigation, storage, toasts, updates, preferences: store.preferences, wx: sandbox.wx};
}

function testPreferencesValidatePersistAndReturnIndependentSnapshots() {
  const store = preferenceStore({selectedVoice: 'bad', speed: 99, displayMode: 'bad', sendDevice: 'false', autoPlayParts: null, extra: 'discard'});
  const defaults = store.preferences.get();
  assert.equal(defaults.selectedVoice, 'Serena'); assert.equal(defaults.speed, 1); assert.equal(defaults.displayMode, 'buddy');
  assert.equal(defaults.sendDevice, true); assert.equal(defaults.autoPlayParts, false); assert.equal(defaults.extra, undefined);
  store.preferences.save({selectedVoice: 'Dylan', speed: 1.15, displayMode: 'wave', useCache: false, sendDevice: false});
  const saved = store.preferences.get();
  assert.equal(saved.selectedVoice, 'Dylan'); assert.equal(saved.speed, 1.15); assert.equal(saved.displayMode, 'wave');
  assert.equal(saved.useCache, false); assert.equal(saved.sendDevice, false); assert.equal(saved.autoPlayParts, false);
  saved.speed = 99; assert.equal(store.preferences.get().speed, 1.15);
  store.preferences.save({speed: 999, displayMode: 'wrong', useCache: 'yes'});
  assert.equal(store.preferences.get().speed, 1.15); assert.equal(store.preferences.get().displayMode, 'wave');
  assert.equal(store.preferences.get().useCache, false);
  assert.equal(preferenceStore([]).preferences.get().speed, 1);
  assert.equal(preferenceStore({speed: NaN}).preferences.get().speed, 1);
  const legacy = preferenceStore({autoPlayParts: true});
  assert.equal(legacy.preferences.get().autoPlayParts, false, 'saved first-fragment autoplay must stay disabled');
  legacy.preferences.save({autoPlayParts: true});
  assert.equal(legacy.values.get('qwenPreferences').autoPlayParts, false, 'saving preferences migrates the retired setting');
}

async function testEmptyDevicesAndPageLifecycle() {
  const h = harness('device');
  h.page.onShow(); await tick();
  assert.equal(h.page.data.connected, true); assert.equal(h.page.data.deviceOnline, false);
  assert.equal(h.page.data.error, ''); assert.equal(h.page.data.hardware, '量化 CPU 加速');
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].delay, 4000);
  const scheduled = [...h.timers.values()][0].fn;
  const count = h.requests.length; h.page.onHide(); scheduled(); await tick();
  assert.equal(h.timers.size, 0); assert.equal(h.requests.length, count, 'hidden tabs must not keep polling');

  const status = deferred(), devices = deferred();
  const pending = harness('device', {request: route => route === '/api/status' ? status.promise : devices.promise});
  pending.page.onShow(); const writes = pending.updates.length; pending.page.onUnload();
  status.resolve({engine: {state: 'ready'}}); devices.resolve([]); await tick();
  assert.equal(pending.updates.length, writes, 'late replies must not mutate an unloaded page');
  assert.equal(pending.timers.size, 0);
}

async function testPollDoesNotOverwriteVolumeBeingDragged() {
  const status = deferred(), devices = deferred();
  const h = harness('device', {request: route => route === '/api/status' ? status.promise : devices.promise});
  h.page.visible = true;
  const refresh = h.page.refreshStatus();
  h.page.volumeChanging({detail: {value: 63}});
  status.resolve({engine: {state: 'ready'}, hardware: {}});
  devices.resolve([{id: 'esp32_01', online: true, volume: 20, status: 'idle'}]);
  await refresh;
  assert.equal(h.page.data.deviceVolume, 63, 'an older poll must not move the slider under the user');
  assert.equal(h.page.data.deviceOnline, true);
}

async function testVolumeChangesAreSerializedWithLatestIntent() {
  const first = deferred(), second = deferred(); const posts = [];
  const h = harness('device', {request(route, method, data) {
    if (method === 'POST') { posts.push(data.volume); return posts.length === 1 ? first.promise : second.promise; }
    return Promise.resolve(route === '/api/status' ? {engine: {state: 'ready'}} : [{id: 'esp32_01', online: true, volume: 10, status: 'playing', job_id: 'live'}]);
  }});
  h.page.visible = true;
  const one = h.page.changeVolume({detail: {value: 25}});
  const two = h.page.changeVolume({detail: {value: 81}});
  assert.deepEqual(posts, [25], 'do not race two writes on the device');
  await h.page.refreshStatus(); assert.equal(h.page.data.deviceVolume, 81);
  first.resolve({}); await tick(); assert.deepEqual(posts, [25, 81]);
  second.resolve({}); await Promise.all([one, two]);
  assert.equal(h.page.data.deviceVolume, 81); assert.equal(h.page.data.volumeSaving, false);

  const blocked = deferred(), sent = [];
  const hidden = harness('device', {request(route, method, data) { sent.push(data.volume); return blocked.promise; }});
  hidden.page.visible = true;
  const pending = hidden.page.changeVolume({detail: {value: 30}});
  hidden.page.changeVolume({detail: {value: 90}}); hidden.page.onHide(); blocked.resolve({}); await pending;
  assert.deepEqual(sent, [30], 'discard unsubmitted volume changes when leaving the tab');
}

async function testPreferencesDoNotGenerateOrSubmitDeviceJobs() {
  const h = harness('device');
  h.page.selectDisplayMode({currentTarget: {dataset: {id: 'wave'}}});
  h.page.toggleCache({detail: {value: false}});
  assert.equal(h.preferences.get().displayMode, 'wave'); assert.equal(h.preferences.get().useCache, false);
  assert.equal(h.preferences.get().autoPlayParts, false); assert.equal(h.requests.length, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'pages/device/index.wxml'), 'utf8'), /toggleAutoPlay|首段就绪/);
  h.page.selectDisplayMode({currentTarget: {dataset: {id: 'unknown'}}}); assert.equal(h.preferences.get().displayMode, 'wave');
  h.page.openSettings(); assert.equal(h.navigation[0].url, '/pages/settings/index');
}

async function testDeviceSelectionAndStopUseConfiguredDevice() {
  const h = harness('device', {request: async route => route === '/api/status' ? {engine: {state: 'ready'}} : [{id: 'other', online: true, volume: 99, status: 'playing', job_id: 'other-job'}]});
  h.page.visible = true; await h.page.refreshStatus();
  assert.equal(h.page.data.deviceOnline, false); assert.equal(h.page.data.canStop, false);
  await h.page.stopPlayback(); assert.equal(h.requests.length, 2, 'never stop another device');
  h.page.currentJobId = 'mine'; await h.page.stopPlayback();
  assert.ok(h.requests.some(([route, method]) => route === '/api/jobs/mine/cancel' && method === 'POST'));
}

async function testSettingsValidationAndSaveLifecycle() {
  const h = harness('settings', {request: async () => ({device_id: 'esp32_01', engine: {state: 'ready'}})});
  for (const baseUrl of ['', 'ftp://192.168.1.1', 'http://256.1.1.1', 'http://a:99999', 'http://user:pass@a', 'http://a/#fragment', 'http://a/?query=1', 'http://a..b', 'http://[::::]']) {
    h.page.setData({baseUrl}); await h.page.saveSettings(); assert.ok(h.page.data.error, baseUrl);
  }
  assert.equal(h.storage.size, 0); assert.equal(h.requests.length, 0);
  h.page.setData({baseUrl: 'http://192.168.1.10:8766', deviceId: ''}); await h.page.saveSettings();
  assert.equal(h.requests.length, 0);
  h.page.setData({deviceId: 'esp32_01', clientToken: ''}); await h.page.saveSettings(); assert.equal(h.requests.length, 0);
  h.page.setData({baseUrl: '  http://192.168.1.10:8766/// ', clientToken: ' test-token ', deviceId: ' esp32_01 '});
  await h.page.saveSettings();
  assert.equal(h.storage.get('qwenConnection').baseUrl, 'http://192.168.1.10:8766');
  assert.equal(h.storage.get('qwenConnection').clientToken, 'test-token');
  assert.equal(h.navigation[0].delta, 1); assert.equal(h.page.data.saving, false);

  const response = deferred();
  const pending = harness('settings', {request: () => response.promise});
  const one = pending.page.saveSettings(); await pending.page.saveSettings();
  assert.equal(pending.requests.length, 1, 'double tap must not make duplicate connection probes');
  pending.page.onUnload(); response.resolve({device_id: 'esp32_01', engine: {state: 'ready'}}); await one;
  assert.equal(pending.navigation.length, 0, 'never navigate after the page was closed');

  const wrongService = harness('settings', {request: async () => ({})});
  await wrongService.page.saveSettings(); assert.equal(wrongService.navigation.length, 0);
  assert.match(wrongService.page.data.error, /未返回语音服务/);

  const failedStorage = harness('settings');
  // An exhausted WeChat storage quota must not be reported as a successful save.
  failedStorage.wx.setStorageSync = () => { throw new Error('quota'); };
  await failedStorage.page.saveSettings();
  assert.match(failedStorage.page.data.error, /^设置保存失败/); assert.equal(failedStorage.requests.length, 0);
}

function testPageAssetsAndEventsExist() {
  for (const name of ['device', 'settings']) {
    const h = harness(name), template = fs.readFileSync(path.join(root, 'pages', name, 'index.wxml'), 'utf8');
    JSON.parse(fs.readFileSync(path.join(root, 'pages', name, 'index.json'), 'utf8'));
    for (const match of template.matchAll(/bind(?:tap|input|change|changing)="([A-Za-z][A-Za-z0-9]*)"/g)) {
      assert.equal(typeof h.definition[match[1]], 'function', name + ': ' + match[1]);
    }
  }
}

(async () => {
  testPreferencesValidatePersistAndReturnIndependentSnapshots();
  await testEmptyDevicesAndPageLifecycle(); await testPollDoesNotOverwriteVolumeBeingDragged();
  await testVolumeChangesAreSerializedWithLatestIntent(); await testPreferencesDoNotGenerateOrSubmitDeviceJobs();
  await testDeviceSelectionAndStopUseConfiguredDevice(); await testSettingsValidationAndSaveLifecycle();
  testPageAssetsAndEventsExist();
  console.log('Device/settings: preferences, volume ordering, stale polling, lifecycle, connection validation and navigation passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
