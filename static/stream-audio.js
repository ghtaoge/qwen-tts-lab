/* Ordered, prefetched WAV playback. Web Audio schedules adjacent chunks on one clock. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StreamAudioPlayer = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  return class StreamAudioPlayer {
    constructor(options = {}) {
      this.options = options;
      this.epoch = 0;
      this.active = false;
      this.sources = new Set();
      this.controllers = new Set();
      this.timeouts = new Set();
    }
    static decodePcmWav(context, data) {
      if (!context.createBuffer || !(data instanceof ArrayBuffer) || data.byteLength < 44) return null;
      try {
        const view = new DataView(data);
        const tag = offset => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
        if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
        const end = view.getUint32(4, true) + 8;
        if (end > data.byteLength || end < 44) return null;
        let format = null, audio = null;
        for (let offset = 12; offset + 8 <= end;) {
          const kind = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8;
          if (start + size > end) return null;
          if (kind === 'fmt ') {
            if (format) return null;
            if (size < 16) return null;
            format = { codec: view.getUint16(start, true), channels: view.getUint16(start + 2, true), rate: view.getUint32(start + 4, true), align: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true) };
          } else if (kind === 'data') {
            if (audio) return null;
            audio = { start, size };
          }
          offset = start + size + (size & 1);
        }
        if (!format || !audio || format.codec !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels) || format.rate < 8000 || format.rate > 48000 || format.align !== format.channels * 2 || !audio.size || audio.size % format.align) return null;
        const frames = audio.size / format.align, buffer = context.createBuffer(format.channels, frames, format.rate);
        for (let channel = 0; channel < format.channels; channel++) {
          const samples = buffer.getChannelData(channel);
          for (let frame = 0; frame < frames; frame++) samples[frame] = view.getInt16(audio.start + frame * format.align + channel * 2, true) / 32768;
        }
        return buffer;
      } catch (_) { return null; } // Other valid WAV formats retain native decoding.
    }
    async start() {
      this.stop();
      const epoch = this.epoch;
      try {
        const AudioContext = this.options.AudioContext || window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) throw new Error('当前浏览器不支持 Web Audio，请使用原生播放器试听');
        this.context = new AudioContext();
        this.gain = this.context.createGain();
        this.gain.connect(this.context.destination);
        this.gain.gain.value = this.volume == null ? 0.8 : this.volume;
        this.active = true;
        this.resumed = false;
        this.parts = [];
        this.seen = new Set();
        this.ready = new Map();
        this.pending = [];
        this.inFlight = 0;
        this.next = 0;
        this.nextTime = 0;
        this.finished = false;
        this.firstScheduled = false;
        await this.context.resume();
        if (epoch !== this.epoch) return;
        this.resumed = true;
        this.options.onState?.('waiting');
        this.schedule();
      } catch (error) {
        if (epoch === this.epoch) this.fail(error);
      }
    }
    setVolume(value) {
      this.volume = value;
      if (this.gain) this.gain.gain.value = value;
    }
    update(parts, finished = false) {
      if (!this.active) return;
      const source = parts || [];
      const prefix = source.length >= this.parts.length && (!this.parts.length || source[this.parts.length - 1]?.audio_url === this.parts[this.parts.length - 1].audio_url);
      for (let index = prefix ? this.parts.length : 0; index < source.length; index++) {
        const part = source[index];
        if (this.seen.has(part.audio_url)) continue;
        this.seen.add(part.audio_url);
        const position = this.parts.length;
        this.parts.push(part);
        this.pending.push({ part, position });
      }
      this.finished = finished;
      this.prefetch();
      this.schedule();
    }
    prefetch() {
      while (this.active && this.inFlight < 2 && this.pending.length) {
        const buffered = Math.max(0, this.nextTime - this.context.currentTime) + Array.from(this.ready.values()).reduce((sum, buffer) => sum + buffer.duration, 0);
        // Keep one future clip even when a single sentence is longer than the
        // time budget, so its HTTP request need not wait for the current end.
        if (buffered >= (this.options.bufferAheadSeconds ?? 3) && this.sources.size + this.ready.size + this.inFlight >= 2) break;
        const item = this.pending.shift(), epoch = this.epoch;
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => {
          controller.abort();
          if (epoch === this.epoch && this.active) this.fail(new Error('音频片段下载超时，请检查服务连接后重新试听'));
        }, this.options.fetchTimeoutMs ?? 10000);
        this.timeouts.add(timer);
        this.inFlight++;
        const context = this.context;
        (async () => {
          const response = await (this.options.fetch || fetch)(item.part.audio_url, { signal: controller.signal });
          if (!response.ok) throw new Error(`音频片段下载失败（${response.status}）`);
          const data = await response.arrayBuffer();
          const buffer = StreamAudioPlayer.decodePcmWav(context, data) || await context.decodeAudioData(data);
          if (epoch !== this.epoch || !this.active) return;
          this.ready.set(item.position, buffer);
          this.schedule();
        })().catch(error => {
          if (epoch === this.epoch && this.active && error.name !== 'AbortError') this.fail(error);
        }).finally(() => {
          clearTimeout(timer);
          this.timeouts.delete(timer);
          if (epoch !== this.epoch) return;
          this.controllers.delete(controller);
          this.inFlight--;
          this.prefetch();
        });
      }
    }
    schedule() {
      if (!this.active || !this.resumed) return;
      while (this.ready.has(this.next)) {
        const buffer = this.ready.get(this.next);
        this.ready.delete(this.next);
        const context = this.context, epoch = this.epoch;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gain);
        // AudioBufferSources share a clock, avoiding a media-element reload at each boundary.
        const at = Math.max(this.nextTime, context.currentTime + 0.025);
        this.nextTime = at + buffer.duration;
        const part = this.parts[this.next++];
        this.sources.add(source);
        source.onended = () => {
          source.disconnect?.();
          this.sources.delete(source);
          if (epoch !== this.epoch || !this.active) return;
          this.prefetch();
          if (!this.sources.size) {
            if (this.finished && this.next >= this.parts.length && !this.inFlight && !this.pending.length) this.complete();
            else this.options.onState?.('waiting');
          }
        };
        source.start(at);
        if (!this.firstScheduled) {
          this.firstScheduled = true;
          this.options.onFirstAudio?.(Math.max(0, at - context.currentTime));
        }
        this.options.onState?.('playing', part.index, this.parts.length);
      }
      if (this.finished && !this.sources.size && this.next >= this.parts.length && !this.inFlight && !this.pending.length) this.complete();
    }
    complete() {
      if (!this.active) return;
      this.active = false;
      this.resumed = false;
      this.options.onState?.('completed');
      const context = this.context;
      this.context = null;
      this.gain = null;
      context?.close().catch(() => {});
    }
    fail(error) {
      this.stop();
      this.options.onError?.(error);
    }
    stop() {
      this.epoch++;
      this.active = false;
      this.resumed = false;
      for (const controller of this.controllers) controller.abort();
      this.controllers.clear();
      for (const timer of this.timeouts) clearTimeout(timer);
      this.timeouts.clear();
      for (const source of this.sources) {
        source.onended = null;
        try { source.stop(); } catch (_) {}
        source.disconnect?.();
      }
      this.sources.clear();
      this.ready?.clear();
      this.pending = [];
      this.context?.close().catch(() => {});
      this.context = null;
      this.gain = null;
    }
  };
});
