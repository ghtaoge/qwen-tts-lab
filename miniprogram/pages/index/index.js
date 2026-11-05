const api=require('../../lib/api');
const STATE={queued:'等待推理',loading:'加载模型',synthesizing:'生成中',completed:'生成完成',failed:'失败',cancelled:'已停止'};
const DELIVERY={pending:'等待开发板领取',leased:'开发板已领取',waiting:'开发板等待音频',buffering:'开发板正在缓冲',playing:'开发板播放中',delivered:'开发板播放完成',error:'开发板播放失败',cancelled:'设备播放已停止',expired:'设备任务已过期'};
const deliveryText=job=>job.delivery?(job.device_delivery_simulated?'模拟 · ':'')+(DELIVERY[job.delivery]||job.delivery):'';
const secs=value=>value==null?'—':Number(value).toFixed(2)+' s';
Page({
  data:{text:'你好，欢迎来到我的语音实验室。今天也要保持好心情，去发现生活里的小美好。',voices:[],selectedVoice:'Serena',speed:1,speedLabel:'1.00×',deviceVolume:70,
    sendDevice:true,useCache:true,autoPlayParts:false,busy:false,stage:'准备就绪',modelState:'连接中',hardware:'',deviceOnline:false,deviceSimulated:false,error:'',result:null,history:[],playing:false,
    streamStatus:'',browserFirstLabel:'—',settingsOpen:false,baseUrl:'',clientToken:'',deviceId:'esp32_01',elapsed:'—',loadBusy:false,connected:false},
  onLoad(){
    this.alive=true;this.visible=true;this.playEpoch=0;this.partFiles=new Map();this.partDownloads=new Map();this.nextPart=0;
    this.audio=wx.createInnerAudioContext();
    this.audio.onPlay(()=>{
      if(!this.alive)return;
      this.setData({playing:true});
      if(this.firstPlaybackMs==null&&this.started){this.firstPlaybackMs=Date.now()-this.started;this.setData({browserFirstLabel:secs(this.firstPlaybackMs/1000)});}
    });
    this.audio.onEnded(()=>{
      if(!this.alive)return;
      this.clipPlaying=false;this.setData({playing:false});
      if(this.autoActive)this.pumpParts();
    });
    this.audio.onError(e=>{if(this.alive){this.autoActive=false;this.clipPlaying=false;this.setData({error:'音频播放失败：'+e.errMsg,playing:false,streamStatus:'自动试听已停止'});}});
    this.applySettings();this.initialize();
  },
  onShow(){if(this.alive){this.visible=true;this.startStatusPoll();if(this.currentId)this.pollJob(this.currentId);if(this.data.busy&&this.started)this.beginElapsed();}},
  onHide(){this.visible=false;clearTimeout(this.statusTimer);clearTimeout(this.jobTimer);clearInterval(this.elapsedTimer);this.resetPlayback();if(this.alive)this.setData({autoPlayParts:false,streamStatus:'页面已隐藏，自动试听已暂停'});},
  onUnload(){this.alive=false;this.visible=false;clearTimeout(this.statusTimer);clearTimeout(this.jobTimer);clearInterval(this.elapsedTimer);this.resetPlayback();this.audio.destroy();},
  applySettings(){const c=api.config();this.setData({baseUrl:c.baseUrl,clientToken:c.clientToken,deviceId:c.deviceId});},
  async initialize(){try{const voices=await api.request('/api/voices');if(!this.alive)return;this.setData({voices:voices.filter(v=>v.group==='中文')});await this.refreshStatus();this.refreshHistory();}catch(e){if(this.alive)this.setData({error:e.message,connected:false});}this.startStatusPoll();},
  startStatusPoll(){clearTimeout(this.statusTimer);if(!this.visible)return;this.statusTimer=setTimeout(async()=>{await this.refreshStatus();if(this.alive&&this.visible)this.startStatusPoll();},4000);},
  async refreshStatus(){try{const [status,devices]=await Promise.all([api.request('/api/status'),api.request('/api/devices')]);if(!this.alive)return;const device=devices[0];this.setData({connected:true,modelState:status.engine.message,hardware:status.hardware.gpu_name||'CPU 模式',deviceOnline:device.online,deviceSimulated:!!device.simulated,deviceVolume:device.volume,loadBusy:['loading','warming'].includes(status.engine.state)});if(status.engine.error)this.setData({error:status.engine.error});}catch(e){if(this.alive)this.setData({connected:false,modelState:'连接中断',error:e.message});}},
  inputText(e){this.setData({text:e.detail.value});},
  selectVoice(e){this.setData({selectedVoice:e.currentTarget.dataset.id});},
  changeSpeed(e){this.setData({speed:e.detail.value/100,speedLabel:(e.detail.value/100).toFixed(2)+'×'});},
  toggleDevice(e){this.setData({sendDevice:e.detail.value});},toggleCache(e){this.setData({useCache:e.detail.value});},
  toggleAutoPlay(e){
    const enabled=e.detail.value;this.resetPlayback();this.setData({autoPlayParts:enabled,streamStatus:enabled?'首包就绪后自动连续试听':''});
    const job=this.latestJob||this.data.result;
    if(enabled&&job&&!['failed','cancelled'].includes(job.status)){this.autoActive=true;this.prefetchParts();}
  },
  example(e){const examples=['早上好！新的一天开始了，让我们一起出发，去遇见更多美好的事情。','重庆的银行行长介绍了新的业务流程。今天的温度是二十三点五摄氏度。'];this.setData({text:examples[e.currentTarget.dataset.index]});},
  async loadModel(){try{this.setData({loadBusy:true,error:''});await api.request('/api/model/load','POST');wx.showToast({title:'开始加载并预热',icon:'none'});}catch(e){this.setData({error:e.message,loadBusy:false});}},
  resetPlayback(){
    this.playEpoch=(this.playEpoch||0)+1;this.autoActive=false;this.clipPlaying=false;this.nextPart=0;
    for(const download of (this.partDownloads||new Map()).values())download.abort?.();
    if(this.manualDownload){this.manualDownload.abort?.();this.manualDownload=null;wx.hideLoading();}
    this.partFiles=new Map();this.partDownloads=new Map();this.audio.stop();
    if(this.alive)this.setData({playing:false});
  },
  async generate(){
    if(this.data.busy){this.stop();return;}
    if(!this.data.text.trim()){wx.showToast({title:'请输入文字',icon:'none'});return;}
    clearTimeout(this.jobTimer);clearInterval(this.elapsedTimer);this.currentId=null;this.latestJob=null;this.resetPlayback();
    this.started=Date.now();this.firstPlaybackMs=null;this.pollFailures=0;this.stopRequested=false;this.autoActive=this.data.autoPlayParts;
    this.setData({busy:true,error:'',result:null,stage:'提交任务',browserFirstLabel:'—',streamStatus:this.autoActive?'等待语音首包':''});this.beginElapsed();
    try{
      const job=await api.request('/api/jobs','POST',{text:this.data.text.trim(),voice:this.data.selectedVoice,language:'Chinese',speed:this.data.speed,use_cache:this.data.useCache,device_id:this.data.sendDevice?this.data.deviceId:null});
      if(!this.alive)return;
      this.currentId=job.id;this.applyJob(job);this.pollJob(job.id);
      if(this.stopRequested)await this.stop();
    }catch(e){clearInterval(this.elapsedTimer);this.resetPlayback();if(this.alive)this.setData({busy:false,error:e.message,stage:'提交失败'});}
  },
  beginElapsed(){clearInterval(this.elapsedTimer);this.elapsedTimer=setInterval(()=>{if(this.alive)this.setData({elapsed:secs((Date.now()-this.started)/1000)});},200);},
  applyJob(job){
    const previous=this.latestJob||this.data.result;
    const busy=!['completed','failed','cancelled'].includes(job.status);
    const result=Object.assign({},job,{firstLabel:secs(job.first_audio_seconds),inferenceLabel:secs(job.inference_seconds),durationLabel:secs(job.duration),totalLabel:secs(job.total_seconds),rtfLabel:job.rtf==null?'—':job.rtf.toFixed(2),deliveryLabel:deliveryText(job),hasParts:job.parts.length>0,
      queuedLabel:secs(job.queued_seconds),deviceFirstLabel:secs(job.device_first_audio_seconds),deviceDownloadLabel:secs(job.device_download_seconds)});
    const update={busy,stage:job.stage||STATE[job.status],error:job.error||job.device_error||''};
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
    else if(this.autoActive)this.prefetchParts();
    if(!busy){clearInterval(this.elapsedTimer);this.setData({elapsed:secs(job.total_seconds)});if(Date.now()-(this.lastHistoryRefresh||0)>2500){this.lastHistoryRefresh=Date.now();this.refreshHistory();}}
  },
  prefetchParts(){
    const job=this.latestJob||this.data.result;
    if(!this.autoActive||!this.visible||!job)return;
    const epoch=this.playEpoch;
    // Keep two future clips downloaded before their turn.
    const end=Math.min(job.parts.length,this.nextPart+3);
    for(let index=this.nextPart;index<end;index++){
      const part=job.parts[index],url=part.audio_url;
      if(this.partFiles.has(url)||this.partDownloads.has(url))continue;
      const download=api.download(url);this.partDownloads.set(url,download);
      download.then(file=>{
        if(epoch!==this.playEpoch||!this.alive)return;
        this.partFiles.set(url,file);this.partDownloads.delete(url);this.pumpParts();
      }).catch(error=>{
        if(epoch!==this.playEpoch||!this.alive)return;
        this.resetPlayback();this.setData({error:'分段音频下载失败：'+error.message,streamStatus:'自动试听已停止'});
      });
    }
    this.pumpParts();
  },
  pumpParts(){
    const job=this.latestJob||this.data.result;
    if(!this.autoActive||!this.visible||this.clipPlaying||!job)return;
    const part=job.parts[this.nextPart];
    if(!part){
      if(job.status==='completed'){this.autoActive=false;this.setData({streamStatus:'连续试听已完成'});}
      else this.setData({streamStatus:'等待下一段音频，已就绪即播放'});
      return;
    }
    const file=this.partFiles.get(part.audio_url);
    if(!file)return;
    this.nextPart++;this.clipPlaying=true;
    this.setData({streamStatus:'连续试听 · 第 '+part.index+' 段'});
    this.audio.src=file;this.audio.play();this.prefetchParts();
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
  async play(e){
    const job=this.latestJob||this.data.result;if(!job)return;
    if(this.data.playing||this.autoActive){this.resetPlayback();this.setData({streamStatus:'试听已停止'});return;}
    const first=e.currentTarget.dataset.first,url=first&&job.parts.length?job.parts[0].audio_url:job.audio_url;
    if(!url)return;
    this.resetPlayback();const epoch=this.playEpoch;
    try{wx.showLoading({title:'下载音频'});this.manualDownload=api.download(url);const file=await this.manualDownload;if(!this.alive||epoch!==this.playEpoch)return;this.audio.src=file;this.audio.play();}catch(err){if(this.alive&&epoch===this.playEpoch)this.setData({error:err.message});}finally{if(epoch===this.playEpoch){this.manualDownload=null;wx.hideLoading();}}
  },
  async changeVolume(e){const volume=e.detail.value;this.setData({deviceVolume:volume});try{await api.request('/api/devices/'+this.data.deviceId+'/volume','POST',{volume});}catch(err){this.setData({error:err.message});}},
  async refreshHistory(){try{const history=await api.request('/api/jobs');if(this.alive)this.setData({history:history.slice(0,6).map(j=>Object.assign({},j,{voiceLabel:(this.data.voices.find(v=>v.id===j.voice)||{}).name||j.voice,statusLabel:STATE[j.status]||j.status,deliveryLabel:deliveryText(j)}))});}catch(_){}},
  async openHistory(e){if(this.data.busy){wx.showToast({title:'请先等待当前任务',icon:'none'});return;}try{const job=await api.request('/api/jobs/'+e.currentTarget.dataset.id);this.resetPlayback();this.started=0;this.firstPlaybackMs=null;this.setData({browserFirstLabel:'—',streamStatus:''});this.currentId=job.id;this.applyJob(job);this.pollJob(job.id);}catch(err){this.setData({error:err.message});}},
  showSettings(){this.setData({settingsOpen:true});},hideSettings(){this.setData({settingsOpen:false});},
  settingInput(e){this.setData({[e.currentTarget.dataset.key]:e.detail.value});},
  saveSettings(){const baseUrl=this.data.baseUrl.trim().replace(/\/$/,'');if(!/^https?:\/\/[^\s]+$/.test(baseUrl)){wx.showToast({title:'请输入有效的 http/https 地址',icon:'none'});return;}wx.setStorageSync('qwenConnection',{baseUrl,clientToken:this.data.clientToken.trim(),deviceId:this.data.deviceId.trim()});this.setData({baseUrl,settingsOpen:false,error:''});this.initialize();}
});
