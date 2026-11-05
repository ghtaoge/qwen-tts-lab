const api = require('../../lib/api');
const preferences = require('../../lib/preferences');
const MODES = [
  {id: 'buddy', name: '声波伙伴', hint: '小伙伴随声音动起来'},
  {id: 'wave', name: '声波电台', hint: '声柱跟随音量变化'},
  {id: 'text', name: '专注文字', hint: '全屏显示朗读文字'}
];
const DEVICE_STATES = {
  idle: '等待播放', waiting: '等待音频', buffering: '正在缓冲',
  playing: '正在播放', completed: '播放完成', error: '播放遇到问题', offline: '尚未连接'
};
const ACTIVE = ['leased', 'waiting', 'buffering', 'playing'];
const volumeValue = value => typeof value === 'number' && Number.isFinite(value)
  ? Math.min(100, Math.max(0, Math.round(value))) : null;

Page({
  data: {
    connected: false, loading: true, deviceOnline: false, deviceSimulated: false,
    deviceName: '开发板', deviceState: '连接中', deviceVolume: 70, volumeSaving: false,
    canStop: false, stopBusy: false, error: '', advancedOpen: false,
    displayModes: MODES, displayMode: 'buddy', useCache: true,
    modelState: '尚未连接电脑服务', hardware: '', warmupBusy: false, activeJobs: 0
  },
  onLoad() {
    this.alive = true; this.visible = false; this.statusEpoch = 0; this.volumeRevision = 0;
  },
  onShow() {
    const tab = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tab) tab.setData({selected:2});
    this.visible = true;
    const prefs = preferences.get();
    this.setData({displayMode: prefs.displayMode, useCache: prefs.useCache,
      loading: true, volumeSaving: !!this.volumeRequest});
    this.refreshStatus();
  },
  onHide() {
    this.visible = false; this.statusEpoch++; this.volumeRevision++;
    this.volumeDragging = false; this.pendingVolume = null;
    clearTimeout(this.statusTimer);
  },
  onUnload() { this.onHide(); this.alive = false; },
  scheduleStatusPoll() {
    clearTimeout(this.statusTimer);
    if (!this.alive || !this.visible) return;
    this.statusTimer = setTimeout(() => {
      if (this.alive && this.visible) this.refreshStatus();
    }, 4000);
  },
  async refreshStatus() {
    if (!this.alive || !this.visible) return;
    const epoch = ++this.statusEpoch, volumeRevision = this.volumeRevision;
    const deviceId = api.config().deviceId;
    try {
      const [status, devices] = await Promise.all([api.request('/api/status'), api.request('/api/devices')]);
      if (!this.alive || !this.visible || epoch !== this.statusEpoch) return;
      const device = Array.isArray(devices) ? devices.find(item => item.id === deviceId) : null;
      const engine = status.engine || {}, hardware = status.hardware || {};
      this.currentJobId = device && device.job_id;
      const update = {
        connected: true, loading: false, deviceOnline: !!(device && device.online),
        deviceSimulated: !!(device && device.simulated),
        deviceState: device && device.online ? (DEVICE_STATES[device.status] || '设备已连接') : '尚未连接',
        canStop: !!(device && device.job_id && ACTIVE.includes(device.status)),
        modelState: engine.message || '电脑服务已连接',
        hardware: hardware.gpu_name || (String(status.backend || '').includes('vulkan') ? 'Vulkan 加速' : String(status.backend || '').includes('gguf') ? '量化 CPU 加速' : 'CPU 推理'),
        warmupBusy: ['loading', 'warming'].includes(engine.state), activeJobs: status.active_jobs || 0,
        error: engine.error || ''
      };
      const remoteVolume = device && volumeValue(device.volume);
      if (remoteVolume !== null && remoteVolume !== undefined && !this.volumeDragging &&
          !this.volumeRequest && volumeRevision === this.volumeRevision) update.deviceVolume = remoteVolume;
      this.setData(update);
    } catch (error) {
      if (this.alive && this.visible && epoch === this.statusEpoch) {
        this.setData({connected: false, loading: false, deviceOnline: false,
          deviceState: '电脑服务未连接', error: error.message});
      }
    } finally {
      if (this.alive && this.visible && epoch === this.statusEpoch) this.scheduleStatusPoll();
    }
  },
  volumeChanging(event) {
    const value = volumeValue(event.detail.value);
    if (value === null) return;
    this.volumeDragging = true; this.volumeRevision++;
    this.setData({deviceVolume: value});
  },
  changeVolume(event) {
    const value = volumeValue(event.detail.value);
    if (value === null) return Promise.resolve();
    this.volumeDragging = false; this.volumeRevision++;
    this.pendingVolume = {value, deviceId: api.config().deviceId, revision: this.volumeRevision};
    this.setData({deviceVolume: value, volumeSaving: true, error: ''});
    return this.flushVolume();
  },
  flushVolume() {
    if (this.volumeRequest) return this.volumeRequest;
    this.volumeRequest = (async () => {
      while (this.pendingVolume && this.alive && this.visible) {
        const pending = this.pendingVolume; this.pendingVolume = null;
        try { await api.request('/api/devices/' + encodeURIComponent(pending.deviceId) + '/volume', 'POST', {volume: pending.value}); }
        catch (error) {
          if (this.alive && this.visible && pending.revision === this.volumeRevision) {
            this.setData({error: '音量保存失败：' + error.message});
          }
        }
      }
    })().finally(() => {
      this.volumeRequest = null;
      if (this.pendingVolume && this.alive && this.visible) return this.flushVolume();
      if (this.alive && this.visible) this.setData({volumeSaving: false});
    });
    return this.volumeRequest;
  },
  savePreference(patch) {
    try { const value = preferences.save(patch); this.setData(patch); return value; }
    catch (_) { this.setData({error: '设置保存失败，请重试'}); return null; }
  },
  selectDisplayMode(event) {
    const id = event.currentTarget.dataset.id;
    if (MODES.some(mode => mode.id === id)) this.savePreference({displayMode: id});
  },
  toggleCache(event) { this.savePreference({useCache: !!event.detail.value}); },
  toggleAdvanced() { this.setData({advancedOpen: !this.data.advancedOpen}); },
  openSettings() { wx.navigateTo({url: '/pages/settings/index'}); },
  async loadModel() {
    if (this.data.warmupBusy || this.data.activeJobs) return;
    this.setData({warmupBusy: true, error: ''});
    try {
      await api.request('/api/model/load', 'POST');
      if (!this.alive || !this.visible) return;
      wx.showToast({title: '开始加载并预热', icon: 'none'});
      this.refreshStatus();
    } catch (error) {
      if (this.alive && this.visible) this.setData({warmupBusy: false, error: error.message});
    }
  },
  async stopPlayback() {
    if (this.data.stopBusy || !this.currentJobId) return;
    const id = this.currentJobId;
    this.setData({stopBusy: true, error: ''});
    try {
      await api.request('/api/jobs/' + encodeURIComponent(id) + '/cancel', 'POST');
      if (this.alive && this.visible) { wx.showToast({title: '已发送停止指令', icon: 'none'}); this.refreshStatus(); }
    } catch (error) { if (this.alive && this.visible) this.setData({error: error.message}); }
    finally { if (this.alive && this.visible) this.setData({stopBusy: false}); }
  }
});
