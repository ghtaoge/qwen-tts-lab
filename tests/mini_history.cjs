const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/history/index.js'), 'utf8');
const event = id => ({currentTarget:{dataset:{id}}});
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve=yes; reject=no;});
  let aborts = 0;
  promise.abort = () => {aborts++;};
  return {promise, resolve, reject, get aborts(){return aborts;}};
}
function record(id='one', patch={}) {
  return {id, text:'你好，已经生成的语音。', status:'completed', audio_url:'/api/audio/'+id+'.wav',
    voice:'Serena', speed:1, duration:2.5, created_at:1, ...patch};
}
function harness(options={}) {
  let definition, nextTimer=0;
  const requests=[], downloads=[], contexts=[], timers=new Map(), navigations=[];
  const api={
    config:() => ({deviceId:'esp32_01'}),
    request:async (url, method, data) => {
      requests.push({url, method:method||'GET', data});
      return options.request ? options.request(url, method||'GET', data) : [];
    },
    download:url => {
      const pending=deferred(); downloads.push({url, pending}); return pending.promise;
    }
  };
  const wx={
    createInnerAudioContext() {
      const callbacks={};
      const audio={
        src:'', stopped:0, destroyed:0, played:0,
        onPlay:fn => callbacks.play=fn, onEnded:fn => callbacks.end=fn, onError:fn => callbacks.error=fn,
        play(){this.played++; callbacks.play();}, stop(){this.stopped++;}, destroy(){this.destroyed++;},
        emit(name, value){callbacks[name](value);}
      };
      contexts.push(audio); return audio;
    },
    switchTab:args => navigations.push(args.url), stopPullDownRefresh(){}
  };
  vm.runInNewContext(source, {
    require:name => name.includes('preferences') ? {get:() => ({displayMode:'wave'})} : api,
    Page:value => definition=value, wx, Date, Map, Set, console,
    setTimeout(fn, delay){const id=++nextTimer; timers.set(id,{fn,delay}); return id;},
    clearTimeout(id){timers.delete(id);}
  });
  const page=Object.assign({}, definition, {
    data:JSON.parse(JSON.stringify(definition.data)), setData(patch){Object.assign(this.data, patch);}
  });
  page.onLoad(); page.visible=true;
  return {
    page, requests, downloads, contexts, timers, navigations,
    async runNextTimer(){
      const entry=timers.entries().next().value;
      assert.ok(entry, 'expected a scheduled replay status request');
      timers.delete(entry[0]); await entry[1].fn();
    }
  };
}

function testDistinctHistoryAndReadableActions() {
  const h=harness(), p=h.page;
  p.rawJobs=[record('original'), record('replay', {replay_of:'original', created_at:3}), record('other',{created_at:2}), record('old-replay',{replay_of:'original',created_at:2})];
  p.renderHistory();
  assert.equal(p.data.history.length,2,'replays must not fill the history with duplicate rows');
  assert.equal(p.data.history[0].id,'replay'); assert.equal(p.data.history[0].key,'original');
  assert.equal(p.data.history[1].id,'other'); assert.equal(p.data.history[0].canReplay,true);
  p.toggleExpand(event('replay')); assert.equal(p.data.expandedKey,'original');
  p.toggleExpand(event('replay')); assert.equal(p.data.expandedKey,'');
  const wxml=fs.readFileSync(path.join(__dirname,'../miniprogram/pages/history/index.wxml'),'utf8');
  for (const name of [...wxml.matchAll(/(?:bind|catch)tap="(\w+)"/g)].map(match=>match[1])) assert.equal(typeof p[name],'function',name);
  assert.match(wxml,/catchtap="playPhone"/); assert.match(wxml,/catchtap="replayDevice"/);
  assert.match(wxml,/手机重播/); assert.match(wxml,/开发板重播/);
  p.goGenerate(); assert.deepEqual(h.navigations,['/pages/index/index']);
}

async function testPhoneReplayReusesFileAndSupportsRepeat() {
  const h=harness(), p=h.page; p.rawJobs=[record()]; p.renderHistory();
  let playing=p.playPhone(event('one'));
  assert.equal(p.data.downloadingKey,'one'); assert.equal(h.downloads[0].url,'/api/audio/one.wav');
  await p.playPhone(event('one')); assert.equal(h.downloads.length,1,'loading audio must reject duplicate taps');
  h.downloads[0].pending.resolve('/tmp/first.wav'); await playing;
  assert.equal(p.data.playingKey,'one'); assert.equal(h.contexts[0].played,1);
  h.contexts[0].emit('end'); assert.equal(p.data.playingKey,'');
  playing=p.playPhone(event('one')); await playing;
  assert.equal(h.contexts[1].src,'/tmp/first.wav'); assert.equal(h.contexts[1].played,1);
  assert.equal(h.downloads.length,1,'repeat playback should reuse the downloaded complete file');
  assert.equal(h.requests.length,0,'phone replays must never submit or regenerate a model job');
  await p.playPhone(event('one')); assert.equal(p.data.playingKey,'one'); assert.equal(h.contexts[1].destroyed,1);
  assert.equal(h.contexts[2].played,1,'tapping replay while playing starts again from the beginning');
  p.stopPhone(); assert.equal(p.data.playingKey,'');
}

async function testPhoneSwitchAndHiddenPageRejectOldCallbacks() {
  const h=harness(), p=h.page; p.rawJobs=[record('one'),record('two')]; p.renderHistory();
  const first=p.playPhone(event('one')), second=p.playPhone(event('two'));
  assert.equal(h.downloads[0].pending.aborts,1);
  h.downloads[0].pending.resolve('/tmp/old.wav'); await first;
  assert.equal(h.contexts.length,0,'stale downloads must not start playback');
  h.downloads[1].pending.resolve('/tmp/new.wav'); await second;
  const prior=h.contexts[0];
  const third=p.playPhone(event('one')); h.downloads[2].pending.resolve('/tmp/one.wav'); await third;
  prior.emit('end'); prior.emit('error',{errMsg:'stale failure'});
  assert.equal(p.data.playingKey,'one'); assert.equal(p.data.error,'');
  p.onHide(); assert.equal(p.data.playingKey,''); assert.equal(h.contexts[1].destroyed,1);
  p.visible=true;
  p.phoneFiles.delete('/api/audio/two.wav');
  const fourth=p.playPhone(event('two')); p.onHide();
  h.downloads[3].pending.resolve('/tmp/hidden.wav'); await fourth;
  assert.equal(h.contexts.length,2,'hidden pages must not start a late download');
  p.onUnload(); assert.equal(p.alive,false);
}

async function testPhoneErrorsNeverRegenerate() {
  const h=harness(), p=h.page; p.rawJobs=[record()]; p.renderHistory();
  let play=p.playPhone(event('one')); h.downloads[0].pending.reject(new Error('404')); await play;
  assert.match(p.data.error,/404/); assert.equal(p.data.downloadingKey,'');
  play=p.playPhone(event('one')); h.downloads[1].pending.resolve('/tmp/audio.wav'); await play;
  h.contexts[0].emit('error',{errMsg:'invalid audio'});
  assert.match(p.data.error,/invalid audio/); assert.equal(p.data.playingKey,''); assert.equal(h.requests.length,0);
  play=p.playPhone(event('one')); assert.equal(h.downloads.length,3,'a failed cached file must be downloaded again');
  h.downloads[2].pending.resolve('/tmp/recovered.wav'); await play; p.stopPhone();
  p.rawJobs=[record('pending',{status:'synthesizing',audio_url:null})]; p.renderHistory();
  await p.playPhone(event('pending')); await p.replayDevice(event('pending'));
  assert.equal(h.downloads.length,3); assert.equal(h.requests.length,0,'unfinished audio cannot be replayed');
}

async function testBoardReplayEndpointGuardAndDelivery() {
  const post=deferred(); let getCount=0;
  const h=harness({request(url, method){
    if (method==='POST') return post.promise;
    if (url==='/api/jobs') return [record('replayed',{replay_of:'one',created_at:5})];
    getCount++; return {id:'replayed',status:'completed',delivery:'delivered',parts:[],revision:'r2'};
  }}), p=h.page;
  p.rawJobs=[record()]; p.renderHistory();
  const replay=p.replayDevice(event('one')); await p.replayDevice(event('one'));
  assert.equal(h.requests.length,1,'repeated taps must not enqueue duplicate playback jobs');
  assert.equal(h.requests[0].url,'/api/jobs/one/replay');
  assert.equal(h.requests[0].data.device_id,'esp32_01'); assert.equal(h.requests[0].data.display_mode,'wave');
  post.resolve({id:'replayed',status:'completed',delivery:'pending',parts:[],revision:'r1+x'}); await replay;
  assert.equal(p.data.replayBusy,true); assert.equal(p.data.canStopReplay,true); assert.equal(p.data.history[0].deviceLabel,'等待开发板');
  await h.runNextTimer(); await tick();
  assert.equal(getCount,1); assert.equal(p.data.replayBusy,false); assert.equal(p.data.history.length,1);
  assert.equal(p.data.history[0].deviceLabel,'开发板播放完成');
  assert.match(h.requests[1].url,/revision=r1%2Bx/);
  assert.ok(!h.requests.some(request=>request.url==='/api/jobs' && request.method==='POST'),'board replay must reuse existing audio through its dedicated API');
  p.rawJobs=[record('other-page-replay',{replay_of:'one',created_at:6,delivery:'playing'})]; p.renderHistory();
  assert.equal(p.data.history[0].deviceLabel,'开发板播放中','newer replays from another page must supersede a stale local delivery overlay');
}

async function testBoardReplaySurvivesTabSwitchWithoutHiddenUiUpdates() {
  const post=deferred();
  const h=harness({request(url,method){
    if (method==='POST') return post.promise;
    if (url==='/api/jobs') return [record('play',{replay_of:'one',created_at:5})];
    return {id:'play',status:'completed',delivery:'delivered',parts:[]};
  }}), p=h.page;
  p.rawJobs=[record()]; p.renderHistory();
  const replay=p.replayDevice(event('one')); p.onHide();
  post.resolve({id:'play',status:'completed',delivery:'pending',parts:[]}); await replay;
  assert.equal(h.timers.size,0,'hidden tabs must not continue device polling');
  assert.equal(p.replayJob.id,'play','leaving the history tab must not cancel board playback');
  p.onShow(); await tick(); await h.runNextTimer(); await tick();
  assert.equal(p.data.replayBusy,false); assert.equal(p.data.history[0].deviceLabel,'开发板播放完成');
}

async function testBoardReplayErrorsAndStalePolls() {
  let postFails=true;
  const oldPoll=deferred();
  const h=harness({request(url,method){
    if (method==='POST') {
      if (postFails) throw new Error('音频文件已丢失');
      return {id:'play',status:'completed',delivery:'pending',parts:[]};
    }
    if (url==='/api/jobs') return [record()];
    return oldPoll.promise;
  }}), p=h.page;
  p.rawJobs=[record()]; p.renderHistory();
  await p.replayDevice(event('one')); assert.equal(p.data.replayBusy,false); assert.match(p.data.error,/已丢失/);
  postFails=false; await p.replayDevice(event('one'));
  const poll=h.runNextTimer(); p.onHide();
  oldPoll.resolve({id:'play',status:'completed',delivery:'error',device_error:'stale error'}); await poll;
  assert.equal(p.replayJob.snapshot.delivery,'pending','a hidden tab must reject an old poll result');
  p.visible=true; p.applyReplay({id:'play',status:'completed',delivery:'error',device_error:'下载超时'}); await tick();
  assert.equal(p.data.replayBusy,false); assert.match(p.data.error,/下载超时/); assert.equal(p.data.history[0].deviceFailed,true);
}

async function testRefreshRejectsStaleAndMissingReplayTask() {
  const old=deferred(), fresh=deferred(); let reads=0;
  const h=harness({request(url,method){
    if (method==='POST') return {id:'lost',status:'completed',delivery:'pending',parts:[]};
    if (url==='/api/jobs') return ++reads===1?old.promise:fresh.promise;
    const error=new Error('missing'); error.status=404; throw error;
  }}), p=h.page;
  const a=p.refreshHistory(), b=p.refreshHistory();
  fresh.resolve([record('new')]); await b; old.resolve([record('old')]); await a;
  assert.equal(p.data.history[0].id,'new');
  await p.replayDevice(event('new')); await h.runNextTimer();
  assert.equal(p.data.replayBusy,false); assert.match(p.data.error,/已丢失/);
}

async function testHistoryRefreshErrorRecoveryPreservesActionErrors() {
  let failed=true;
  const h=harness({request(){if (failed) throw new Error('offline'); return [record()];}}), p=h.page;
  await p.refreshHistory(); assert.match(p.data.error,/offline/);
  failed=false; await p.refreshHistory(); assert.equal(p.data.error,'');
  p.setData({error:'手机播放失败：文件不存在'});
  await p.refreshHistory(); assert.match(p.data.error,/手机播放失败/);
}

async function testWaitingBoardReplayCanBeStoppedAndRetried() {
  const h=harness({request(url,method){
    if (url.endsWith('/cancel')) return {id:'play',status:'completed',delivery:'cancelled'};
    if (method==='POST') return {id:'play',status:'completed',delivery:'pending',parts:[]};
    return [record()];
  }}), p=h.page;
  p.rawJobs=[record()]; p.renderHistory();
  await p.replayDevice(event('one')); assert.equal(p.data.canStopReplay,true);
  await p.replayDevice(event('one')); await tick();
  assert.equal(p.data.replayBusy,false); assert.equal(p.data.canStopReplay,false);
  assert.equal(h.requests.filter(request=>request.url==='/api/jobs/play/cancel').length,1);
  assert.equal(p.data.history[0].deviceLabel,'开发板已停止');
  await p.replayDevice(event('one')); assert.equal(p.data.replayBusy,true,'cancelled playback must allow another replay without regeneration');
}

(async () => {
  testDistinctHistoryAndReadableActions();
  await testPhoneReplayReusesFileAndSupportsRepeat();
  await testPhoneSwitchAndHiddenPageRejectOldCallbacks();
  await testPhoneErrorsNeverRegenerate();
  await testBoardReplayEndpointGuardAndDelivery();
  await testBoardReplaySurvivesTabSwitchWithoutHiddenUiUpdates();
  await testBoardReplayErrorsAndStalePolls();
  await testRefreshRejectsStaleAndMissingReplayTask();
  await testHistoryRefreshErrorRecoveryPreservesActionErrors();
  await testWaitingBoardReplayCanBeStoppedAndRetried();
  console.log('Mini history: existing-audio replay, deduplication, lifecycle, stale callbacks, double-tap guard and delivery errors passed.');
})().catch(error => {console.error(error); process.exitCode=1;});
