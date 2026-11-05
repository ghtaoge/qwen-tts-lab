const api = require('../../lib/api');

function validBaseUrl(value) {
  const match = /^(https?):\/\/([^\/?#\s]+)(\/[^?#\s]*)?$/i.exec(value);
  if (!match || match[2].includes('@')) return false;
  const authority = /^(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i.exec(match[2]);
  if (!authority || (authority[2] && (+authority[2] < 1 || +authority[2] > 65535))) return false;
  const host = authority[1];
  if (host[0] === '[') {
    const address = host.slice(1, -1), halves = address.split('::'), groups = address.split(':').filter(Boolean);
    if (halves.length > 2 || address.includes(':::') || groups.some(group => group.length > 4) ||
        (halves.length === 1 ? groups.length !== 8 : groups.length >= 8)) return false;
  } else if (/^[0-9.]+$/.test(host)) {
    const parts = host.split('.');
    if (parts.length !== 4 || parts.some(part => !part || +part > 255)) return false;
  } else if (host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return false;
  return true;
}

Page({
  data: {baseUrl: '', clientToken: '', deviceId: '', saving: false, error: ''},
  onLoad() {
    this.alive = true;
    const settings = api.config();
    this.setData({baseUrl: typeof settings.baseUrl === 'string' ? settings.baseUrl : '',
      clientToken: typeof settings.clientToken === 'string' ? settings.clientToken : '',
      deviceId: typeof settings.deviceId === 'string' ? settings.deviceId : ''});
  },
  onUnload() { this.alive = false; },
  settingInput(event) {
    const key = event.currentTarget.dataset.key;
    if (['baseUrl', 'clientToken', 'deviceId'].includes(key)) this.setData({[key]: event.detail.value, error: ''});
  },
  async saveSettings() {
    if (this.data.saving) return;
    const baseUrl = this.data.baseUrl.trim().replace(/\/+$/, '');
    const deviceId = this.data.deviceId.trim(), clientToken = this.data.clientToken.trim();
    let error = '';
    if (!validBaseUrl(baseUrl)) error = '请填写有效的 http 或 https 电脑服务地址';
    else if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) error = '设备编号需为字母、数字、下划线或短横线';
    else if (!clientToken) error = '请填写客户端令牌';
    if (error) { this.setData({error}); return; }
    this.setData({saving: true, error: ''});
    let saved = false;
    try {
      wx.setStorageSync('qwenConnection', {baseUrl, clientToken, deviceId});
      saved = true;
      const status = await api.request('/api/status');
      if (!this.alive) return;
      if (!status || !status.engine || typeof status.engine.state !== 'string' || !status.device_id) {
        this.setData({error: '设置已保存，但该地址未返回语音服务状态，请检查电脑地址'});
        return;
      }
      if (status.device_id && status.device_id !== deviceId) {
        this.setData({error: '设置已保存，但电脑设备编号为 ' + status.device_id + '，请核对后保存'});
        return;
      }
      wx.showToast({title: '连接成功', icon: 'success'});
      wx.navigateBack({delta: 1});
    } catch (error) {
      if (this.alive) this.setData({error: (saved ? '设置已保存，连接未成功：' : '设置保存失败：') + error.message});
    } finally { if (this.alive) this.setData({saving: false}); }
  }
});
