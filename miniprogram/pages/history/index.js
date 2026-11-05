const api = require('../../lib/api');
const preferences = require('../../lib/preferences');

const ACTIVE_DELIVERY = ['pending', 'leased', 'waiting', 'buffering', 'playing'];
const STATUS = {queued:'排队中', loading:'加载中', synthesizing:'生成中', completed:'已生成', failed:'生成失败', cancelled:'已停止'};
const DELIVERY = {pending:'等待开发板', leased:'开发板已领取', waiting:'等待音频', buffering:'开发板缓冲中', playing:'开发板播放中', delivered:'开发板播放完成', error:'开发板播放失败', cancelled:'开发板已停止', expired:'播放任务已过期'};
const VOICES = {Vivian:'明亮女声', Serena:'温柔女声', Uncle_Fu:'沉稳男声', Dylan:'北京男声', Eric:'成都男声'};
const keyOf = job => job.replay_of || job.id;

function dateLabel(seconds) {
  if (!Number.isFinite(Number(seconds)) || !seconds) return '';
  const date = new Date(Number(seconds) * 1000);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    history: [], loading: false, error: '', expandedKey: '',
    playingKey: '', downloadingKey: '', replayBusy: false, replayKey: '', canStopReplay:false
  },

  onLoad() {
    this.alive = true; this.visible = false;
    this.rawJobs = []; this.boardStates = new Map();
    this.playEpoch = 0; this.refreshEpoch = 0; this.replayEpoch = 0; this.pollEpoch = 0;
    this.phoneFiles = new Map();
    this.boardBusy = false;
  },
  onShow() {
    const tab = typeof this.getTabBar === 'function' && this.getTabBar();
    if (tab) tab.setData({selected:1});
    if (!this.alive) return;
    this.visible = true;
    this.renderHistory();
    if (this.pendingError) { this.setData({error:this.pendingError}); this.pendingError = ''; }
    this.refreshHistory();
    if (this.replayJob && this.boardBusy) this.scheduleReplayPoll(0);
  },
  onHide() {
    this.visible = false; this.refreshEpoch++; this.pollEpoch++;
    clearTimeout(this.replayTimer);
    this.stopPhone();
  },
  onUnload() {
    this.alive = false; this.visible = false;
    this.refreshEpoch++; this.pollEpoch++; this.replayEpoch++;
    clearTimeout(this.replayTimer); this.stopPhone();
  },
  onPullDownRefresh() {
    return this.refreshHistory().finally(() => wx.stopPullDownRefresh());
  },

  async refreshHistory() {
    const epoch = ++this.refreshEpoch;
    this.setData({loading:true});
    try {
      const response = await api.request('/api/jobs');
      if (!this.alive || !this.visible || epoch !== this.refreshEpoch) return;
      if (!Array.isArray(response)) throw new Error('记录格式不正确');
      if (this.historyError && this.data.error === this.historyError) this.setData({error:''});
      this.historyError = '';
      this.rawJobs = response;
      this.renderHistory();
    } catch (error) {
      if (this.alive && this.visible && epoch === this.refreshEpoch) {
        this.historyError = '记录加载失败：'+error.message;
        this.setData({error:this.historyError});
      }
    } finally {
      if (this.alive && this.visible && epoch === this.refreshEpoch) this.setData({loading:false});
    }
  },
  renderHistory() {
    if (!this.alive || !this.visible) return;
    const seen = new Set();
    const history = (this.rawJobs || []).slice().sort((a,b) => (b.created_at||0)-(a.created_at||0)).filter(job => {
      if (!job.id || seen.has(keyOf(job))) return false;
      seen.add(keyOf(job)); return true;
    }).map(job => {
      const key = keyOf(job), candidate = this.boardStates.get(key);
      // A newer replay created on another page supersedes this page's old
      // delivery overlay. During our own submission, keep the inline feedback.
      const ownActiveReplay = this.boardBusy && this.replayJob && this.replayJob.key === key;
      const board = candidate && (candidate.seenId === job.id || candidate.jobId === job.id || ownActiveReplay) ? candidate : null;
      return Object.assign({}, job, {
        key, canReplay:job.status === 'completed' && !!job.audio_url,
        voiceLabel:VOICES[job.voice] || job.voice || '默认音色',
        durationLabel:job.duration == null ? '时长待生成' : Number(job.duration).toFixed(1)+' 秒',
        timeLabel:dateLabel(job.created_at), statusLabel:STATUS[job.status] || job.status,
        deviceLabel:board ? board.label : (DELIVERY[job.delivery] || ''),
        deviceFailed:board ? board.failed : job.delivery === 'error',
        detailError:board && board.error || job.device_error || job.error || ''
      });
    });
    const expandedKey = history.some(row => row.key === this.data.expandedKey) ? this.data.expandedKey : '';
    this.setData({history, expandedKey, replayBusy:!!this.boardBusy, canStopReplay:!!(this.boardBusy && this.replayJob && !this.stopBusy), replayKey:this.replayJob ? this.replayJob.key : (this.boardBusy ? this.data.replayKey : '')});
  },
  findRecord(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset.id;
    return this.data.history.find(row => row.id === id);
  },
  toggleExpand(event) {
    const record = this.findRecord(event);
    if (record) this.setData({expandedKey:this.data.expandedKey === record.key ? '' : record.key});
  },
  goGenerate() { wx.switchTab({url:'/pages/index/index'}); },

  stopPhone() {
    this.playEpoch = (this.playEpoch || 0) + 1;
    const download = this.manualDownload; this.manualDownload = null;
    if (download && download.abort) download.abort();
    const audio = this.audio; this.audio = null;
    if (audio) { audio.stop(); audio.destroy(); }
    if (this.alive) this.setData({playingKey:'', downloadingKey:''});
    return this.playEpoch;
  },
  async playPhone(event) {
    const record = this.findRecord(event);
    if (!record || !record.canReplay) { this.setData({error:'这条语音尚未生成完成，暂时不能播放。'}); return; }
    if (this.data.downloadingKey === record.key) return;
    const epoch = this.stopPhone();
    this.setData({error:'', downloadingKey:record.key});
    try {
      if (!this.phoneFiles) this.phoneFiles = new Map();
      let file = this.phoneFiles.get(record.audio_url);
      if (!file) {
        const download = api.download(record.audio_url);
        this.manualDownload = download;
        file = await download;
      }
      if (!this.alive || !this.visible || epoch !== this.playEpoch) return;
      this.manualDownload = null;
      this.phoneFiles.delete(record.audio_url); this.phoneFiles.set(record.audio_url, file);
      while (this.phoneFiles.size > 8) this.phoneFiles.delete(this.phoneFiles.keys().next().value);
      // Each manual replay owns its audio context. Late callbacks from a
      // stopped record cannot change the state of a newly selected recording.
      const audio = wx.createInnerAudioContext(); this.audio = audio;
      const current = () => this.alive && this.visible && epoch === this.playEpoch && this.audio === audio;
      audio.onPlay(() => { if (current()) this.setData({playingKey:record.key, downloadingKey:''}); });
      audio.onEnded(() => { if (current()) this.stopPhone(); });
      audio.onError(error => {
        if (!current()) return;
        this.phoneFiles.delete(record.audio_url);
        this.stopPhone(); this.setData({error:'手机播放失败：'+(error.errMsg || '请检查音频文件后重试')});
      });
      audio.src = file; audio.play();
    } catch (error) {
      if (this.alive && this.visible && epoch === this.playEpoch) {
        this.stopPhone(); this.setData({error:'手机播放失败：'+error.message});
      }
    } finally {
      if (epoch === this.playEpoch) this.manualDownload = null;
    }
  },

  async replayDevice(event) {
    const record = this.findRecord(event);
    if (this.boardBusy) {
      if (record && this.replayJob && record.key === this.replayJob.key && !this.stopBusy) return this.stopReplay();
      return;
    }
    if (!record || !record.canReplay) { this.setData({error:'这条语音尚未生成完成，暂时不能重播。'}); return; }
    const epoch = ++this.replayEpoch;
    this.boardBusy = true; this.pollFailures = 0;
    this.setData({replayBusy:true, replayKey:record.key, error:''});
    this.boardStates.set(record.key, {label:'正在发送到开发板', failed:false, seenId:record.id}); this.renderHistory();
    try {
      const job = await api.request('/api/jobs/'+record.id+'/replay', 'POST', {
        device_id:api.config().deviceId,
        display_mode:preferences.get().displayMode || 'buddy'
      });
      if (!this.alive || epoch !== this.replayEpoch) return;
      this.replayJob = {id:job.id, key:record.key, snapshot:job};
      this.applyReplay(job);
      if (this.visible && this.boardBusy) this.scheduleReplayPoll(0);
    } catch (error) {
      if (!this.alive || epoch !== this.replayEpoch) return;
      this.boardBusy = false; this.replayJob = null;
      this.boardStates.set(record.key, {label:'发送失败，可重试', failed:true, error:error.message, seenId:record.id});
      this.pendingError = '开发板重播失败：'+error.message;
      if (this.visible) { this.renderHistory(); this.setData({error:this.pendingError}); this.pendingError = ''; }
    }
  },
  async stopReplay() {
    if (!this.replayJob || this.stopBusy) return;
    const id = this.replayJob.id;
    this.stopBusy = true; this.pollEpoch++; clearTimeout(this.replayTimer); this.renderHistory();
    try {
      const job = await api.request('/api/jobs/'+id+'/cancel', 'POST');
      if (!this.alive || !this.replayJob || this.replayJob.id !== id) return;
      this.applyReplay(job);
    } catch (error) {
      if (!this.alive || !this.replayJob || this.replayJob.id !== id) return;
      this.pendingError = '停止开发板失败：'+error.message;
      if (this.visible) { this.setData({error:this.pendingError}); this.pendingError = ''; }
    } finally {
      this.stopBusy = false;
      if (this.alive && this.visible) {
        this.renderHistory();
        if (this.boardBusy) this.scheduleReplayPoll(0);
      }
    }
  },
  applyReplay(job) {
    if (!this.replayJob) return;
    const key = this.replayJob.key;
    this.replayJob.snapshot = job;
    const active = ACTIVE_DELIVERY.includes(job.delivery);
    const failed = job.delivery === 'error' || job.status === 'failed';
    const error = failed ? (job.device_error || job.error || '开发板播放失败，请检查设备连接后重试。') : '';
    const previous = this.boardStates.get(key) || {};
    this.boardStates.set(key, {label:(job.device_delivery_simulated ? '模拟 · ' : '')+(DELIVERY[job.delivery] || '播放任务已结束'), failed, error, jobId:job.id, seenId:previous.seenId});
    if (!active) { this.boardBusy = false; this.replayJob = null; }
    if (error) this.pendingError = error;
    if (this.visible) {
      this.renderHistory();
      if (this.pendingError) { this.setData({error:this.pendingError}); this.pendingError = ''; }
      if (!active) this.refreshHistory();
    }
  },
  scheduleReplayPoll(delay) {
    clearTimeout(this.replayTimer);
    if (!this.alive || !this.visible || !this.replayJob || !this.boardBusy) return;
    const epoch = ++this.pollEpoch, id = this.replayJob.id;
    this.replayTimer = setTimeout(async () => {
      if (!this.alive || !this.visible || epoch !== this.pollEpoch || !this.replayJob || this.replayJob.id !== id) return;
      const previous = this.replayJob.snapshot;
      const query = previous.revision ? '?revision='+encodeURIComponent(previous.revision)+'&after_parts='+(previous.parts||[]).length+'&wait_ms=1000' : '';
      try {
        const job = await api.request('/api/jobs/'+id+query);
        if (!this.alive || !this.visible || epoch !== this.pollEpoch || !this.replayJob || this.replayJob.id !== id) return;
        if (this.pollError && this.data.error === this.pollError) this.setData({error:''});
        this.pollError = ''; this.pollFailures = 0;
        this.applyReplay(job);
        if (this.boardBusy) this.scheduleReplayPoll(job.revision ? 0 : 500);
      } catch (error) {
        if (!this.alive || !this.visible || epoch !== this.pollEpoch || !this.replayJob || this.replayJob.id !== id) return;
        if (error.status === 404) {
          this.applyReplay({id, status:'failed', delivery:'error', error:'播放任务已丢失，请重新点击重播。'}); return;
        }
        this.pollFailures = (this.pollFailures || 0) + 1;
        this.pollError = '播放状态更新失败，正在重连：'+error.message;
        this.setData({error:this.pollError});
        this.scheduleReplayPoll(Math.min(4000, 500*Math.pow(2, Math.min(this.pollFailures, 3))));
      }
    }, delay);
  }
});
