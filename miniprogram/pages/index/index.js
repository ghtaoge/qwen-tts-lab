const api=require('../../lib/api');
const preferences=require('../../lib/preferences');
const SPEEDS=Array.from({length:16},(_,index)=>Number((.75+index*.05).toFixed(2)));
const STATE={queued:'等待推理',loading:'加载模型',synthesizing:'生成中',completed:'生成完成',failed:'失败',cancelled:'已停止'};
const DELIVERY={pending:'等待开发板领取',leased:'开发板已领取',waiting:'开发板等待音频',buffering:'开发板正在缓冲',playing:'开发板播放中',delivered:'开发板播放完成',error:'开发板播放失败',cancelled:'设备播放已停止',expired:'设备任务已过期'};
const deliveryText=job=>job.delivery?(job.device_delivery_simulated?'模拟 · ':'')+(DELIVERY[job.delivery]||job.delivery):'';
const secs=value=>value==null?'—':Number(value).toFixed(2)+' s';
const MODES=[{id:'buddy',name:'声波伙伴',hint:'眨眼、动嘴，陪你说完一句话'},{id:'wave',name:'声波电台',hint:'小声柱跟着音量一起跳'},{id:'text',name:'专注文字',hint:'文字铺满屏幕，安静阅读'}];
function screenLine(job){
  if(job.status==='failed'||job.delivery==='error')return '出了点小状况，等你重新开始。';
  if(job.status==='cancelled'||job.delivery==='cancelled')return '收到，先安静一会儿。';
  if(job.delivery==='expired')return '这封语音已过期，再送来一次吧。';
  if(job.delivery==='delivered')return job.device_delivery_simulated?'模拟接收完成，实物播放尚未确认。':'读完啦，送你一颗小星星。';
  if(job.delivery==='playing')return job.device_delivery_simulated?'模拟接收中，等待实物伙伴。':'正在读给你听，嘴巴跟着声音动。';
  if(job.delivery==='buffering')return '等下一口声音接上，文字还在这里。';
  if(job.status==='queued')return '文字排好队啦，马上轮到我。';
  if(job.status==='loading')return '正在唤醒声音，先眨眨眼。';
  if(job.status==='synthesizing')return '正在生成完整语音，全部准备好后自动播放。';
  return job.device_id?'声音准备好了，等小伙伴接收。':'声音准备好了，点试听听看。';
}
Page({
  data:{text:'',voices:[],selectedVoice:'Serena',voiceLabel:'温柔女声',voiceIndex:1,speed:1,speedLabel:'1.00×',speedIndex:5,speedOptions:SPEEDS.map(speed=>speed.toFixed(2)+'×'),deviceVolume:70,
    displayMode:'buddy',displayModes:MODES,screenHint:'我准备好啦，等你送来一句话。',
    sendDevice:true,useCache:true,autoPlayParts:false,busy:false,stage:'准备就绪',modelState:'连接中',hardware:'',deviceOnline:false,deviceSimulated:false,error:'',result:null,history:[],playing:false,
    streamStatus:'',browserFirstLabel:'—',settingsOpen:false,baseUrl:'',clientToken:'',deviceId:'esp32_01',elapsed:'—',loadBusy:false,connected:false,replayBusy:false,phoneLoading:false,deviceActive:false},
  onLoad(){
    this.alive=true;this.visible=true;this.playEpoch=0;this.partFiles=new Map();this.partDownloads=new Map();this.completeFiles=new Map();this.audio=null;
    this.applySettings();this.applyPreferences();this.initialize();
  },
  onShow(){const tab=typeof this.getTabBar==='function'&&this.getTabBar();if(tab)tab.setData({selected:0});if(this.alive){this.visible=true;const settings=api.config();const changed=this.data.baseUrl&&(settings.baseUrl!==this.data.baseUrl||settings.clientToken!==this.data.clientToken);this.applySettings();this.applyPreferences();if(changed){clearTimeout(this.jobTimer);this.currentId=null;this.latestJob=null;this.resetPlayback();this.completeFiles?.clear();this.setData({result:null,busy:false,deviceActive:false,error:'',stage:'准备就绪'});this.initialize();}this.refreshStatus();this.startStatusPoll();if(this.currentId)this.pollJob(this.currentId);if(this.data.busy&&this.started)this.beginElapsed();}},
  onHide(){this.visible=false;clearTimeout(this.statusTimer);clearTimeout(this.jobTimer);clearInterval(this.elapsedTimer);this.jobPollEpoch=(this.jobPollEpoch||0)+1;this.resetPlayback();if(this.alive)this.setData({streamStatus:''});},
  onUnload(){this.alive=false;this.visible=false;clearTimeout(this.statusTimer);clearTimeout(this.jobTimer);clearInterval(this.elapsedTimer);this.resetPlayback();this.completeFiles?.clear();},
  applySettings(){const c=api.config();this.setData({baseUrl:c.baseUrl,clientToken:c.clientToken,deviceId:c.deviceId});},
  applyPreferences(){const values=preferences.get();const voices=this.data.voices||[],index=voices.findIndex(voice=>voice.id===values.selectedVoice);this.setData({...values,autoPlayParts:false,speedLabel:values.speed.toFixed(2)+'×',speedIndex:Math.max(0,SPEEDS.indexOf(values.speed)),voiceIndex:Math.max(0,index),voiceLabel:index>=0?voices[index].name:this.data.voiceLabel});},
  async initialize(){try{const voices=await api.request('/api/voices');if(!this.alive)return;this.setData({voices:voices.filter(v=>v.group==='中文')});this.applyPreferences();await this.refreshStatus();}catch(e){if(this.alive)this.setData({error:e.message,connected:false});}this.startStatusPoll();},
  startStatusPoll(){clearTimeout(this.statusTimer);if(!this.visible)return;this.statusTimer=setTimeout(async()=>{await this.refreshStatus();if(this.alive&&this.visible)this.startStatusPoll();},4000);},
  async refreshStatus(){try{const [status,devices]=await Promise.all([api.request('/api/status'),api.request('/api/devices')]);if(!this.alive)return;const device=devices.find(item=>item.id===this.data.deviceId)||{online:false,volume:70};this.setData({connected:true,modelState:status.engine.message,hardware:status.hardware.gpu_name||'CPU 模式',deviceOnline:!!device.online,deviceSimulated:!!device.simulated,deviceVolume:device.volume,loadBusy:['loading','warming'].includes(status.engine.state)});if(status.engine.error)this.setData({error:status.engine.error});}catch(e){if(this.alive)this.setData({connected:false,modelState:'连接中断',error:e.message});}},
  changeVoice(e){const index=Number(e.detail.value),voice=this.data.voices[index];if(!voice)return;preferences.save({selectedVoice:voice.id});this.setData({selectedVoice:voice.id,voiceLabel:voice.name,voiceIndex:index});},
  chooseSpeed(e){const index=Number(e.detail.value),speed=SPEEDS[index];if(speed==null)return;preferences.save({speed});this.setData({speed,speedLabel:speed.toFixed(2)+'×',speedIndex:index});},
  chooseTarget(e){const value=e.currentTarget.dataset.device,sendDevice=value===true||value==='true';preferences.save({sendDevice});this.setData({sendDevice});},
  goHistory(){wx.switchTab({url:'/pages/history/index'});},
  goDevice(){wx.switchTab({url:'/pages/device/index'});},
  inputText(e){this.setData({text:e.detail.value});},
  selectVoice(e){this.setData({selectedVoice:e.currentTarget.dataset.id});},
  selectDisplayMode(e){const id=e.currentTarget.dataset.id;if(MODES.some(mode=>mode.id===id))this.setData({displayMode:id});},
  changeSpeed(e){this.setData({speed:e.detail.value/100,speedLabel:(e.detail.value/100).toFixed(2)+'×'});},
  toggleDevice(e){this.setData({sendDevice:e.detail.value});},toggleCache(e){this.setData({useCache:e.detail.value});},
  example(e){const examples=['早上好！新的一天开始了，让我们一起出发，去遇见更多美好的事情。','重庆的银行行长介绍了新的业务流程。今天的温度是二十三点五摄氏度。'];this.setData({text:examples[e.currentTarget.dataset.index]});},
  async loadModel(){try{this.setData({loadBusy:true,error:''});await api.request('/api/model/load','POST');wx.showToast({title:'开始加载并预热',icon:'none'});}catch(e){this.setData({error:e.message,loadBusy:false});}},
  resetPlayback(){
    this.playEpoch=(this.playEpoch||0)+1;this.completionAuto=null;this.autoActive=false;
    for(const download of (this.partDownloads||new Map()).values())download.abort?.();
    if(this.manualDownload){this.manualDownload.abort?.();this.manualDownload=null;wx.hideLoading();}
    this.partFiles=new Map();this.partDownloads=new Map();const audio=this.audio;this.audio=null;audio?.stop();audio?.destroy?.();
    if(this.alive)this.setData({playing:false,phoneLoading:false});
  },
  async generate(){
    if(this.data.replayBusy)return;
    if(this.data.busy){this.stop();return;}
    if(!this.data.text.trim()){wx.showToast({title:'请输入文字',icon:'none'});return;}
    clearTimeout(this.jobTimer);clearInterval(this.elapsedTimer);this.currentId=null;this.latestJob=null;this.resetPlayback();
    const sendDevice=this.data.sendDevice,intent=this.completionAuto={phone:!sendDevice,jobId:null};
    this.started=Date.now();this.firstPlaybackMs=null;this.pollFailures=0;this.stopRequested=false;
    this.setData({busy:true,error:'',result:null,stage:'提交任务',browserFirstLabel:'—',streamStatus:'完整生成后自动播放'});this.beginElapsed();
    try{
      const job=await api.request('/api/jobs','POST',{text:this.data.text.trim(),voice:this.data.selectedVoice,language:'Chinese',speed:this.data.speed,use_cache:this.data.useCache,display_mode:this.data.displayMode||'buddy',device_id:sendDevice?this.data.deviceId:null,playback_mode:'complete'});
      if(!this.alive)return;
      if(this.completionAuto===intent)intent.jobId=job.id;
      this.currentId=job.id;this.applyJob(job);this.pollJob(job.id);
      if(this.stopRequested)await this.stop();
    }catch(e){clearInterval(this.elapsedTimer);this.resetPlayback();if(this.alive)this.setData({busy:false,error:e.message,stage:'提交失败'});}
  },
  beginElapsed(){clearInterval(this.elapsedTimer);this.elapsedTimer=setInterval(()=>{if(this.alive)this.setData({elapsed:secs((Date.now()-this.started)/1000)});},200);},
  applyJob(job){
    const previous=this.latestJob||this.data.result;
    const busy=!['completed','failed','cancelled'].includes(job.status);
    const result=Object.assign({},job,{voiceName:((this.data.voices||[]).find(voice=>voice.id===job.voice)||{}).name||job.voice,firstLabel:secs(job.first_audio_seconds),inferenceLabel:secs(job.inference_seconds),durationLabel:secs(job.duration),totalLabel:secs(job.total_seconds),rtfLabel:job.rtf==null?'—':job.rtf.toFixed(2),deliveryLabel:deliveryText(job),hasParts:job.parts.length>0,
      queuedLabel:secs(job.queued_seconds),deviceFirstLabel:secs(job.device_first_audio_seconds),deviceDownloadLabel:secs(job.device_download_seconds)});
    const update={busy,deviceActive:['pending','leased','waiting','buffering','playing'].includes(job.delivery),stage:job.stage||STATE[job.status],screenHint:screenLine(job),error:job.error||job.device_error||''};
    if(!previous||previous.id!==job.id)update.result=result;
    else{
      for(const key of Object.keys(result))if(key!=='parts'&&result[key]!==previous[key])update['result.'+key]=result[key];
      const prefix=previous.parts.length<=job.parts.length&&previous.parts.every((part,index)=>part.audio_url===job.parts[index].audio_url);
      if(!prefix)update['result.parts']=job.parts;
      else for(let index=previous.parts.length;index<job.parts.length;index++)update['result.parts['+index+']']=job.parts[index];
    }
    // Keep the complete snapshot for playback/query cursors; setData sends only
    // changes across WeChat's view bridge, including the opaque revision.
    this.latestJob=result;this.setData(update);
    if(['failed','cancelled'].includes(job.status))this.resetPlayback();
    else this.autoPlayCompleted(job);
    if(!busy){clearInterval(this.elapsedTimer);this.setData({elapsed:secs(job.total_seconds)});}
  },
  autoPlayCompleted(job){
    const intent=this.completionAuto;
    if(!intent||intent.jobId!==job.id||job.status!=='completed'||!job.audio_url)return;
    // Consume before downloading: delivery polling must never restart a replay.
    this.completionAuto=null;
    if(intent.phone&&this.alive&&this.visible)this.playFull(job);
  },
  pollJob(id){clearTimeout(this.jobTimer);if(!this.visible||this.currentId!==id)return;const epoch=this.jobPollEpoch=(this.jobPollEpoch||0)+1;this.jobTimer=setTimeout(async()=>{
    if(!this.alive||!this.visible||this.currentId!==id||epoch!==this.jobPollEpoch)return;
    const previous=this.latestJob||this.data.result,query=previous&&previous.id===id&&previous.revision?'?after_parts='+previous.parts.length+'&revision='+encodeURIComponent(previous.revision)+'&wait_ms=1000':'';
    try{const job=await api.request('/api/jobs/'+id+query);if(!this.alive||!this.visible||this.currentId!==id||epoch!==this.jobPollEpoch)return;const recovered=this.pollFailures>0;this.pollFailures=0;
      if(!job.revision||!previous||job.revision!==previous.revision||recovered)this.applyJob(job);
      if(!['completed','failed','cancelled'].includes(job.status)||['pending','leased','waiting','buffering','playing'].includes(job.delivery))this.pollJob(id);
    }catch(e){if(this.alive&&this.visible&&this.currentId===id&&epoch===this.jobPollEpoch){
      if(e.status===404){this.applyJob(Object.assign({},this.latestJob||this.data.result,{status:'failed',stage:'任务已丢失，请重新生成',parts:((this.latestJob||this.data.result)||{}).parts||[],error:'后端未找到该任务，可能已重启。请重新生成；不会自动重复提交。'}));return;}
      this.pollFailures=(this.pollFailures||0)+1;this.setData({error:e.message+'。正在自动重连，不会重复提交任务。'});this.pollJob(id);
    }}
  },this.pollFailures?Math.min(4000,500*Math.pow(2,Math.min(this.pollFailures,3))):((this.latestJob||this.data.result)&& (this.latestJob||this.data.result).revision?0:(this.data.busy?150:400)));},
  async stop(){this.resetPlayback();if(!this.currentId){if(this.data.busy){this.stopRequested=true;this.setData({stage:'收到提交结果后立即停止',streamStatus:''});}return;}const id=this.currentId;try{await api.request('/api/jobs/'+id+'/cancel','POST');if(!this.alive||this.currentId!==id)return;this.setData({stage:'正在停止当前任务',streamStatus:''});this.pollJob(id);}catch(e){if(this.alive&&this.currentId===id)this.setData({error:e.message});}},
  async play(){
    const job=this.latestJob||this.data.result;if(!job)return;
    if(job.status!=='completed'||!job.audio_url){wx.showToast({title:'请等待完整语音生成',icon:'none'});return;}
    return this.playFull(job);
  },
  stopPhonePlayback(){this.resetPlayback();if(this.alive)this.setData({streamStatus:'手机播放已停止'});},
  async playFull(job){
    if(!this.alive||!this.visible||job.status!=='completed'||!job.audio_url)return;
    this.resetPlayback();const epoch=this.playEpoch,key=(this.data.baseUrl||'')+'|'+job.audio_url;
    const files=this.completeFiles||(this.completeFiles=new Map());
    this.setData({phoneLoading:true,error:'',streamStatus:'准备播放完整语音'});
    try{
      let file=files.get(key);
      if(!file){
        wx.showLoading({title:'下载完整语音'});this.manualDownload=api.download(job.audio_url);file=await this.manualDownload;
        if(!this.alive||!this.visible||epoch!==this.playEpoch)return;
        files.set(key,file);if(files.size>5)files.delete(files.keys().next().value);
      }
      if(!this.alive||!this.visible||epoch!==this.playEpoch)return;
      const audio=this.audio=wx.createInnerAudioContext();
      const active=()=>this.alive&&this.visible&&epoch===this.playEpoch&&this.audio===audio;
      audio.onPlay(()=>{
        if(!active())return;
        this.setData({playing:true,phoneLoading:false,streamStatus:'正在播放完整语音'});
        if(this.firstPlaybackMs==null&&this.started){this.firstPlaybackMs=Date.now()-this.started;this.setData({browserFirstLabel:secs(this.firstPlaybackMs/1000)});}
      });
      audio.onEnded(()=>{if(active()){this.resetPlayback();this.setData({streamStatus:'播放完成，可点击重新播放'});}});
      audio.onError(error=>{
        if(!active())return;
        files.delete(key);this.resetPlayback();this.setData({error:'音频播放失败：'+(error.errMsg||'请重新播放'),streamStatus:'播放失败，请点击重新播放'});
      });
      audio.src=file;audio.play();
    }catch(error){
      if(this.alive&&this.visible&&epoch===this.playEpoch){files.delete(key);this.resetPlayback();this.setData({error:'音频加载失败：'+error.message,streamStatus:'播放失败，请点击重新播放'});}
    }finally{if(epoch===this.playEpoch){this.manualDownload=null;this.setData({phoneLoading:false});wx.hideLoading();}}
  },
  async replayDevice(){
    const source=this.latestJob||this.data.result;
    if(this.data.replayBusy||this.data.busy||this.data.deviceActive)return;
    if(!source||source.status!=='completed'||!source.audio_url){wx.showToast({title:'请先生成完整语音',icon:'none'});return;}
    this.setData({replayBusy:true,error:''});
    try{
      const job=await api.request('/api/jobs/'+source.id+'/replay','POST',{device_id:this.data.deviceId,display_mode:this.data.displayMode||'buddy'});
      if(!this.alive)return;
      clearTimeout(this.jobTimer);clearInterval(this.elapsedTimer);this.jobPollEpoch=(this.jobPollEpoch||0)+1;
      this.resetPlayback();this.currentId=job.id;this.started=0;this.firstPlaybackMs=null;this.pollFailures=0;
      this.setData({browserFirstLabel:'—',streamStatus:''});this.applyJob(job);this.pollJob(job.id);
      wx.showToast({title:'已发送到开发板',icon:'success'});
    }catch(error){if(this.alive)this.setData({error:error.message});}
    finally{if(this.alive)this.setData({replayBusy:false});}
  },
  async changeVolume(e){const volume=e.detail.value;this.setData({deviceVolume:volume});try{await api.request('/api/devices/'+this.data.deviceId+'/volume','POST',{volume});}catch(err){this.setData({error:err.message});}},
  async refreshHistory(){try{const history=await api.request('/api/jobs');if(this.alive)this.setData({history:history.slice(0,6).map(j=>Object.assign({},j,{voiceLabel:(this.data.voices.find(v=>v.id===j.voice)||{}).name||j.voice,statusLabel:STATE[j.status]||j.status,deliveryLabel:deliveryText(j)}))});}catch(_){}},
  async openHistory(e){if(this.data.busy){wx.showToast({title:'请先等待当前任务',icon:'none'});return;}try{const job=await api.request('/api/jobs/'+e.currentTarget.dataset.id);this.resetPlayback();this.started=0;this.firstPlaybackMs=null;this.setData({browserFirstLabel:'—',streamStatus:''});this.currentId=job.id;this.applyJob(job);this.pollJob(job.id);}catch(err){this.setData({error:err.message});}},
  showSettings(){this.setData({settingsOpen:true});},hideSettings(){this.setData({settingsOpen:false});},
  settingInput(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
  saveSettings(){const baseUrl=this.data.baseUrl.trim().replace(/\/$/,'');if(!/^https?:\/\/[^\s]+$/.test(baseUrl)){wx.showToast({title:'请输入有效的 http/https 地址',icon:'none'});return;}wx.setStorageSync('qwenConnection',{baseUrl,clientToken:this.data.clientToken.trim(),deviceId:this.data.deviceId.trim()});this.setData({baseUrl,settingsOpen:false,error:''});this.initialize();}
});
