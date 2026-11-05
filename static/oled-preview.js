'use strict';
/* Standalone design simulation: no fetch, audio, TTS or device connection. */
const OLEDPreview = (() => {
  const FRAME_MS = 125;
  const MODES = ['buddy', 'wave', 'text'];
  const MODE_NAMES = {buddy: '声波伙伴', wave: '声波电台', text: '专注文字'};
  const STAGES = {
    idle: ['READY', '待机 · 安静陪伴'], queued: ['QUEUE', '排队 · 轮到我就出发'],
    thinking: ['THINK', '生成中 · 想好下一句话'], buffering: ['BUFFER', '缓冲 · 等声音接上'],
    playing: ['SPEAK', '播放 · 跟着模拟音量动起来'], finished: ['DONE', '完成 · 这句话说完啦'],
    stopped: ['STOP', '停止 · 先歇一会儿'], error: ['ERROR', '出错 · 等待重新开始']
  };
  const DEMO = [['queued', 1], ['thinking', 1.8], ['buffering', .8], ['playing', 4.8], ['finished', 1.6]];
  const DEFAULT_TEXT = '你好，欢迎来到语音实验室。今天也要保持好心情，去发现生活里的小美好。';

  function paginate(text, width) {
    const lines = ['']; let used = 0;
    for (const original of Array.from(String(text || '写点什么，让屏幕活起来。').slice(0, 300))) {
      if (original === '\r') continue;
      const char = original.codePointAt(0) > 0xffff ? '?' : original;
      const size = char.charCodeAt(0) > 255 ? 12 : 6;
      if (char === '\n' || used + size > width) { lines.push(''); used = 0; }
      if (char !== '\n') { lines[lines.length - 1] += char; used += size; }
    }
    const pages = [];
    for (let index = 0; index < lines.length; index += 3) pages.push(lines.slice(index, index + 3));
    return pages;
  }

  function amplitude(time, stage, volume) {
    if (stage !== 'playing' || volume <= 0) return 0;
    return volume / 100 * (.12 + .88 * Math.abs(Math.sin(time * 4.7)) * Math.abs(Math.cos(time * 2.1)));
  }

  function createController({render, now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout,
                             mode = 'buddy', text = DEFAULT_TEXT, reducedMotion = false, hidden = false}) {
    const state = {mode: MODES.includes(mode) ? mode : 'buddy', text, stage: 'idle', volume: 70,
      paused: reducedMotion, reducedMotion, hidden, time: 0, page: 0, pageElapsed: 0,
      demo: false, demoIndex: 0, stageElapsed: 0, playbackStarted: false};
    let pages = paginate(state.text, state.mode === 'text' ? 128 : 82);
    let timer = null, lastTick = now(), lastPaint = -Infinity, dirty = true, destroyed = false;
    const animated = () => !state.paused && !state.hidden && !destroyed;
    function startPlaybackIfNeeded() {
      if (state.stage === 'playing' && !state.playbackStarted) {
        state.playbackStarted = true; state.page = 0; state.pageElapsed = 0;
      }
    }
    function snapshot() { return {...state, pages, amplitude: amplitude(state.time, state.stage, state.volume)}; }
    function plan() {
      if (destroyed || state.hidden || timer !== null || (!dirty && !animated())) return;
      timer = schedule(tick, Math.max(0, FRAME_MS - (now() - lastPaint)));
    }
    function tick() {
      timer = null;
      if (destroyed || state.hidden) return;
      const at = now(), delta = animated() ? Math.max(0, at - lastTick) / 1000 : 0;
      lastTick = at;
      state.time += delta;
      if (animated()) {
        state.pageElapsed += delta;
        if (state.pageElapsed >= 3) {
          state.page = (state.page + Math.floor(state.pageElapsed / 3)) % pages.length;
          state.pageElapsed %= 3;
        }
        if (state.demo) {
          state.stageElapsed += delta;
          while (state.demo && state.stageElapsed >= DEMO[state.demoIndex][1]) {
            state.stageElapsed -= DEMO[state.demoIndex][1];
            if (state.demoIndex === DEMO.length - 1) state.demo = false;
            else { state.stage = DEMO[++state.demoIndex][0]; startPlaybackIfNeeded(); }
          }
        }
      }
      render(snapshot()); lastPaint = at; dirty = false;
      if (animated()) timer = schedule(tick, FRAME_MS);
    }
    function update(values) {
      if (destroyed) return;
      const wasAnimated = animated();
      if (values.mode !== undefined && !MODES.includes(values.mode)) throw new Error('Unknown OLED mode');
      if (values.stage !== undefined && !STAGES[values.stage]) throw new Error('Unknown OLED stage');
      const repaginate = values.mode !== undefined || values.text !== undefined;
      Object.assign(state, values);
      if (values.volume !== undefined) state.volume = Math.max(0, Math.min(100, Number(values.volume) || 0));
      if (repaginate) { pages = paginate(state.text, state.mode === 'text' ? 128 : 82); state.page = 0; state.pageElapsed = 0; }
      startPlaybackIfNeeded();
      if (wasAnimated !== animated()) lastTick = now();
      dirty = true;
      if (state.hidden && timer !== null) { cancel(timer); timer = null; }
      plan();
    }
    plan();
    return {
      snapshot,
      setMode: mode => update({mode}), setText: text => update({text}), setVolume: volume => update({volume}),
      setStage: stage => update({stage, demo: false, stageElapsed: 0,
        ...(['idle', 'queued', 'thinking'].includes(stage) ? {playbackStarted: false} : {})}),
      setHidden: hidden => update({hidden}),
      setReducedMotion(value) { update(value ? {reducedMotion: true, paused: true} : {reducedMotion: false}); },
      togglePause() { update({paused: !state.paused}); },
      nextPage() { update({page: (state.page + 1) % pages.length, pageElapsed: 0}); },
      toggleDemo() {
        if (state.demo) update({demo: false});
        else update({demo: true, demoIndex: 0, stageElapsed: 0, stage: DEMO[0][0], page: 0, pageElapsed: 0, playbackStarted: false});
      },
      destroy() { destroyed = true; if (timer !== null) cancel(timer); timer = null; }
    };
  }

  function drawScreen(canvas, state) {
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    function pixel(x, y, w = 1, h = 1) { ctx.fillRect(Math.round(x), Math.round(y), w, h); }
    function box(x, y, w, h) { pixel(x, y, w, 1); pixel(x, y + h - 1, w, 1); pixel(x, y, 1, h); pixel(x + w - 1, y, 1, h); }
    function label(text, x, baseline, size = 7) {
      ctx.font = `${size}px ${size === 12 ? 'SimSun, "Microsoft YaHei", sans-serif' : 'monospace'}`;
      ctx.textBaseline = 'alphabetic'; ctx.fillText(text, x, baseline);
    }
    label(STAGES[state.stage][0], 2, 10);
    const counter = `${state.page + 1}/${state.pages.length}`;
    label(counter, 126 - counter.length * 4.3, 10);
    pixel(0, 13, 128);
    if (state.mode !== 'text') pixel(43, 16, 1, 48);
    const lines = state.pages[state.page] || [];
    lines.forEach((line, index) => label(line, state.mode === 'text' ? 0 : 46, 29 + index * 16, 12));
    if (state.mode === 'buddy') {
      const playing = state.stage === 'playing', blink = Math.floor(state.time * 8) % 34 === 0 && state.stage === 'idle';
      // Integer coordinates and filled pixels keep the character readable at 1:1.
      box(7, 25, 29, 25); pixel(7, 22, 6); pixel(10, 20, 3, 2); pixel(30, 22, 6); pixel(30, 20, 3, 2);
      if (state.stage === 'error') {
        for (let i = 0; i < 5; i++) { pixel(12 + i, 32 + i); pixel(16 - i, 32 + i); pixel(26 + i, 32 + i); pixel(30 - i, 32 + i); }
      } else if (blink || ['finished', 'stopped'].includes(state.stage)) {
        pixel(12, 34, 5); pixel(26, 34, 5);
        if (state.stage === 'finished') { pixel(12, 33); pixel(16, 33); pixel(26, 33); pixel(30, 33); }
      } else { pixel(13, 32, 3, 4); pixel(27, 32, 3, 4); }
      const mouthHeight = playing ? 1 + Math.round(state.amplitude * 8) : 1;
      if (playing && state.amplitude > .07) box(18, 42, 8, mouthHeight + 1);
      else { pixel(19, 43, 6); if (state.stage === 'finished') { pixel(18, 42); pixel(25, 42); } }
      pixel(13, 51, 18); pixel(14, 52, 1, 8); pixel(29, 52, 1, 8); pixel(14, 59, 16);
      pixel(9, 61, 9); pixel(26, 61, 9);
      const lift = playing ? Math.round(state.amplitude * 6) : 0;
      pixel(7, 53 - lift, 7); pixel(30, 53 - lift, 7);
      if (['thinking', 'queued', 'buffering'].includes(state.stage)) {
        const active = Math.floor(state.time * 3) % 3;
        for (let i = 0; i < 3; i++) pixel(17 + i * 5, 18, i === active ? 2 : 1, i === active ? 2 : 1);
      } else if (state.stage === 'finished') {
        pixel(20, 17, 5); pixel(18, 19, 9); pixel(20, 20, 5); pixel(22, 22);
      } else if (state.stage === 'error') { label('!', 19, 22); }
    } else if (state.mode === 'wave') {
      pixel(4, 53, 35);
      for (let i = 0; i < 8; i++) {
        const energy = state.amplitude * (.35 + .65 * Math.abs(Math.sin(state.time * 5 + i * 1.7)));
        const height = 1 + Math.round(energy * 28);
        pixel(5 + i * 4, 51 - height, 2, height);
      }
      label(state.stage === 'playing' ? 'V' + state.volume : STAGES[state.stage][0], 5, 63, 6);
    }
    // Browser text rasterization is antialiased. Threshold once so the logical
    // display contains exactly black/white pixels, like a 1-bit OLED framebuffer.
    const frame = ctx.getImageData(0, 0, 128, 64);
    for (let i = 0; i < frame.data.length; i += 4) {
      const bit = frame.data[i] >= 128 ? 255 : 0;
      frame.data[i] = frame.data[i + 1] = frame.data[i + 2] = bit; frame.data[i + 3] = 255;
    }
    ctx.putImageData(frame, 0, 0);
  }

  function mount(document, window) {
    const $ = id => document.getElementById(id), motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const query = new URLSearchParams(window.location.search), initialMode = query.get('mode');
    const mode = MODES.includes(initialMode) ? initialMode : 'buddy';
    const radios = Array.from(document.querySelectorAll('input[name="mode"]'));
    radios.forEach(radio => { radio.checked = radio.value === mode; });
    let lastDescription = '';
    const controller = createController({mode, text: $('previewText').value,
      reducedMotion: motion.matches, hidden: document.hidden,
      render(state) {
        drawScreen($('oledScreen'), state);
        $('modeName').textContent = MODE_NAMES[state.mode];
        $('stage').value = state.stage;
        const description = STAGES[state.stage][1];
        if (description !== lastDescription) { $('stageDescription').textContent = description; lastDescription = description; }
        $('oledScreen').setAttribute('aria-label', `${$('modeName').textContent}，${description}，文字第${state.page + 1}页，共${state.pages.length}页；动画模拟`);
        $('pageLabel').textContent = `${state.page + 1} / ${state.pages.length}`;
        $('nextPage').disabled = state.pages.length < 2;
        $('volumeValue').textContent = state.volume + '%';
        $('amplitudeMeter').value = state.amplitude; $('amplitudeValue').textContent = Math.round(state.amplitude * 100) + '%';
        $('layoutNote').textContent = (state.mode === 'text' ? '全屏中文 3 行；' : '左侧角色或波形，右侧中文 3 行；') + '首次进入播放回到第一页，再每 3 秒轮播。';
        $('pause').textContent = state.paused ? '继续动画' : '暂停动画';
        $('pause').setAttribute('aria-pressed', String(state.paused));
        $('demo').textContent = state.demo ? '■ 停止流程演示' : '▶ 演示一次完整流程';
        $('demo').setAttribute('aria-pressed', String(state.demo));
        $('motionNote').textContent = state.paused ? (state.reducedMotion ? '已遵循系统“减少动态”设置，动画暂停。可手动继续或逐项切换阶段。' : '动画已暂停；仍可切换主题、阶段和文字页。') : '动画上限 8 帧/秒；切到其他标签页自动暂停。';
      }});
    radios.forEach(radio => radio.addEventListener('change', () => { if (radio.checked) controller.setMode(radio.value); }));
    $('stage').addEventListener('change', () => controller.setStage($('stage').value));
    $('volume').addEventListener('input', () => controller.setVolume($('volume').value));
    $('previewText').addEventListener('input', () => controller.setText($('previewText').value));
    $('nextPage').addEventListener('click', () => controller.nextPage());
    $('pause').addEventListener('click', () => controller.togglePause());
    $('demo').addEventListener('click', () => controller.toggleDemo());
    document.addEventListener('visibilitychange', () => controller.setHidden(document.hidden));
    const changeMotion = event => controller.setReducedMotion(event.matches);
    if (motion.addEventListener) motion.addEventListener('change', changeMotion);
    else if (motion.addListener) motion.addListener(changeMotion);
    window.addEventListener('pagehide', () => controller.setHidden(true));
    window.addEventListener('pageshow', () => controller.setHidden(document.hidden));
    return controller;
  }
  return {FRAME_MS, MODES, MODE_NAMES, STAGES, paginate, amplitude, createController, drawScreen, mount};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = OLEDPreview;
if (typeof document !== 'undefined') OLEDPreview.mount(document, window);
