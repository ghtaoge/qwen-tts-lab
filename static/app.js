'use strict';
const $ = id => document.getElementById(id);
let selectedVoice = 'Serena', voiceList = [], currentJob = null, pollHandle = null;
let timerHandle = null, jobStarted = 0, currentAudioUrl = '', autoActive = false, refreshBusy = false;
let browserFirstSeconds = null, lastHistoryRefresh = 0, pollFailures = 0, manualAudioSelection = false, submitting = false;
let pollEpoch = 0, renderedPartJob = null, renderedPartUrls = [];
let autoPlaybackJob = null;
const streamPlayer = new StreamAudioPlayer({
  fetchTimeoutMs: 30000,
  onFirstAudio(delay) {
    if (browserFirstSeconds == null && jobStarted) {
      browserFirstSeconds = (performance.now() - jobStarted) / 1000 + delay;
      $('metricBrowserFirst').textContent = secs(browserFirstSeconds);
    }
  },
  onState(state) {
    $('streamControls').hidden = false;
    $('streamState').textContent = state === 'waiting' ? (autoPlaybackJob ? '正在缓冲完整语音…' : '等待全部转换完成后自动播放') : state === 'playing' ? '正在播放完整语音' : '播放完成，可在播放器中再次播放';
    if (state === 'completed') {
      autoActive = false;
      if(currentJob?.audio_url && !manualAudioSelection)setAudio(currentJob.audio_url);
    }
  },
  onError(error) {
    autoActive = false;
    $('streamState').textContent = '自动试听已停止';
    if(currentJob?.status==='completed' && !manualAudioSelection)setAudio(currentJob.audio_url);
    toast('自动播放未能开始：' + error.message + '。转换完成后可点击播放器试听。');
  }
});
const labels = { queued:'排队中', loading:'加载模型', synthesizing:'合成中', completed:'已完成', failed:'失败', cancelled:'已停止' };
const deliveryLabels = {pending:'等待设备领取',leased:'设备已领取',waiting:'设备等待音频',buffering:'设备正在缓冲',playing:'设备正在播放',delivered:'设备播放完成',error:'设备播放失败',cancelled:'设备已停止',expired:'任务已过期，请重新发送'};
function deliveryText(job){return job.delivery?(job.device_delivery_simulated?'模拟 · ':'')+(deliveryLabels[job.delivery]||job.delivery):'';}
async function api(path, options = {}) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response = await fetch(path, {...options, signal:options.signal||controller.signal, headers:{'Content-Type':'application/json',...options.headers}});
    let data;
    try { data = await response.json(); } catch(error) { if(error.name==='AbortError')throw error;throw new Error(`服务返回异常（${response.status}）`); }
    if (!response.ok) {
      const detail = Array.isArray(data.detail) ? data.detail.map(v => v.msg).join('；') : data.detail;
      const error=new Error(detail || `请求失败（${response.status}）`);error.status=response.status;throw error;
    }
    return data;
  } catch(error) { if(error.name==='AbortError')throw new Error('请求超时，请检查本地服务连接');throw error; }
  finally {clearTimeout(timer);}
}
function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('toast').hidden=true,4500); }
function showError(message) { $('errorBox').textContent=message || ''; $('errorBox').hidden=!message; }
function voiceName(id) { return voiceList.find(v=>v.id===id)?.name || id; }
function chooseVoice(id) {
  selectedVoice=id;
  document.querySelectorAll('.voice-card').forEach(el=>el.setAttribute('aria-checked',String(el.dataset.voice===id)));
  $('moreVoice').value=voiceList.find(v=>v.id===id)?.group==='其他' ? id : '';
}
function renderVoices(list) {
  voiceList=list;
  $('voiceGrid').replaceChildren();
  list.filter(v=>v.group==='中文').forEach((voice,index)=>{
    const button=document.createElement('button'); button.className='voice-card'; button.dataset.voice=voice.id;
    button.type='button'; button.setAttribute('role','radio'); button.setAttribute('aria-label',voice.name+'，'+voice.description);
    const avatar=document.createElement('span'); avatar.className='voice-avatar'; avatar.textContent=['V','S','F','D','E'][index];
    const name=document.createElement('span'); name.className='voice-name'; name.textContent=voice.name;
    const desc=document.createElement('span'); desc.className='voice-desc'; desc.textContent=voice.description;
    button.append(avatar,name,desc); button.onclick=()=>chooseVoice(voice.id); $('voiceGrid').append(button);
  });
  list.filter(v=>v.group==='其他').forEach(v=>{const option=document.createElement('option'); option.value=v.id; option.textContent=v.name+' · '+v.description; $('moreVoice').append(option);});
  chooseVoice(selectedVoice);
}
function secs(value) { return value==null ? '—' : `${Number(value).toFixed(2)} s`; }
async function refreshStatus() {
  if (refreshBusy) return;
  refreshBusy=true;
  try {
    const status=await api('/api/status'), hardware=status.hardware, state=status.engine;
    $('runtimeLabel').textContent=state.state==='ready'?'模型已就绪':state.state==='error'?'需要检查环境':state.state==='loading'?'正在加载模型':state.state==='warming'?'正在预热模型':'本地服务已连接';
    $('statusDot').className='dot '+(['loading','warming'].includes(state.state)?'loading':state.state==='ready'?'green':state.state==='error'?'error':'');
    $('gpuName').textContent=hardware.gpu_name || (hardware.error?'环境尚未就绪':'CPU 推理模式');
    $('hardwareDetail').textContent=hardware.error || `${hardware.gpu_memory_mb ? (hardware.gpu_memory_mb/1024).toFixed(1)+' GB VRAM · ' : ''}Python ${hardware.python} · PyTorch ${hardware.torch}`;
    $('engineDetail').textContent=state.error || (!status.model_downloaded?'尚未下载模型，请先运行 download-model.ps1。':state.device ? `${state.device} · ${state.precision} · ${state.message}` : '模型按需加载，首次生成包含加载时间。');
    $('loadModel').disabled=['loading','warming'].includes(state.state) || status.active_jobs>0;
    const devices=await api('/api/devices'), device=devices[0];
    $('deviceStatus').textContent=device.online?`${device.id} · ${device.simulated?'模拟接收器在线':'在线'}`:`${device.id} · 离线`;
    $('deviceStatus').className='device-status '+(device.online?'online':'');
    $('sendDevice').dataset.device=device.id;
  } catch(error) { $('runtimeLabel').textContent='服务连接中断'; $('statusDot').className='dot error'; $('engineDetail').textContent=error.message; }
  finally { refreshBusy=false; }
}
async function drawWave(url) {
  const canvas=$('waveform'), ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if (!url) {ctx.strokeStyle='#e9e5f4';ctx.beginPath();ctx.moveTo(0,48);ctx.lineTo(720,48);ctx.stroke();return;}
  try {
    const response=await fetch(url); if(!response.ok) return;
    const data=await response.arrayBuffer(), context=new (window.AudioContext||window.webkitAudioContext)();
    let audio; try { audio=await context.decodeAudioData(data); } finally { await context.close(); }
    if (currentAudioUrl!==url) return;
    const samples=audio.getChannelData(0), bars=120, width=canvas.width/bars;
    ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#a395d7';
    for(let i=0;i<bars;i++){const from=Math.floor(i*samples.length/bars),to=Math.floor((i+1)*samples.length/bars);let peak=0;for(let j=from;j<to;j++)peak=Math.max(peak,Math.abs(samples[j]));const height=Math.max(2,peak*82);ctx.fillRect(i*width+1,(canvas.height-height)/2,width-3,height);}
  } catch { /* Native audio controls remain usable if Web Audio cannot decode. */ }
}
function setAudio(url, play=false) {
  if (!url) return;
  if (currentAudioUrl!==url) {currentAudioUrl=url;$('player').src=url;drawWave(url);}
  if (play) {
    try { $('player').currentTime=0; } catch { /* Metadata may still be loading. */ }
    $('player').play().catch(()=>toast('浏览器阻止了自动播放，请点击播放器开始试听。'));
  }
}
function stopAuto() {
  autoActive=false;streamPlayer.stop();$('streamControls').hidden=true;
}
function playCompletedJob(job) {
  if(!autoActive || !job || job.status!=='completed' || !job.audio_url || manualAudioSelection || document.hidden || autoPlaybackJob===job.id)return;
  autoPlaybackJob=job.id;
  $('streamState').textContent='正在缓冲完整语音…';
  // Feed one merged file only. Playback starts after the entire WAV is downloaded
  // and decoded, so inference speed and sentence boundaries cannot interrupt it.
  streamPlayer.update([{index:1,audio_url:job.audio_url,duration:job.duration}],true);
}
function armAuto(job=currentJob) {
  stopAuto();autoPlaybackJob=null;
  if(document.hidden)return;
  autoActive=true;
  $('streamControls').hidden=false;$('streamState').textContent='等待全部转换完成后自动播放';
  // Unlock Web Audio inside the user gesture, without waiting for synthesis.
  streamPlayer.start();playCompletedJob(job);
}
function renderParts(job){
  const target=$('parts'),parts=job.parts||[];
  const samePrefix=renderedPartJob===job.id && renderedPartUrls.length<=parts.length && renderedPartUrls.every((url,index)=>parts[index].audio_url===url);
  if(!samePrefix){target.replaceChildren();renderedPartUrls=[];renderedPartJob=job.id;}
  for(let index=renderedPartUrls.length;index<parts.length;index++){
    const part=parts[index],button=document.createElement('button');button.className='part-button';button.textContent=`▶ 第 ${part.index} 段 · ${part.duration.toFixed(1)}s`;button.title=part.text;
    button.onclick=()=>{stopAuto();manualAudioSelection=true;setAudio(part.audio_url,true);};target.append(button);renderedPartUrls.push(part.audio_url);
  }
}
$('player').addEventListener('play',()=>{stopAuto();manualAudioSelection=true;if(browserFirstSeconds==null&&jobStarted){browserFirstSeconds=(performance.now()-jobStarted)/1000;$('metricBrowserFirst').textContent=secs(browserFirstSeconds);}});
$('stopStream').onclick=stopAuto;
$('autoPlay').addEventListener('change',()=>{
  if(!$('autoPlay').checked){stopAuto();return;}
  if(currentJob && !['failed','cancelled'].includes(currentJob.status)) {
    $('player').pause();manualAudioSelection=false;armAuto();
  }
});
function pauseForBackground(){stopAuto();$('player').pause();}
document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseForBackground();});
if(typeof window!=='undefined')window.addEventListener('pagehide',pauseForBackground);
function renderJob(job) {
  currentJob=job;
  const running=!['completed','failed','cancelled'].includes(job.status);
  $('generate').innerHTML=running?'<span>■</span> 停止生成':'<span>✦</span> 生成语音 <span class="shortcut">Ctrl ↵</span>';
  $('outputBadge').textContent=job.cache_hit?'缓存命中':labels[job.status]||job.status;
  $('visualCaption').textContent=job.stage;
  document.querySelector('.voice-visual').classList.toggle('busy',running);
  $('metricFirst').textContent=secs(job.playback_ready_seconds ?? job.first_audio_seconds);
  $('metricBrowserFirst').textContent=secs(browserFirstSeconds);
  $('metricDeviceFirst').textContent=secs(job.device_first_audio_seconds);
  $('metricTiming').textContent=`排队：${secs(job.queued_seconds)} · ${job.device_delivery_simulated?'模拟接收器':'ESP32'} 音频下载：${secs(job.device_download_seconds)}`;
  $('metricInference').textContent=secs(job.inference_seconds);
  $('metricDuration').textContent=secs(job.duration);
  $('metricRtf').textContent=job.rtf==null?'—':Number(job.rtf).toFixed(2);
  $('metricMemory').textContent='峰值显存：'+(job.peak_vram_mb==null?'—':`${job.peak_vram_mb} MB`);
  $('metricFormat').textContent=job.sample_rate?`${job.sample_rate/1000} kHz · PCM16`:'PCM WAV';
  renderParts(job.status==='completed'?job:{...job,parts:[]});
  if(autoActive) {
    if(['failed','cancelled'].includes(job.status))stopAuto();
    else playCompletedJob(job);
  }
  if(job.status==='completed') {
    if(!manualAudioSelection) setAudio(job.audio_url);
    $('download').href=job.audio_url;$('download').download=`${job.voice}-${job.id.slice(0,8)}.wav`;
    $('download').classList.remove('disabled');$('download').setAttribute('aria-disabled','false');
    $('outputNote').textContent=job.cache_hit?'本次直接复用已有音频，耗时不代表模型推理性能。':`合计 ${secs(job.total_seconds)}（含本次加载与后处理）；${job.engine_device||''} ${job.precision||''}。`;
    if(job.delivery)$('outputNote').textContent+=' '+deliveryText(job)+(job.device_error?'：'+job.device_error:'');
  } else {$('outputNote').textContent=running?(autoActive?'正在转换，全部完成并缓冲完整语音后自动播放。':'正在转换，全部完成后可点击播放器试听。'):job.status==='cancelled'?'任务已停止，重新生成后可播放完整语音。':'本次未生成完整音频。';}
  showError(job.error);
  if(!running){clearInterval(timerHandle);$('timer').textContent=secs(job.total_seconds);}
}
async function pollJob(id) {
  if(currentJob?.id!==id)return;
  const epoch=++pollEpoch,previous=currentJob;
  const query=previous.revision?`?after_parts=${previous.parts.length}&revision=${encodeURIComponent(previous.revision)}&wait_ms=1000`:'';
  try {
    const job=await api('/api/jobs/'+id+query);
    if(currentJob?.id!==id || epoch!==pollEpoch) return;
    const recovered=pollFailures>0;
    pollFailures=0;
    if(!job.revision || job.revision!==previous.revision || recovered)renderJob(job);
    else currentJob=job;
    if(!['completed','failed','cancelled'].includes(job.status) || ['pending','leased','waiting','buffering','playing'].includes(job.delivery)) pollHandle=setTimeout(()=>pollJob(id),job.revision?0:(['completed','failed','cancelled'].includes(job.status)?400:150));
    if(['completed','failed','cancelled'].includes(job.status) && performance.now()-lastHistoryRefresh>2500){lastHistoryRefresh=performance.now();refreshHistory();}
  } catch(error){
    if(currentJob?.id!==id || epoch!==pollEpoch)return;
    if(error.status===404){renderJob({...currentJob,status:'failed',stage:'任务已丢失，请重新生成',error:'后端未找到该任务，可能已重启。请重新生成；不会自动重复提交。'});return;}
    pollFailures++;
    showError('任务查询失败：'+error.message+'。正在自动重连，不会重复提交任务。');
    $('outputBadge').textContent='连接中断';
    pollHandle=setTimeout(()=>pollJob(id),Math.min(4000,500*2**Math.min(pollFailures,3)));
    $('generate').disabled=false;
  }
}
async function submit() {
  if(submitting)return;
  if(currentJob && !['completed','failed','cancelled'].includes(currentJob.status)) {
    $('player').pause();stopAuto();
    try{await api(`/api/jobs/${currentJob.id}/cancel`,{method:'POST'});toast('已请求停止，等待当前计算结束。');}catch(e){showError('本地试听已停止，但未能通知后端：'+e.message);}return;
  }
  const text=$('text').value.trim();if(!text){showError('请先输入要朗读的文字。');$('text').focus();return;}
  submitting=true;showError('');$('generate').disabled=true;clearTimeout(pollHandle);clearInterval(timerHandle);
  stopAuto();$('player').pause();currentJob=null;browserFirstSeconds=null;manualAudioSelection=false;pollFailures=0;jobStarted=performance.now();
  $('player').removeAttribute?.('src');$('player').load?.();currentAudioUrl='';renderParts({id:null,parts:[]});
  const wantsAuto=$('autoPlay').checked;
  if(wantsAuto)armAuto();
  try {
    const job=await api('/api/jobs',{method:'POST',body:JSON.stringify({text,voice:selectedVoice,language:$('language').value,speed:Number($('speed').value),use_cache:$('useCache').checked,playback_mode:'complete',display_mode:displayMode(),device_id:$('sendDevice').checked?($('sendDevice').dataset.device||'esp32_01'):null})});
    $('player').pause();$('player').removeAttribute('src');$('player').load();currentAudioUrl='';drawWave(null);
    $('download').removeAttribute('href');$('download').classList.add('disabled');$('download').setAttribute('aria-disabled','true');
    timerHandle=setInterval(()=>$('timer').textContent=secs((performance.now()-jobStarted)/1000),100);
    renderJob(job);pollJob(job.id);refreshStatus();
  } catch(error){stopAuto();showError(error.message);}finally{submitting=false;$('generate').disabled=false;}
}
async function refreshHistory() {
  try {
    const list=await api('/api/jobs');$('historyCount').textContent=list.length;
    const target=$('historyList');target.replaceChildren();
    if(!list.length){const empty=document.createElement('div');empty.className='history-empty';empty.textContent='还没有作品，试着生成第一段声音。';target.append(empty);}
    list.slice(0,8).forEach(job=>{
      const row=document.createElement('button');row.className='history-item';
      const icon=document.createElement('span');icon.className='history-icon';icon.textContent=job.status==='completed'?'▷':'◷';
      const body=document.createElement('div');body.className='history-body';const text=document.createElement('div');text.className='history-text';text.textContent=job.text;
      const meta=document.createElement('div');meta.className='history-meta';meta.textContent=`${voiceName(job.voice)} · ${job.speed.toFixed(2)}× · ${labels[job.status]||job.status}${job.cache_hit?' · 缓存':''}${job.delivery?' · '+deliveryText(job):''}`;
      body.append(text,meta);const time=document.createElement('span');time.className='history-time';time.textContent=new Date(job.created_at*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});row.append(icon,body,time);
      row.onclick=()=>{
        if(submitting){toast('正在提交任务，请稍候。');return;}
        if(currentJob&&!['completed','failed','cancelled'].includes(currentJob.status)&&currentJob.id!==job.id){toast('请先等待或停止当前任务。');return;}
        const selected=currentJob?.id===job.id?currentJob:job;
        clearTimeout(pollHandle);clearInterval(timerHandle);stopAuto();browserFirstSeconds=null;manualAudioSelection=false;pollFailures=0;jobStarted=0;$('text').value=selected.text;updateCount();chooseVoice(selected.voice);$('speed').value=selected.speed;updateSpeed();$('language').value=selected.language;$('displayMode').value=selected.display_mode||'buddy';updateDisplayMode();renderJob(selected);
        if(selected.status==='completed' && selected.audio_url)setAudio(selected.audio_url,true);pollJob(selected.id);window.scrollTo({top:0,behavior:'smooth'});
      };target.append(row);
    });
  }catch(error){console.warn(error);}
}
function updateCount(){$('charCount').textContent=$('text').value.length;}
function updateSpeed(){$('speedValue').textContent=Number($('speed').value).toFixed(2)+'×';}
function displayMode(){const value=$('displayMode').value;return ['buddy','wave','text'].includes(value)?value:'buddy';}
function updateDisplayMode(){$('oledPreviewLink').href='/oled-preview.html?mode='+displayMode();}
$('displayMode').addEventListener('change',updateDisplayMode);
$('text').addEventListener('input',updateCount);$('speed').addEventListener('input',updateSpeed);
$('volume').addEventListener('input',()=>{$('volumeValue').textContent=$('volume').value+'%';$('player').volume=Number($('volume').value)/100;streamPlayer.setVolume(Number($('volume').value)/100);});$('player').volume=.8;
$('moreVoice').addEventListener('change',()=>{if($('moreVoice').value)chooseVoice($('moreVoice').value);});
document.querySelectorAll('[data-example]').forEach(el=>el.onclick=()=>{$('text').value=el.dataset.example;updateCount();});
$('generate').onclick=submit;
$('loadModel').onclick=async()=>{try{$('loadModel').disabled=true;await api('/api/model/load',{method:'POST'});toast('开始加载并预热，可在左侧查看状态。');refreshStatus();}catch(error){showError(error.message);$('loadModel').disabled=false;}};
$('refreshHistory').onclick=refreshHistory;$('historyNav').onclick=()=>$('historySection').scrollIntoView({behavior:'smooth'});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();submit();}});
updateCount();drawWave(null);
api('/api/voices').then(renderVoices).catch(error=>showError(error.message));
refreshStatus();refreshHistory();setInterval(refreshStatus,4000);
