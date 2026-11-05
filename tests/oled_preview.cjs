const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const OLED = require('../static/oled-preview');

function clockHarness(options = {}) {
  let time = 0, sequence = 0;
  const pending = new Map(), frames = [];
  const controller = OLED.createController({
    ...options, now: () => time, render: state => frames.push({at: time, ...state}),
    schedule(fn, delay) { pending.set(++sequence, {at: time + delay, fn}); return sequence; },
    cancel(id) { pending.delete(id); }
  });
  function advance(duration) {
    const until = time + duration;
    for (let guard = 0; guard < 10000; guard++) {
      const next = [...pending].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { time = until; return; }
      pending.delete(next[0]); time = next[1].at; next[1].fn();
    }
    throw new Error('Animation timer did not settle');
  }
  return {controller, frames, pending, advance};
}

function testPixelPaginationAndTextModeCapacity() {
  const text = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一'.repeat(2);
  const side = OLED.paginate(text, 82), full = OLED.paginate(text, 128);
  assert.equal(side[0][0], '一二三四五六');
  assert.equal(full[0][0], '一二三四五六七八九十');
  assert.ok(side.every(page => page.length <= 3));
  assert.equal(side.flat().join(''), text); assert.equal(full.flat().join(''), text);
  assert.ok(side.length > full.length, 'text mode must use the full screen width');
  assert.deepEqual(OLED.paginate('第一行\n第二行\n第三行\n第四行', 82), [['第一行', '第二行', '第三行'], ['第四行']]);
  assert.equal(OLED.paginate('🌞你好', 82)[0][0], '?你好');
}

function testEightFpsAndFrequentControlChanges() {
  const h = clockHarness(); h.advance(1000);
  assert.equal(h.frames.length, 9, 'initial frame + at most 8 animation frames per second');
  for (let i = 1; i < h.frames.length; i++) assert.ok(h.frames[i].at - h.frames[i - 1].at >= 125);
  for (let i = 0; i < 100; i++) { h.controller.setVolume(i); h.advance(10); }
  assert.ok(h.frames.length <= 17, 'slider events must not bypass the 8fps drawing limit');
  assert.equal(h.controller.snapshot().time, 2, 'editing controls must not slow the demonstration clock');
  h.controller.destroy(); assert.equal(h.pending.size, 0); h.advance(3000);
  assert.ok(h.frames.length <= 17);
}

function testPauseHiddenAndReducedMotion() {
  const h = clockHarness(); h.advance(300);
  const before = h.controller.snapshot().time, count = h.frames.length;
  h.controller.setHidden(true); assert.equal(h.pending.size, 0); h.advance(8000);
  assert.equal(h.frames.length, count, 'hidden tabs must do no animation work');
  h.controller.setHidden(false); h.advance(0);
  assert.equal(h.controller.snapshot().time, before, 'returning to a tab must not jump by hidden time');
  h.controller.togglePause(); h.advance(500);
  const pausedAt = h.controller.snapshot().time, pausedCount = h.frames.length;
  h.advance(2000); assert.equal(h.frames.length, pausedCount); assert.equal(h.controller.snapshot().time, pausedAt);
  h.controller.setStage('playing'); h.advance(125); assert.equal(h.frames.at(-1).stage, 'playing');
  assert.equal(h.controller.snapshot().time, pausedAt, 'manual stage selection must work without restarting motion');
  const reduced = clockHarness({reducedMotion: true}); reduced.advance(1000);
  assert.equal(reduced.frames.length, 1); assert.equal(reduced.controller.snapshot().paused, true);
  reduced.controller.togglePause(); reduced.advance(500); assert.ok(reduced.frames.length > 1);
  reduced.controller.setReducedMotion(true); reduced.advance(500);
  const reducedCount = reduced.frames.length; reduced.advance(1000); assert.equal(reduced.frames.length, reducedCount);
}

function testStagesDemoAmplitudeAndManualPaging() {
  const h = clockHarness({text: '你好'.repeat(30)}); h.advance(0);
  assert.deepEqual(Object.keys(OLED.STAGES), ['idle', 'queued', 'thinking', 'buffering', 'playing', 'finished', 'stopped', 'error']);
  h.controller.toggleDemo(); h.advance(1000); assert.equal(h.controller.snapshot().stage, 'thinking');
  h.advance(2000); assert.equal(h.controller.snapshot().stage, 'buffering');
  h.advance(1000); assert.equal(h.controller.snapshot().stage, 'playing');
  assert.ok(h.controller.snapshot().amplitude > 0);
  h.controller.setVolume(0); assert.equal(h.controller.snapshot().amplitude, 0);
  h.controller.setVolume(1000); assert.equal(h.controller.snapshot().volume, 100);
  h.advance(7000); assert.equal(h.controller.snapshot().stage, 'finished'); assert.equal(h.controller.snapshot().demo, false);
  h.controller.setStage('error'); assert.equal(h.controller.snapshot().amplitude, 0);
  h.controller.togglePause(); h.advance(125);
  const page = h.controller.snapshot().page; h.controller.nextPage(); h.advance(125);
  assert.equal(h.controller.snapshot().page, (page + 1) % h.controller.snapshot().pages.length);
  h.controller.setMode('text'); assert.equal(h.controller.snapshot().page, 0);
  assert.throws(() => h.controller.setMode('invalid')); assert.throws(() => h.controller.setStage('invalid'));
}

function testFirstPlaybackResetsPageButBufferResumeDoesNot() {
  const h = clockHarness({text: '你好'.repeat(30)}); h.advance(3500);
  assert.equal(h.controller.snapshot().page, 1);
  h.controller.setStage('playing'); assert.equal(h.controller.snapshot().page, 0);
  h.advance(3000); assert.equal(h.controller.snapshot().page, 1);
  h.controller.setStage('buffering'); h.advance(125);
  h.controller.setStage('playing'); assert.equal(h.controller.snapshot().page, 1, 'buffer resume belongs to the same utterance');
  h.controller.toggleDemo(); h.advance(4000);
  assert.equal(h.controller.snapshot().stage, 'playing'); assert.equal(h.controller.snapshot().page, 0);
}

function testOneBitRenderingAndFirmwareCoordinates() {
  const textCalls = [];
  const frame = {data: new Uint8ClampedArray(128 * 64 * 4)};
  for (let i = 0; i < frame.data.length; i += 4) frame.data[i] = i % 2 ? 100 : (i % 12 ? 127 : 200);
  const context = {fillRect() {}, fillText(...args) { textCalls.push(args); }, getImageData() { return frame; }, putImageData() {}};
  const canvas = {getContext: () => context};
  const state = {mode: 'buddy', stage: 'playing', page: 0, pages: [['第一行', '第二行', '第三行']], time: 2, volume: 70, amplitude: .5};
  OLED.drawScreen(canvas, state);
  assert.deepEqual(textCalls.slice(-3), [['第一行', 46, 29], ['第二行', 46, 45], ['第三行', 46, 61]]);
  for (let i = 0; i < frame.data.length; i += 4) {
    assert.ok(frame.data[i] === 0 || frame.data[i] === 255);
    assert.equal(frame.data[i], frame.data[i + 1]); assert.equal(frame.data[i], frame.data[i + 2]); assert.equal(frame.data[i + 3], 255);
  }
  textCalls.length = 0; OLED.drawScreen(canvas, {...state, mode: 'text'});
  assert.deepEqual(textCalls.slice(-3), [['第一行', 0, 29], ['第二行', 0, 45], ['第三行', 0, 61]]);
  for (const stage of Object.keys(OLED.STAGES)) for (const mode of OLED.MODES) OLED.drawScreen(canvas, {...state, stage, mode});
}

async function testMainFormSendsOnlyDisplayMetadata() {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, {value: '', dataset: {}, checked: false, addEventListener() {}, pause() {}, classList: {add() {}, remove() {}, toggle() {}}}); return elements.get(id); };
  class Player {stop() {} setVolume() {}}
  const sandbox = {StreamAudioPlayer: Player, AbortController, performance: {now: () => 0},
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, console,
    document: {getElementById: element, querySelectorAll: () => [], addEventListener() {}}};
  vm.createContext(sandbox);
  let source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  source = source.slice(0, source.lastIndexOf('\nupdateCount();drawWave(null);'));
  vm.runInContext(source, sandbox);
  element('text').value = '你好'; element('speed').value = '1'; element('language').value = 'Chinese';
  const bodies = [];
  sandbox.observe = options => { bodies.push(JSON.parse(options.body)); throw new Error('test stops after request'); };
  for (const mode of ['buddy', 'wave', 'text', '']) {
    element('displayMode').value = mode;
    await vm.runInContext("api=async(_path,options)=>observe(options);submit()", sandbox);
  }
  assert.deepEqual(bodies.map(body => body.display_mode), ['buddy', 'wave', 'text', 'buddy']);
  assert.ok(bodies.every(body => body.voice === 'Serena' && body.speed === 1 && body.text === '你好'));
  element('displayMode').value = 'wave'; vm.runInContext('updateDisplayMode()', sandbox);
  assert.equal(element('oledPreviewLink').href, '/oled-preview.html?mode=wave');
}

(async () => {
  testPixelPaginationAndTextModeCapacity(); testEightFpsAndFrequentControlChanges(); testPauseHiddenAndReducedMotion();
  testStagesDemoAmplitudeAndManualPaging(); testFirstPlaybackResetsPageButBufferResumeDoesNot(); testOneBitRenderingAndFirmwareCoordinates(); await testMainFormSendsOnlyDisplayMetadata();
  const html = fs.readFileSync(path.join(__dirname, '../static/oled-preview.html'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  assert.deepEqual(OLED.MODE_NAMES, {buddy: '声波伙伴', wave: '声波电台', text: '专注文字'});
  for (const name of Object.values(OLED.MODE_NAMES)) { assert.ok(html.includes(name)); assert.ok(main.includes(name)); }
  for (const asset of ['oled-preview.js', 'oled-preview.css']) assert.ok(html.includes(asset));
  assert.ok(!/fetch\s*\(|AudioContext|WebSocket/.test(fs.readFileSync(path.join(__dirname, '../static/oled-preview.js'), 'utf8')));
  console.log('OLED preview: pixel layout, one-bit frame, 8fps, pause/visibility/reduced-motion, demo and submission passed.');
})().catch(error => {console.error(error); process.exitCode = 1;});
