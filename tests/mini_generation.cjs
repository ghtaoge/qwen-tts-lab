const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function sandbox(api){
  let definition;const saves=[],routes=[],toasts=[],contexts=[];
  const values={selectedVoice:'Serena',speed:1,displayMode:'wave',useCache:false,autoPlayParts:false,sendDevice:true};
  const preferences={get:()=>({...values}),save(patch){Object.assign(values,patch);saves.push(patch);return {...values};}};
  const wx={showLoading(){},hideLoading(){},showToast(value){toasts.push(value);},switchTab(value){routes.push(value.url);},
    createInnerAudioContext(){
      const handlers={},audio={plays:0,stops:0,destroyed:false,
        onPlay(fn){handlers.play=fn;},onEnded(fn){handlers.ended=fn;},onError(fn){handlers.error=fn;},
        play(){this.plays++;handlers.play?.();},stop(){this.stops++;},destroy(){this.destroyed=true;},
        end(){handlers.ended?.();},fail(message='bad audio'){handlers.error?.({errMsg:message});}};
      contexts.push(audio);return audio;
    }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../miniprogram/pages/index/index.js'),'utf8'),{
    require:name=>name.includes('preferences')?preferences:api,Page:value=>definition=value,wx,Date,Map,
    setTimeout(){},clearTimeout(){},setInterval(){},clearInterval(){}
  });
  const page=Object.assign({},definition,{alive:true,visible:true,playEpoch:0,partFiles:new Map(),partDownloads:new Map(),completeFiles:new Map(),
    data:JSON.parse(JSON.stringify(definition.data)),audio:null,
    setData(patch){for(const [name,value] of Object.entries(patch)){
      const keys=name.replace(/\[(\d+)\]/g,'.$1').split('.');let target=this.data;
      for(let i=0;i<keys.length-1;i++)target=target[keys[i]]||(target[keys[i]]=isNaN(Number(keys[i+1]))?{}:[]);
      target[keys.at(-1)]=value;
    }},pollJob(id){this.lastPolled=id;}
  });
  return {page,saves,routes,toasts,contexts,values};
}
const generated={id:'original',text:'你好',voice:'Serena',status:'completed',audio_url:'/api/audio/original.wav',
  parts:[{index:1,audio_url:'/api/audio/original_p1.wav'}],duration:2,delivery:'error',device_error:'旧错误',cache_hit:false};

async function replayUsesExistingJobAndGuardsDoubleTaps(){
  const pending=deferred(),requests=[];
  const {page}=sandbox({request(url,method,body){requests.push({url,method,body});return pending.promise;}});
  page.applyPreferences();page.data.deviceId='esp32_01';page.applyJob(generated);
  const first=page.replayDevice();await page.replayDevice();
  assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/jobs/original/replay');
  assert.equal(requests[0].body.display_mode,'wave');assert.equal(requests[0].body.device_id,'esp32_01');
  assert.equal(page.data.replayBusy,true);assert.equal(page.data.error,'');
  pending.resolve({...generated,id:'replayed',replay_of:'original',delivery:'pending',device_error:undefined,cache_hit:true});
  await first;
  assert.equal(page.currentId,'replayed');assert.equal(page.lastPolled,'replayed');
  assert.equal(page.data.deviceActive,true);assert.equal(page.data.replayBusy,false);assert.equal(page.data.error,'');
  assert.equal(generated.delivery,'error','replay must not mutate the source snapshot');
}

async function replayFailureAndUnavailableAudioRemainRecoverable(){
  let calls=0;const {page}=sandbox({request:async()=>{calls++;throw new Error('音频已不存在');}});
  page.applyJob(generated);await page.replayDevice();
  assert.match(page.data.error,/已不存在/);assert.equal(page.data.replayBusy,false);
  page.latestJob={...generated,status:'synthesizing',audio_url:null};await page.replayDevice();assert.equal(calls,1);
  page.latestJob=generated;page.data.busy=false;await page.replayDevice();assert.equal(calls,2,'failed replay can be retried');
}

async function phoneReplayAndStaleDownloadNeverGenerate(){
  const requests=[],downloads=[];let pending=null;
  const {page,contexts}=sandbox({request:async(...args)=>{requests.push(args);},download(url){downloads.push(url);return pending||Promise.resolve('local.wav');}});
  page.applyJob(generated);page.setData({error:''});
  await page.play();assert.equal(page.data.playing,true);assert.equal(contexts.length,1);
  await page.play();assert.equal(contexts.length,2,'a tap while playing restarts from the beginning');
  assert.equal(contexts[0].destroyed,true);assert.equal(contexts[1].src,'local.wav');
  contexts[0].end();contexts[0].fail();assert.equal(page.data.playing,true,'old context callbacks cannot stop a newer replay');
  assert.equal(page.data.error,'');contexts[1].end();assert.equal(page.data.playing,false);
  await page.play();assert.equal(contexts.length,3,'the same completed audio can be replayed after ending');
  assert.equal(downloads.length,1,'replays reuse the downloaded complete file');assert.equal(requests.length,0);
  page.stopPhonePlayback();assert.equal(page.data.playing,false);assert.equal(contexts[2].destroyed,true);
  const late=deferred();pending=late.promise;let aborts=0;pending.abort=()=>aborts++;
  page.applyJob({...generated,id:'other',audio_url:'/api/audio/other.wav'});
  const task=page.play();page.stopPhonePlayback();late.resolve('stale.wav');await task;
  assert.equal(contexts.length,3);assert.equal(aborts,1);assert.equal(page.data.phoneLoading,false);
  assert.equal(requests.length,0,'replaying and stopping must never generate speech');
}

async function completeOnlyAutoplayOnceAndThenRepeat(){
  const requests=[],downloads=[],full=deferred();
  const {page,contexts,toasts,values}=sandbox({request:async(url,method,body)=>{requests.push({url,method,body});return {...generated,status:'queued',audio_url:null,parts:[],delivery:null};},download(url){downloads.push(url);return full.promise;}});
  values.autoPlayParts=true;page.applyPreferences();assert.equal(page.data.autoPlayParts,false);
  page.setData({text:'完整生成后播放',sendDevice:false,autoPlayParts:true});await page.generate();
  assert.equal(requests[0].body.playback_mode,'complete');assert.equal(requests[0].body.device_id,null);
  const partial={...generated,status:'synthesizing',audio_url:null,delivery:null};
  page.applyJob(partial);page.applyJob({...partial,parts:[...partial.parts,{index:2,audio_url:'/part2.wav'}]});
  await page.play({currentTarget:{dataset:{first:true}}});await tick();
  assert.equal(downloads.length,0,'even legacy first-part clicks cannot download partial audio');assert.equal(contexts.length,0);
  assert.match(toasts.at(-1).title,/完整/);
  const complete={...generated,delivery:null};page.applyJob(complete);page.applyJob({...complete,revision:'r2'});
  assert.deepEqual(downloads,[complete.audio_url]);assert.equal(contexts.length,0,'wait for complete-file download');
  full.resolve('complete.wav');await tick();assert.equal(contexts.length,1);assert.equal(contexts[0].src,'complete.wav');
  page.applyJob({...complete,revision:'r3',delivery:'pending'});page.applyJob({...complete,revision:'r4',delivery:'playing'});
  assert.equal(contexts.length,1,'delivery updates must not restart or stop the automatic playback');assert.equal(page.data.playing,true);
  contexts[0].end();page.applyJob({...complete,revision:'r5',delivery:'delivered'});await tick();
  assert.equal(contexts.length,1,'polling after ended must not replay automatically');
  await page.play();await page.play();assert.equal(contexts.length,3);assert.equal(downloads.length,1);assert.equal(requests.length,1);
}

async function cacheHitAutoplaySnapshotsSubmissionTarget(){
  for(const sendDevice of [false,true]){
    const reply=deferred(),downloads=[],requests=[];
    const {page,contexts}=sandbox({request(url,method,body){requests.push({url,method,body});return reply.promise;},download(url){downloads.push(url);return Promise.resolve('cached.wav');}});
    page.setData({text:'缓存命中',sendDevice,deviceId:'board',autoPlayParts:true});const generation=page.generate();
    page.setData({sendDevice:!sendDevice});reply.resolve({...generated,cache_hit:true,delivery:sendDevice?'pending':null});await generation;await tick();
    assert.equal(requests[0].body.device_id,sendDevice?'board':null);
    assert.equal(contexts.length,sendDevice?0:1,'autoplay follows the target selected when submitted');
    assert.equal(downloads.length,sendDevice?0:1,'board autoplay must not also play on the phone');
    page.applyJob({...generated,cache_hit:true,delivery:'delivered'});await tick();
    assert.equal(contexts.length,sendDevice?0:1);
  }
}

async function stopHideFailureAndUnloadPreventLateAutoplay(){
  for(const action of ['stopPhonePlayback','onHide','failed','cancelled']){
    const downloads=[],{page,contexts}=sandbox({request:async()=>({...generated,status:'queued',audio_url:null,parts:[],delivery:null}),download(url){downloads.push(url);return Promise.resolve('late.wav');}});
    page.setData({text:'等待完成',sendDevice:false});await page.generate();
    if(action==='failed'||action==='cancelled')page.applyJob({...generated,status:action,audio_url:null,delivery:null});else page[action]();
    page.visible=true;page.applyJob({...generated,delivery:null});await tick();
    assert.equal(downloads.length,0,action+' must prevent pending automatic playback');assert.equal(contexts.length,0);
  }
  for(const action of ['stopPhonePlayback','onHide','onUnload']){
    const pending=deferred();let aborts=0;pending.promise.abort=()=>aborts++;
    const {page,contexts}=sandbox({request:async()=>({...generated,delivery:null}),download:()=>pending.promise});
    page.setData({text:'生成完成但还在下载',sendDevice:false});await page.generate();
    assert.equal(page.data.phoneLoading,true);page[action]();pending.resolve('too-late.wav');await tick();
    assert.equal(aborts,1);assert.equal(contexts.length,0,action+' must ignore late complete-file downloads');
  }
  const reply=deferred(),{page,contexts}=sandbox({request:()=>reply.promise,download:async()=>{throw new Error('should not download');}});
  page.setData({text:'提交中停止',sendDevice:false});const generation=page.generate();page.stopPhonePlayback();
  reply.resolve({...generated,delivery:null});await generation;await tick();assert.equal(contexts.length,0);
}

async function playbackFailureInvalidatesCachedFile(){
  let downloads=0;const {page,contexts}=sandbox({download:async()=>{downloads++;return 'file-'+downloads+'.wav';}});
  page.applyJob(generated);await page.play();contexts[0].fail('file missing');
  assert.equal(page.data.playing,false);assert.equal(page.data.phoneLoading,false);assert.match(page.data.error,/file missing/);
  await page.play();assert.equal(downloads,2);assert.equal(contexts[1].src,'file-2.wav');assert.equal(page.data.error,'');
}

function preferencesAndNativeNavigation(){
  const {page,saves,routes}=sandbox({});
  page.data.voices=[{id:'Vivian',name:'明亮女声'},{id:'Serena',name:'温柔女声'}];page.applyPreferences();
  assert.equal(page.data.voiceIndex,1);assert.equal(page.data.displayMode,'wave');
  page.changeVoice({detail:{value:'0'}});page.chooseSpeed({detail:{value:'10'}});page.chooseTarget({currentTarget:{dataset:{device:false}}});
  assert.equal(page.data.selectedVoice,'Vivian');assert.equal(page.data.speed,1.25);assert.equal(page.data.sendDevice,false);assert.equal(saves.length,3);
  page.goHistory();page.goDevice();assert.deepEqual(routes,['/pages/history/index','/pages/device/index']);
}

(async()=>{await replayUsesExistingJobAndGuardsDoubleTaps();await replayFailureAndUnavailableAudioRemainRecoverable();await phoneReplayAndStaleDownloadNeverGenerate();await completeOnlyAutoplayOnceAndThenRepeat();await cacheHitAutoplaySnapshotsSubmissionTarget();await stopHideFailureAndUnloadPreventLateAutoplay();await playbackFailureInvalidatesCachedFile();preferencesAndNativeNavigation();console.log('Generation page: completion-only autoplay, cache hits, target snapshots, repeat playback, stale callbacks, cancellation and existing-audio device replay passed.');})().catch(error=>{console.error(error);process.exitCode=1;});
