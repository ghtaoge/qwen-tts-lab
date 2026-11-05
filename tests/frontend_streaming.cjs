const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const StreamPlayer=require('../static/stream-audio');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

function browserSandbox(){
  const timers=[],delays=[],elements=new Map();let playerOptions;
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',dataset:{},children:[],append(child){this.children.push(child);},replaceChildren(){this.children=[];},addEventListener(){},pause(){},classList:{add(){},remove(){},toggle(){}}});return elements.get(id);};
  class Player {constructor(options){playerOptions=options;}start(){return new Promise(()=>{});}stop(){}setVolume(){}}
  const sandbox={StreamAudioPlayer:Player,AbortController,performance:{now:()=>100},console,setTimeout(fn,delay){timers.push(fn);delays.push(delay);return timers.length;},clearTimeout(){},setInterval(){},clearInterval(){},document:{getElementById:element,createElement:()=>({}),querySelectorAll:()=>[],addEventListener(){}}};
  vm.createContext(sandbox);
  let code=fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8');
  code=code.slice(0,code.lastIndexOf('\nupdateCount();drawWave(null);'));
  vm.runInContext(code,sandbox);
  return{sandbox,timers,delays,element,getPlayerOptions:()=>playerOptions};
}

function miniSandbox(mockApi){
  const timers=[],delays=[];let definition;
  const sandbox={require:()=>mockApi||({request:async()=>({id:'one',status:'completed',delivery:sandbox.delivery})}),Page:value=>definition=value,setTimeout(fn,delay){timers.push(fn);delays.push(delay);return timers.length;},clearTimeout(){},setInterval(){},clearInterval(){},Date,Map,wx:{hideLoading(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../miniprogram/pages/index/index.js'),'utf8'),sandbox);
  return{sandbox,timers,delays,definition};
}

async function testLongPollRevisionsAndOldResponses(){
  const older=deferred(),newer=deferred(),h=browserSandbox();
  h.sandbox.requests=[];h.sandbox.responses=[older.promise,newer.promise];h.sandbox.renderCount=0;
  vm.runInContext("currentJob={id:'one',parts:[{},{}],revision:'v1+x y'};api=path=>{requests.push(path);return responses.shift();};renderJob=job=>{currentJob=job;renderCount++;};",h.sandbox);
  const first=vm.runInContext("pollJob('one')",h.sandbox),second=vm.runInContext("pollJob('one')",h.sandbox);
  newer.resolve({id:'one',status:'synthesizing',parts:[],revision:'v3'});await second;
  older.resolve({id:'one',status:'synthesizing',parts:[],revision:'v2'});await first;
  assert.equal(vm.runInContext('currentJob.revision',h.sandbox),'v3');assert.equal(h.sandbox.renderCount,1);
  assert.equal(h.sandbox.requests[0],'/api/jobs/one?after_parts=2&revision=v1%2Bx%20y&wait_ms=1000');
  assert.equal(h.delays.at(-1),0,'long poll success must immediately request the next update');
  h.sandbox.responses=[Promise.resolve({id:'one',status:'synthesizing',parts:[],revision:'v3'})];
  await vm.runInContext("pollJob('one')",h.sandbox);assert.equal(h.sandbox.renderCount,1,'unchanged revision must skip repeated UI reconstruction');

  const a=deferred(),b=deferred(),paths=[],responses=[a.promise,b.promise];
  const m=miniSandbox({request(path){paths.push(path);return responses.shift();}});
  const page=Object.assign({},m.definition,{alive:true,visible:true,currentId:'one',data:{busy:true,result:{id:'one',revision:'v1+x y',parts:[{},{}]}},renders:0,applyJob(job){this.data.result=job;this.renders++;}});
  page.pollJob('one');const one=m.timers.shift()();page.pollJob('one');const two=m.timers.shift()();
  b.resolve({id:'one',status:'synthesizing',parts:[],revision:'v3'});await two;
  a.resolve({id:'one',status:'synthesizing',parts:[],revision:'v2'});await one;
  assert.equal(page.data.result.revision,'v3');assert.equal(page.renders,1);assert.equal(m.delays.at(-1),0);
  assert.equal(paths[0],'/api/jobs/one?after_parts=2&revision=v1%2Bx%20y&wait_ms=1000');
  responses.push(Promise.resolve({id:'one',status:'synthesizing',parts:[],revision:'v3'}));
  await m.timers.shift()();assert.equal(page.renders,1,'unchanged revision must not resend all parts through setData');
}

function testPartsAreAppendedWithoutReplacingButtons(){
  const h=browserSandbox();
  vm.runInContext("renderParts({id:'one',parts:[{index:1,audio_url:'/one.wav',duration:.24,text:'一'}]})",h.sandbox);
  const first=h.element('parts').children[0];
  vm.runInContext("renderParts({id:'one',parts:[{index:1,audio_url:'/one.wav',duration:.24,text:'一'},{index:2,audio_url:'/two.wav',duration:.24,text:'二'}]})",h.sandbox);
  assert.equal(h.element('parts').children[0],first);assert.equal(h.element('parts').children.length,2);
  vm.runInContext("renderParts({id:'two',parts:[{index:1,audio_url:'/three.wav',duration:.24,text:'三'}]})",h.sandbox);
  assert.equal(h.element('parts').children.length,1);assert.notEqual(h.element('parts').children[0],first);
}

function testMiniSetDataSendsDeltasAndRetainsCompleteMetadata(){
  const h=miniSandbox(),updates=[];
  const page=Object.assign({},h.definition,{alive:true,visible:true,data:JSON.parse(JSON.stringify(h.definition.data)),refreshHistory(){},setData(patch){
    updates.push(patch);
    for(const [name,value] of Object.entries(patch)){
      const keys=name.replace(/\[(\d+)\]/g,'.$1').split('.');let target=this.data;
      for(let index=0;index<keys.length-1;index++)target=target[keys[index]]||(target[keys[index]]=isNaN(Number(keys[index+1]))?{}:[]);
      target[keys.at(-1)]=value;
    }
  }});
  const one={index:1,audio_url:'/one.wav',duration:.24,text:'完整文字'},two={index:2,audio_url:'/two.wav',duration:.24,text:'完整文字'};
  const first={id:'one',status:'synthesizing',parts:[one],revision:'r1',duration:.24};
  page.applyJob(first);const original=page.data.result.parts[0];
  page.applyJob({...first,parts:[one,two],duration:.48,revision:'r2'});const delta=updates.at(-1);
  assert.ok(!('result' in delta)&&!('result.parts' in delta));assert.equal(delta['result.parts[1]'],two);assert.equal(delta['result.revision'],'r2');
  assert.equal(page.data.result.parts.length,2);assert.equal(page.data.result.parts[0],original);assert.equal(page.latestJob.revision,'r2');assert.equal(page.latestJob.parts[1].text,'完整文字');
  page.applyJob({...first,parts:[one,two],status:'completed',audio_url:'/full.wav',revision:'r3',total_seconds:.5});
  assert.equal(page.data.result.status,'completed');assert.equal(page.data.result.audio_url,'/full.wav');assert.equal(page.data.result.revision,'r3');assert.equal(page.data.result.parts.length,2);
  page.applyJob({...first,id:'two',parts:[two],revision:'new'});assert.ok(updates.at(-1).result);assert.equal(page.data.result.parts.length,1);
}

function waveData(samples,{rate=24000,channels=1,junk=false,dataFirst=false,codec=1,bits=16}={}){
  function chunk(tag,payload){const head=Buffer.alloc(8);head.write(tag);head.writeUInt32LE(payload.length,4);return Buffer.concat([head,payload,payload.length&1?Buffer.alloc(1):Buffer.alloc(0)]);}
  const fmt=Buffer.alloc(16),bytes=bits/8;fmt.writeUInt16LE(codec);fmt.writeUInt16LE(channels,2);fmt.writeUInt32LE(rate,4);fmt.writeUInt32LE(rate*channels*bytes,8);fmt.writeUInt16LE(channels*bytes,12);fmt.writeUInt16LE(bits,14);
  const pcm=Buffer.alloc(samples.length*bytes);samples.forEach((sample,index)=>bits===32?pcm.writeFloatLE(sample,index*bytes):pcm.writeInt16LE(sample,index*bytes));
  const format=chunk('fmt ',fmt),audio=chunk('data',pcm),chunks=[...(junk?[chunk('JUNK',Buffer.from([1,2,3]))]:[]),...(dataFirst?[audio,format]:[format,audio])];
  const header=Buffer.alloc(12);header.write('RIFF');header.writeUInt32LE(4+chunks.reduce((sum,item)=>sum+item.length,0),4);header.write('WAVE',8);
  const file=Buffer.concat([header,...chunks]);return file.buffer.slice(file.byteOffset,file.byteOffset+file.length);
}

function pcmContext(){return{createBuffer(channels,length,rate){const data=Array.from({length:channels},()=>new Float32Array(length));return{numberOfChannels:channels,length,sampleRate:rate,duration:length/rate,getChannelData:channel=>data[channel]};}};}

function testPcm16ParserAndFallbackBoundaries(){
  const samples=[-32768,-12345,0,12345,32767,-12345];
  for(const rate of [8000,24000,48000])for(const channels of [1,2]){
    const buffer=StreamPlayer.decodePcmWav(pcmContext(),waveData(samples,{rate,channels,junk:true,dataFirst:true}));
    assert.equal(buffer.sampleRate,rate);assert.equal(buffer.numberOfChannels,channels);assert.equal(buffer.length,samples.length/channels);
    for(let channel=0;channel<channels;channel++)for(let frame=0;frame<buffer.length;frame++)assert.equal(buffer.getChannelData(channel)[frame],samples[frame*channels+channel]/32768);
  }
  const valid=waveData(samples);
  assert.equal(StreamPlayer.decodePcmWav(pcmContext(),valid.slice(0,-1)),null,'truncated PCM must fall back safely');
  const corrupt=valid.slice(0);new DataView(corrupt).setUint32(16,0xffffffff,true);assert.equal(StreamPlayer.decodePcmWav(pcmContext(),corrupt),null);
  const noFormat=valid.slice(0);new Uint8Array(noFormat).set(Buffer.from('JUNK'),12);assert.equal(StreamPlayer.decodePcmWav(pcmContext(),noFormat),null);
  const noData=valid.slice(0);new Uint8Array(noData).set(Buffer.from('JUNK'),36);assert.equal(StreamPlayer.decodePcmWav(pcmContext(),noData),null);
  const cutChunk=valid.slice(0,-1);new DataView(cutChunk).setUint32(4,cutChunk.byteLength-8,true);assert.equal(StreamPlayer.decodePcmWav(pcmContext(),cutChunk),null);
  const duplicateData=new Uint8Array(valid.byteLength+12);duplicateData.set(new Uint8Array(valid));duplicateData.set(Buffer.from('data'),valid.byteLength);const duplicateView=new DataView(duplicateData.buffer);duplicateView.setUint32(4,duplicateData.byteLength-8,true);duplicateView.setUint32(valid.byteLength+4,4,true);assert.equal(StreamPlayer.decodePcmWav(pcmContext(),duplicateData.buffer),null,'multiple data chunks must fall back instead of silently playing only the first');
  for(const rate of [0,7999,48001])assert.equal(StreamPlayer.decodePcmWav(pcmContext(),waveData(samples,{rate})),null);
  assert.equal(StreamPlayer.decodePcmWav(pcmContext(),waveData([NaN,Infinity],{codec:3,bits:32})),null,'float NaN data must never enter the PCM16 path');
  assert.equal(StreamPlayer.decodePcmWav(pcmContext(),waveData([])),null);
}

async function testBoundedPrefetchDoesNotRedownloadOrUnderrunLongClips(){
  const contexts=[],requests=[];
  class Context {
    constructor(){this.currentTime=0;this.destination={};this.sources=[];contexts.push(this);}
    createGain(){return{gain:{value:1},connect(){}};}
    resume(){return Promise.resolve();}close(){return Promise.resolve();}
    decodeAudioData(data){return Promise.resolve(data);}
    createBufferSource(){const source={connect(){},disconnect(){},stop(){},start(at){this.at=at;}};this.sources.push(source);return source;}
  }
  const player=new StreamPlayer({AudioContext:Context,fetch:async url=>{requests.push(url);return{ok:true,arrayBuffer:async()=>({duration:.5})};}});
  await player.start();const parts=Array.from({length:20},(_,index)=>({index:index+1,audio_url:`/${index}.wav`}));player.update(parts,true);
  for(let i=0;i<10;i++)await tick();assert.ok(requests.length>=2&&requests.length<=8,'prefetch should stop around a few seconds, not load the full long job');
  player.update(parts,true);const context=contexts[0];
  for(let guard=0;player.active&&guard<50;guard++){
    const source=context.sources.find(item=>!item.ended);if(!source){await tick();continue;}
    source.ended=true;context.currentTime=source.at+source.buffer.duration;source.onended();await tick();await tick();
  }
  assert.equal(player.active,false);assert.equal(requests.length,20);assert.equal(new Set(requests).size,20);
  const longRequests=[];
  const long=new StreamPlayer({AudioContext:Context,fetch:async url=>{longRequests.push(url);return{ok:true,arrayBuffer:async()=>({duration:4})};}});
  await long.start();long.update(parts.slice(0,3),true);for(let i=0;i<5;i++)await tick();
  assert.equal(longRequests.length,2,'even a long sentence should have its next clip prefetched');
  const clock=contexts[1],first=clock.sources[0];clock.currentTime=first.at+4;first.onended();for(let i=0;i<5;i++)await tick();assert.equal(longRequests.length,3);long.stop();
}

async function testDeliveryPolling(){
  for(const delivery of ['pending','leased','waiting','buffering','playing','delivered','error','cancelled']){
    const active=['pending','leased','waiting','buffering','playing'].includes(delivery);
    const h=browserSandbox();h.sandbox.delivery=delivery;
    await vm.runInContext("currentJob={id:'one'};api=async()=>({id:'one',status:'completed',delivery});renderJob=job=>{currentJob=job;};pollJob('one')",h.sandbox);
    assert.equal(h.timers.length,active?1:0,`browser poll after completed/${delivery}`);
    const m=miniSandbox();m.sandbox.delivery=delivery;
    const page=Object.assign({},m.definition,{alive:true,visible:true,currentId:'one',data:{busy:false},applyJob(){}});
    page.pollJob('one');await m.timers.shift()();
    assert.equal(m.timers.length,active?1:0,`mini poll after completed/${delivery}`);
  }
}

async function testSubmitDoesNotWaitForAudioDevice(){
  const h=browserSandbox();h.element('text').value='你好';h.element('autoPlay').checked=true;h.element('speed').value='1';h.element('language').value='Chinese';
  h.sandbox.submitted=false;
  const pending=vm.runInContext("api=async()=>{submitted=true;throw new Error('submission observed');};submit()",h.sandbox);
  await tick();assert.equal(h.sandbox.submitted,true,'model POST must run while AudioContext.resume remains pending');await pending;
  const guarded=browserSandbox();guarded.element('text').value='你好';guarded.element('autoPlay').checked=false;
  let rejectRequest;guarded.sandbox.postCalls=0;
  guarded.sandbox.pendingRequest=new Promise((_resolve,reject)=>rejectRequest=reject);
  const first=vm.runInContext("api=()=>{postCalls++;return pendingRequest;};submit()",guarded.sandbox);
  await vm.runInContext('submit()',guarded.sandbox);assert.equal(guarded.sandbox.postCalls,1,'keyboard re-entry must not duplicate a pending submission');
  rejectRequest(new Error('test complete'));await first;
}

function testCompletedStreamRestoresNativeReplay(){
  const h=browserSandbox();h.sandbox.reloadedUrl='';
  vm.runInContext("setAudio=url=>{reloadedUrl=url;};currentJob={audio_url:'/finished.wav'};manualAudioSelection=false;autoActive=true;",h.sandbox);
  h.getPlayerOptions().onState('completed');assert.equal(h.sandbox.reloadedUrl,'/finished.wav');
  vm.runInContext("manualAudioSelection=true;reloadedUrl='';",h.sandbox);
  h.getPlayerOptions().onState('completed');assert.equal(h.sandbox.reloadedUrl,'','a manually chosen clip must remain selected');
}

async function testAudioWaitsForResumeAndDownloadTimeoutStops(){
  let resume;const sources=[],errors=[];
  class Context {
    constructor(){this.currentTime=0;this.destination={};}
    createGain(){return{gain:{value:1},connect(){}};}
    resume(){return new Promise(resolve=>resume=resolve);}
    close(){return Promise.resolve();}
    decodeAudioData(){return Promise.resolve({duration:.24});}
    createBufferSource(){const source={connect(){},start(){},stop(){},disconnect(){}};sources.push(source);return source;}
  }
  const player=new StreamPlayer({AudioContext:Context,fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)})});
  const start=player.start();player.update([{index:1,audio_url:'/first.wav'}],true);await tick();await tick();
  assert.equal(sources.length,0,'a suspended context must not report first playback');
  resume();await start;assert.equal(sources.length,1);player.stop();
  const hung=new StreamPlayer({AudioContext:class extends Context {resume(){return Promise.resolve();}},fetchTimeoutMs:10,fetch:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{const error=new Error('aborted');error.name='AbortError';reject(error);})),onError:error=>errors.push(error.message)});
  await hung.start();hung.update([{index:1,audio_url:'/hung.wav'}]);
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(hung.active,false);assert.equal(hung.controllers.size,0);assert.equal(hung.timeouts.size,0);assert.match(errors[0],/超时/);
}

async function testMiniStopAbortsDownloads(){
  const h=miniSandbox();let aborts=0;
  const pending={abort(){aborts++;}};
  const page=Object.assign({},h.definition,{alive:true,playEpoch:1,audio:{stop(){}},partDownloads:new Map([['one',pending],['two',pending]]),manualDownload:pending,setData(){}});
  page.resetPlayback();assert.equal(aborts,3);assert.equal(page.playEpoch,2);assert.equal(page.partDownloads.size,0);
  const sandbox={module:{exports:{}},require:()=>({baseUrl:'http://test.invalid',clientToken:'test'}),wx:{getStorageSync:()=>({}),downloadFile(options){return{abort(){options.fail({errMsg:'downloadFile:fail abort'});}};}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../miniprogram/lib/api.js'),'utf8'),sandbox);
  const download=sandbox.module.exports.download('/one.wav');download.abort();await assert.rejects(download,/abort/);
}

async function testMiniStopDuringSubmissionCancelsReturnedJob(){
  let resolvePost;const cancellations=[];
  const h=miniSandbox({request(path){if(path==='/api/jobs')return new Promise(resolve=>resolvePost=resolve);cancellations.push(path);return Promise.resolve({});}});
  const page=Object.assign({},h.definition,{alive:true,currentId:null,data:{busy:false,text:'你好',autoPlayParts:false},setData(update){Object.assign(this.data,update);},resetPlayback(){this.autoActive=false;},beginElapsed(){},applyJob(){},pollJob(){}});
  const generation=page.generate();
  await page.stop();assert.equal(page.stopRequested,true,'stop must be remembered before the job ID arrives');
  resolvePost({id:'pending',status:'queued',parts:[]});await generation;
  assert.deepEqual(cancellations,['/api/jobs/pending/cancel']);
}

(async()=>{await testDeliveryPolling();await testLongPollRevisionsAndOldResponses();testPartsAreAppendedWithoutReplacingButtons();testMiniSetDataSendsDeltasAndRetainsCompleteMetadata();testPcm16ParserAndFallbackBoundaries();await testBoundedPrefetchDoesNotRedownloadOrUnderrunLongClips();await testSubmitDoesNotWaitForAudioDevice();testCompletedStreamRestoresNativeReplay();await testAudioWaitsForResumeAndDownloadTimeoutStops();await testMiniStopAbortsDownloads();await testMiniStopDuringSubmissionCancelsReturnedJob();console.log('Frontend long polling, incremental parts, PCM16 boundaries, bounded prefetch, replay and cancellation passed.');})().catch(error=>{console.error(error);process.exitCode=1;});
