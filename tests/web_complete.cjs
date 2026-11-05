const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const StreamAudioPlayer = require('../static/stream-audio');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return {promise, resolve};
}

function harness() {
  const elements = new Map(), documentEvents = new Map(), windowEvents = new Map();
  const requests = [], sources = [], controls = {starts: 0, stops: 0, options: null};
  const download = deferred();
  const element = id => {
    if (!elements.has(id)) {
      const events = new Map();
      elements.set(id, {
        value: '', dataset: {}, children: [], currentTime: 0, plays: 0, pauses: 0,
        append(...children) { this.children.push(...children); },
        replaceChildren() { this.children = []; },
        addEventListener(name, fn) { events.set(name, fn); },
        emit(name) { return events.get(name)?.(); },
        setAttribute(name, value) { this[name] = value; },
        removeAttribute(name) { delete this[name]; },
        pause() { this.pauses++; }, load() {}, focus() {},
        play() { this.plays++; this.emit('play'); return Promise.resolve(); },
        classList: {add() {}, remove() {}, toggle() {}},
      });
    }
    return elements.get(id);
  };
  class Context {
    constructor() { this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createGain() { return {gain: {value: 1}, connect() {}}; }
    decodeAudioData() { return Promise.resolve({duration: 3}); }
    createBufferSource() {
      const source = {connect() {}, disconnect() {}, stop() {}, start(at) { this.at = at; }};
      sources.push(source); return source;
    }
  }
  class Player extends StreamAudioPlayer {
    constructor(options) {
      controls.options = options;
      super({...options, AudioContext: Context, fetch(url, options) {
        requests.push({url, signal: options.signal});
        return download.promise;
      }});
    }
    start() { controls.starts++; return super.start(); }
    stop() { controls.stops++; return super.stop(); }
  }
  const document = {
    hidden: false, getElementById: element, createElement: () => element(Symbol()),
    querySelector: () => element('visual'), querySelectorAll: () => [],
    addEventListener(name, fn) { documentEvents.set(name, fn); },
  };
  const sandbox = {
    StreamAudioPlayer: Player, AbortController, console, performance: {now: () => 500},
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document, window: {addEventListener(name, fn) { windowEvents.set(name, fn); }, scrollTo() {}},
  };
  vm.createContext(sandbox);
  let code = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  code = code.slice(0, code.lastIndexOf('\nupdateCount();drawWave(null);'));
  vm.runInContext(code, sandbox);
  vm.runInContext('drawWave=()=>{};', sandbox);
  const run = code => vm.runInContext(code, sandbox);
  const render = changes => {
    sandbox.job = {id: 'job-one', text: '完整语音', status: 'synthesizing', stage: '转换中', voice: 'Serena', parts: [], ...changes};
    run('renderJob(job)');
  };
  const finishDownload = async () => {
    download.resolve({ok: true, arrayBuffer: async () => new ArrayBuffer(8)});
    await tick(); await tick();
  };
  return {element, controls, document, requests, sources, run, sandbox, render, finishDownload,
    hide() { document.hidden = true; documentEvents.get('visibilitychange')(); },
    pagehide() { windowEvents.get('pagehide')(); }};
}

async function testWholeJobAndFullDownloadGatePlayback() {
  const h = harness();
  h.run('jobStarted=100;armAuto()');
  for (let count = 1; count <= 3; count++) {
    h.render({parts: Array.from({length: count}, (_, index) => ({index: index + 1, audio_url: `/part-${index}.wav`, duration: 1}))});
    await tick();
    assert.equal(h.requests.length, 0, 'ready sentences must not start a download or early playback');
    assert.equal(h.sources.length, 0);
    assert.equal(h.element('parts').children.length, 0, 'incomplete sentence controls must not be exposed');
    assert.equal(h.element('player').src, undefined);
  }
  h.render({status: 'completed'});
  assert.equal(h.requests.length, 0, 'completion without a merged URL is not playable');
  h.render({status: 'completed', audio_url: '/full.wav', duration: 3, delivery: 'pending', playback_ready_seconds: 5});
  assert.deepEqual(h.requests.map(request => request.url), ['/full.wav']);
  assert.equal(h.sources.length, 0, 'the full WAV must finish downloading before playback begins');
  assert.equal(h.element('metricFirst').textContent, '5.00 s');
  h.render({status: 'completed', audio_url: '/full.wav', duration: 3, delivery: 'playing'});
  assert.equal(h.requests.length, 1, 'device polling must not duplicate complete-file playback');
  await h.finishDownload();
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].buffer.duration, 3);
  h.sources[0].onended();
  assert.equal(h.element('player').src, '/full.wav', 'native controls remain available for replay');
  assert.equal(h.run('autoActive'), false);
  h.render({status: 'completed', audio_url: '/full.wav', duration: 3, delivery: 'delivered'});
  assert.equal(h.requests.length, 1, 'a completed playback must never restart on a later poll');
  assert.equal(h.element('player').plays, 0);
  h.element('player').currentTime = 3;
  h.run("setAudio('/full.wav',true)");
  assert.equal(h.element('player').currentTime, 0);
  assert.equal(h.element('player').plays, 1);
  h.element('player').pause();
  h.render({status: 'completed', audio_url: '/full.wav'});
  assert.equal(h.element('player').plays, 1, 'manual pause must persist through polling');
}

async function testStopHideAndManualSelectionCancelLateAutoplay() {
  for (const action of ['stop', 'hide', 'pagehide', 'manual']) {
    const h = harness();
    h.run('armAuto()');
    h.render({parts: [{index: 1, audio_url: '/early.wav', duration: 1}]});
    if (action === 'stop') h.element('stopStream').onclick();
    if (action === 'hide') h.hide();
    if (action === 'pagehide') h.pagehide();
    if (action === 'manual') h.element('player').emit('play');
    h.render({status: 'completed', audio_url: '/full.wav'});
    await tick();
    assert.equal(h.requests.length, 0, `${action} must cancel the deferred autoplay intent`);
    assert.equal(h.sources.length, 0);
  }
  const downloading = harness();
  downloading.run('armAuto()');
  downloading.render({status: 'completed', audio_url: '/full.wav'});
  downloading.hide();
  assert.equal(downloading.requests[0].signal.aborted, true, 'hiding must cancel the merged download');
  await downloading.finishDownload();
  assert.equal(downloading.sources.length, 0, 'a late download must not resume hidden playback');
  downloading.document.hidden = false;
  downloading.render({status: 'completed', audio_url: '/full.wav'});
  assert.equal(downloading.requests.length, 1, 'returning to the tab requires a fresh play gesture');
}

async function testExplicitReplayAndPlaybackFailureDoNotLoop() {
  const h = harness();
  h.render({status: 'completed', audio_url: '/full.wav'});
  assert.equal(h.requests.length, 0, 'opening a historical job must not trigger automatic playback');
  h.element('autoPlay').checked = true;
  h.element('autoPlay').emit('change');
  await h.finishDownload();
  h.sources[0].onended();
  h.element('autoPlay').emit('change');
  await tick(); await tick();
  assert.equal(h.requests.length, 2, 'an explicit user gesture can replay the same completed job');
  h.run('streamPlayer.stop()');
  h.controls.options.onError(new Error('autoplay denied'));
  h.render({status: 'completed', audio_url: '/full.wav'});
  assert.equal(h.requests.length, 2, 'a playback error must not trigger automatic retries on polling');
  assert.equal(h.element('player').src, '/full.wav');
  assert.match(h.element('toast').textContent, /点击播放器/);
}

async function testRequestContractAndPendingCheckboxCancellation() {
  const h = harness(), post = deferred();
  h.element('text').value = '这是一条完整语音';
  h.element('speed').value = '1'; h.element('language').value = 'Chinese';
  h.element('autoPlay').checked = true;
  h.sandbox.post = post.promise; h.sandbox.posts = [];
  h.run("api=(path,options)=>{posts.push({path,options});return post;};pollJob=()=>{};refreshStatus=()=>{};");
  const submission = h.run('submit()');
  assert.equal(h.sandbox.posts.length, 1, 'submission must not wait for the audio context');
  assert.equal(JSON.parse(h.sandbox.posts[0].options.body).playback_mode, 'complete');
  await h.run('submit()');
  assert.equal(h.sandbox.posts.length, 1, 'rapid re-entry must not duplicate a job');
  h.element('autoPlay').checked = false; h.element('autoPlay').emit('change');
  post.resolve({id: 'cached', status: 'completed', stage: '缓存命中', voice: 'Serena', audio_url: '/cached.wav', parts: []});
  await submission; await tick();
  assert.equal(h.requests.length, 0, 'turning autoplay off while the POST is pending must be respected');
  assert.equal(h.element('player').src, '/cached.wav');
}

(async () => {
  await testWholeJobAndFullDownloadGatePlayback();
  await testStopHideAndManualSelectionCancelLateAutoplay();
  await testExplicitReplayAndPlaybackFailureDoNotLoop();
  await testRequestContractAndPendingCheckboxCancellation();
  console.log('Web complete-file playback, download gating, repeat, lifecycle and request contract passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
