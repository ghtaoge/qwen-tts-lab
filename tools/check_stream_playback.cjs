/* Playback regressions use deterministic media mocks; no synthetic audio is served to users. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const StreamPlayer=require('../static/stream-audio');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function mediaHarness(){
  const requests=[],contexts=[],events=[];
  class Context {
    constructor(){this.currentTime=0;this.sources=[];this.destination={};contexts.push(this);}
    createGain(){return{gain:{value:1},connect(){}};}
    resume(){return Promise.resolve();}
    close(){this.closed=true;return Promise.resolve();}
    decodeAudioData(data){return Promise.resolve(data);}
    createBufferSource(){const source={connect(){},start(at){this.at=at;},stop(){this.stopped=true;}};this.sources.push(source);return source;}
  }
  const player=new StreamPlayer({AudioContext:Context,fetch(url){const task=deferred();requests.push({url,...task});return task.promise;},onState:(...state)=>events.push(state)});
  const deliver=async(index,duration=.5)=>{requests[index].resolve({ok:true,arrayBuffer:async()=>({duration})});await tick();await tick();};
  return{player,requests,contexts,events,deliver};
}

async function testBrowserGapAndOrderedScheduling(){
  const h=mediaHarness();await h.player.start();
  const a={index:1,audio_url:'/one.wav'},b={index:2,audio_url:'/two.wav'};
  h.player.update([a],false);await h.deliver(0,.5);
  const context=h.contexts[0];assert.equal(context.sources.length,1);
  context.currentTime=.6;context.sources[0].onended();
  assert.equal(h.player.active,true,'a temporary model-generation gap must not end the stream');
  h.player.update([a,b],false);await h.deliver(1,.5);
  assert.equal(context.sources.length,2,'a newly arriving chunk must restart playback after a gap');
  assert.equal(h.requests.length,2,'the first chunk must not be downloaded/replayed again');
  context.currentTime=1.2;context.sources[1].onended();h.player.update([a,b],true);
  assert.equal(h.player.active,false,'the last chunk should finish even if job completion arrives after media ended');
  assert.equal(h.events.filter(event=>event[0]==='completed').length,1);

  const ordered=mediaHarness();await ordered.player.start();ordered.player.update([a,b],false);
  await ordered.deliver(1,.4);assert.equal(ordered.contexts[0].sources.length,0,'out-of-order network completion must preserve speech order');
  await ordered.deliver(0,.6);
  const sources=ordered.contexts[0].sources;assert.equal(sources.length,2);
  assert.equal(sources[1].at,sources[0].at+.6,'prefetched adjacent chunks should share a continuous AudioContext timeline');
  ordered.player.stop();assert.ok(sources.every(source=>source.stopped));
  assert.equal(ordered.player.ready.size,0,'stopping must release decoded buffers');
}

async function testBrowserLateDownloadCannotRestartStoppedStream(){
  const h=mediaHarness();await h.player.start();h.player.update([{index:1,audio_url:'/one.wav'}]);
  h.player.stop();await h.deliver(0,.5);
  assert.equal(h.contexts[0].sources.length,0);
  assert.equal(h.player.active,false);
  let errors=[];
  const unsupported=new StreamPlayer({AudioContext:class {constructor(){throw new Error('unsupported');}},onError:error=>errors.push(error.message)});
  await unsupported.start();
  assert.equal(unsupported.active,false);assert.deepEqual(errors,['unsupported']);
}

async function testMiniPrefetchAndGenerationGap(){
  const downloads=[],plays=[];let definition;
  const context={onPlay(fn){this.started=fn;},onEnded(fn){this.ended=fn;},onError(fn){this.failed=fn;},play(){plays.push(this.src);this.started?.();},stop(){},destroy(){}};
  const mockApi={config:()=>({}),request:async()=>[],download(url){const task=deferred();downloads.push({url,...task});return task.promise;}};
  const sandbox={require:()=>mockApi,Page:page=>definition=page,wx:{createInnerAudioContext:()=>context},setTimeout,clearTimeout,setInterval,clearInterval,Date,Map};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../miniprogram/pages/index/index.js'),'utf8'),sandbox);
  const page=Object.assign({},definition,{data:JSON.parse(JSON.stringify(definition.data)),setData(update){Object.assign(this.data,update);},initialize(){},refreshHistory(){}});
  page.onLoad();page.started=Date.now();page.autoActive=true;page.data.autoPlayParts=true;
  const one={index:1,audio_url:'/one.wav',duration:.4},two={index:2,audio_url:'/two.wav',duration:.5};
  const job={id:'one',status:'synthesizing',parts:[one],stage:'生成中'};
  page.applyJob(job);assert.equal(downloads.length,1);
  downloads[0].resolve('/tmp/one.wav');await tick();assert.deepEqual(plays,['/tmp/one.wav']);
  context.ended();assert.equal(page.autoActive,true);
  page.applyJob({...job,parts:[one,two]});assert.equal(downloads.length,2);
  downloads[1].resolve('/tmp/two.wav');await tick();assert.deepEqual(plays,['/tmp/one.wav','/tmp/two.wav']);
  context.ended();page.applyJob({...job,status:'completed',parts:[one,two]});
  assert.equal(page.autoActive,false);
  page.onUnload();

  // A stopped page must not resume after an already in-flight download finishes.
  const newPage=Object.assign({},definition,{data:JSON.parse(JSON.stringify(definition.data)),setData(update){Object.assign(this.data,update);},initialize(){},refreshHistory(){}});
  newPage.onLoad();newPage.autoActive=true;newPage.applyJob(job);const last=downloads.at(-1);
  newPage.resetPlayback();last.resolve('/tmp/stale.wav');await tick();
  assert.ok(!plays.includes('/tmp/stale.wav'));newPage.onUnload();
}

(async()=>{
  await testBrowserGapAndOrderedScheduling();
  await testBrowserLateDownloadCannotRestartStoppedStream();
  await testMiniPrefetchAndGenerationGap();
  console.log('Streaming playback: browser ordering, continuous scheduling, generation gaps, cancellation and mini-program prefetch checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
