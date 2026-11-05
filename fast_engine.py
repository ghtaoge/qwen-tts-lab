"""Qwen3-TTS 0.6B accelerated streaming adapter.

The official model's Talker/Predictor weights are converted to GGUF. The codec
remains the official Qwen decoder (stateful CUDA/CPU wrapper), not another TTS.
All third-party code and converted weights live under acceleration/.
"""
from __future__ import annotations

import gc
import os
import secrets
import subprocess
import sys
import time
import traceback
import atexit
import ctypes
import hashlib
from multiprocessing.connection import Listener, Client
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'acceleration' / 'Qwen3-TTS-GGUF'
ASSETS = ROOT / 'acceleration' / 'model-custom-small'
MODEL = ROOT / 'models' / 'Qwen3-TTS-12Hz-0.6B-CustomVoice'
EXTRA_SITE = ROOT / 'acceleration' / '.venv-fast' / 'Lib' / 'site-packages'


def assets_ready() -> bool:
    files = [ASSETS / 'qwen3_tts_talker.q5_k.gguf', ASSETS / 'qwen3_tts_predictor.q8_0.gguf',
             ASSETS / 'tokenizer.json', ASSETS / 'embeddings' / 'text_embedding_projected.npy',
             SOURCE / 'qwen3_tts_gguf' / 'inference' / 'bin' / 'llama.dll',
             SOURCE / 'qwen3_tts_gguf' / 'export' / 'codec_export.py',
             EXTRA_SITE / 'gguf' / '__init__.py',
             MODEL / 'speech_tokenizer' / 'model.safetensors']
    files += [ASSETS / 'embeddings' / f'codec_embedding_{index}.npy' for index in range(16)]
    return all(path.is_file() and path.stat().st_size > 0 for path in files)


def _import_paths():
    # Append dependency site after the normal venv: do not shadow its CUDA torch
    # with the isolated CPU torch used only for exporting weights.
    if str(SOURCE) not in sys.path:
        sys.path.insert(0, str(SOURCE))
    if str(EXTRA_SITE) not in sys.path:
        sys.path.append(str(EXTRA_SITE))


class FastQwenEngine:
    backend_name = 'gguf-vulkan-stateful-codec'

    def __init__(self, state_callback=None):
        self._state_callback = state_callback or (lambda **kwargs: None)
        self.parts = None
        self.stream = None
        self.decoder = None
        self.device = None
        self.precision = 'Q5_K / Q8_0'
        self.torch = None
        self.worker = None
        self.connection = None
        self.last_profile = None
        self.host_valid = os.environ.get('TTS_FAST_HOST_VALID', '0') == '1'
        self.chunk_frames = max(8, int(os.environ.get('TTS_FAST_CHUNK_FRAMES', '8')))

    def ensure_loaded(self):
        try:
            self._load()
        except Exception as error:
            self.close()
            self._state_callback(state='error', message='Qwen 加速模型加载失败', error=str(error))
            raise

    def _load(self):
        if self.stream is not None:
            return
        if not assets_ready():
            raise RuntimeError('Qwen 加速资产尚未准备好，请运行 tools/prepare_fast_engine.py。')
        _import_paths()
        self._state_callback(state='loading', message='正在加载 Qwen GGUF 加速模型', error=None)
        started = time.perf_counter()
        import numpy as np
        import torch
        from qwen3_tts_gguf.export.codec_export import StatefulDecoderDynamoCombined
        from qwen3_tts_gguf.export.tokenizer_12hz.modeling_qwen3_tts_tokenizer_v2 import Qwen3TTSTokenizerV2Model

        self.torch = torch
        torch.set_num_threads(min(4, os.cpu_count() or 2))
        use_gpu = os.environ.get('TTS_DEVICE', 'auto') != 'cpu'
        self.device = 'cuda:0' if use_gpu and torch.cuda.is_available() else 'cpu'
        self.codec_dtype = torch.bfloat16 if self.device.startswith('cuda') and torch.cuda.is_bf16_supported() else torch.float32
        # Windows Vulkan binaries and PyTorch use different OpenMP runtimes.
        # Process isolation avoids an unsafe duplicate-runtime environment flag.
        auth = secrets.token_bytes(24)
        listener = Listener(('127.0.0.1', 0), authkey=auth)
        port = listener.address[1]
        log_dir = ROOT / 'logs'
        log_dir.mkdir(exist_ok=True)
        with (log_dir / 'fast-worker.log').open('a', encoding='utf-8') as log:
            self.worker = subprocess.Popen(
                [sys.executable, '-u', str(Path(__file__).resolve()), '--worker', str(port), auth.hex()],
                cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        atexit.register(self.close)
        # Listener's public API has no timeout; constrain its listening socket.
        listener._listener._socket.settimeout(60)
        try:
            self.connection = listener.accept()
        finally:
            listener.close()
        if not self.connection.poll(120):
            self.close()
            raise RuntimeError('Qwen 原生加速进程加载超时，请查看 logs/fast-worker.log。')
        kind, payload = self.connection.recv()
        if kind != 'ready':
            self.close()
            raise RuntimeError(f'Qwen 原生加速进程加载失败：{payload}')
        codec = Qwen3TTSTokenizerV2Model.from_pretrained(str(MODEL / 'speech_tokenizer'), local_files_only=True)
        codec.config.decoder_config._attn_implementation = 'eager'
        codec.decoder.pre_transformer.config._attn_implementation = 'eager'
        self.decoder = StatefulDecoderDynamoCombined(codec.decoder).eval().to(self.device, dtype=self.codec_dtype)
        self.codec_layers = self.decoder.num_layers
        self.codec_heads = codec.config.decoder_config.num_key_value_heads
        self.codec_dim = codec.config.decoder_config.head_dim
        del codec
        gc.collect()
        self.stream = True
        self.precision = f'Q5_K / Q8_0 · codec {str(self.codec_dtype).split(".")[-1]}'
        self._state_callback(state='ready', message='Qwen 加速模型已加载', device='Vulkan + ' + self.device,
                             precision=self.precision, load_seconds=round(time.perf_counter() - started, 3), error=None)

    def _initial_codec_state(self):
        torch = self.torch
        kwargs = dict(device=self.device, dtype=self.codec_dtype)
        return [torch.zeros(1, 512, 0, **kwargs), torch.zeros(1, 1024, 0, **kwargs),
                torch.zeros(1, 1024, 0, **kwargs)] + [
                    torch.zeros(1, self.codec_heads, 0, self.codec_dim, **kwargs)
                    for _ in range(self.codec_layers * 2)]

    def _decode(self, frames, state, final):
        import numpy as np
        torch = self.torch
        codes = torch.as_tensor(np.asarray(frames), dtype=torch.long, device=self.device).unsqueeze(0)
        pre, latent, conv, *kv = state
        is_final = torch.tensor([1.0 if final else 0.0], dtype=self.codec_dtype, device=self.device)
        with torch.inference_mode():
            out = self.decoder(codes, pre, latent, conv, is_final, *kv)
        # The output count depends only on known tensor shapes, not their data.
        # Kept as an opt-in A/B switch; measured benefit was within run variance.
        valid = (max(0, latent.shape[-1] + len(frames) - (0 if final else 4)) *
                 self.decoder.part3.samples_per_frame) if self.host_valid else int(out[1][0].item())
        wave = out[0][0] if final else out[0][0, :valid]
        return wave.float().cpu().numpy(), list(out[2:])

    def generate_stream(self, text, voice, language, event):
        self.ensure_loaded()
        import numpy as np
        if event.is_set():
            return
        self.connection.send(dict(command='generate', text=text, voice=voice, language=language,
                                  chunk_frames=self.chunk_frames))
        state = self._initial_codec_state()
        previous = time.perf_counter()
        cancelled = False
        finished = False
        try:
            with self.torch.inference_mode():
                while True:
                    if event.is_set() and not cancelled:
                        self.connection.send(dict(command='cancel'))
                        cancelled = True
                    if not self.connection.poll(.1):
                        if self.worker.poll() is not None:
                            raise RuntimeError('Qwen 原生加速进程已退出，请查看 logs/fast-worker.log。')
                        continue
                    kind, payload = self.connection.recv()
                    if kind == 'done':
                        self.last_profile = payload
                        finished = True
                        return
                    if kind == 'error':
                        finished = True
                        raise RuntimeError(payload)
                    if cancelled:
                        continue
                    if kind == 'codes':
                        frames, final = payload
                        audio, state = self._decode(frames, state, final)
                    elif kind == 'flush' and state[1].shape[-1]:
                        zero = self.torch.zeros(1, 1024, 0, dtype=self.codec_dtype, device=self.device)
                        last = self.torch.ones(1, dtype=self.codec_dtype, device=self.device)
                        wave, valid, _, _ = self.decoder.part3(zero, state[1], state[2], last)
                        audio = wave[0, :int(valid[0].item())].float().cpu().numpy()
                    else:
                        audio = np.empty(0, dtype=np.float32)
                    if audio.size:
                        yield audio, 24000, time.perf_counter() - previous, None
                        previous = time.perf_counter()
        finally:
            if not finished and self.connection is not None:
                # Drain this request before accepting another; prevents mixed audio
                # when the HTTP consumer closes a generator during cancellation.
                self.connection.send(dict(command='cancel'))
                deadline = time.perf_counter() + 15
                drained = False
                while time.perf_counter() < deadline:
                    if self.connection.poll(.1):
                        kind, _ = self.connection.recv()
                        if kind in {'done', 'error'}:
                            drained = True
                            break
                    if self.worker.poll() is not None:
                        break
                if not drained:
                    self.close()

    def close(self):
        if self.worker is not None and self.worker.poll() is None:
            self.worker.terminate()
            try:
                self.worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.worker.kill()
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        self.stream = None
        self.decoder = None

    def configure_for_benchmark(self, **options):
        """Internal single-worker A/B control, never exposed as a network route."""
        self.ensure_loaded()
        self.host_valid = options.pop('host_valid', self.host_valid)
        attention = options.pop('codec_attention', None)
        if attention:
            self.decoder.part2.trans.config._attn_implementation = attention
        self.connection.send(dict(command='configure', options=options))
        kind, payload = self.connection.recv()
        if kind != 'configured':
            raise RuntimeError(str(payload))
        return payload

    def generate(self, text, voice, language, event):
        import numpy as np
        samples = []
        elapsed = 0.0
        for audio, rate, delta, _ in self.generate_stream(text, voice, language, event):
            samples.append(audio)
            elapsed += delta
        if not samples:
            if event.is_set():
                return np.empty(0, dtype=np.float32), 24000, elapsed, None
            raise RuntimeError('Qwen 加速模型没有生成有效音频。')
        return np.concatenate(samples), 24000, elapsed, None


def _inference_worker(port, auth_hex):
    """Native model owner. Deliberately never imports torch in this process."""
    _import_paths()
    conn = Client(('127.0.0.1', int(port)), authkey=bytes.fromhex(auth_hex))
    try:
        from tokenizers import Tokenizer
        from qwen3_tts_gguf.inference import llama
        from qwen3_tts_gguf.inference.assets import AssetsManager
        from qwen3_tts_gguf.inference.stream import TTSStream
        from qwen3_tts_gguf.inference.config import TTSConfig
        from qwen3_tts_gguf.inference.schema.constants import map_language
        from qwen3_tts_gguf.inference.schema.result import Timing
        llama.LOGS = False
        use_gpu = os.environ.get('TTS_DEVICE', 'auto') != 'cpu'
        parts = SimpleNamespace(
            assets=AssetsManager(str(ASSETS)), tokenizer=Tokenizer.from_file(str(ASSETS / 'tokenizer.json')),
            talker_model=llama.LlamaModel(ASSETS / 'qwen3_tts_talker.q5_k.gguf', n_gpu_layers=-1, use_gpu=use_gpu),
            predictor_model=llama.LlamaModel(ASSETS / 'qwen3_tts_predictor.q8_0.gguf', n_gpu_layers=-1, use_gpu=use_gpu),
            decoder=None, chunk_size=8)
        stream = TTSStream(parts, n_ctx=2048)
        tuning = _WorkerTuning(llama, stream)
        conn.send(('ready', None))
        while True:
            request = conn.recv()
            if request['command'] == 'configure':
                conn.send(('configured', tuning.configure(request['options'])))
                continue
            if request['command'] != 'generate':
                continue
            tuning.begin()
            stream.talker.clear_memory()
            try:
                text, voice = request['text'], request['voice']
                lang = request['language'].lower()
                if lang in {'chinese', 'auto'}:
                    lang = {'dylan': 'beijing_dialect', 'eric': 'sichuan_dialect'}.get(voice.lower(), lang)
                pdata = stream.prompt_builder.build_custom_prompt(
                    text, voice, None if lang == 'auto' else map_language(lang), None)
                cfg = TTSConfig(max_steps=min(2048, max(200, len(text) * 20)), seed=42, sub_seed=45,
                                streaming=True, temperature=.9, sub_temperature=.9)
                frames, total, cancelled = [], 0, False
                generator = stream._run_engine_loop_gen(pdata, cfg, Timing())
                for codes, _ in generator:
                    if conn.poll():
                        message = conn.recv()
                        if message['command'] == 'cancel':
                            generator.close()
                            cancelled = True
                            break
                    frames.append(codes)
                    tuning.observe(codes)
                    total += 1
                    if len(frames) >= request['chunk_frames']:
                        tuning.send(conn, ('codes', (frames, False)))
                        frames = []
                if not cancelled:
                    if total >= cfg.max_steps:
                        raise RuntimeError('Qwen 加速推理超过最大生成时长，请缩短文本重试。')
                    tuning.send(conn, ('codes', (frames, True)) if frames else ('flush', None))
                conn.send(('done', tuning.finish()))
            except Exception:
                conn.send(('error', traceback.format_exc()))
            finally:
                stream.talker.clear_memory()
    except Exception:
        conn.send(('error', traceback.format_exc()))
    finally:
        conn.close()


class _WorkerTuning:
    """Measured, optional native optimizations without editing pinned source."""

    def __init__(self, llama, stream):
        import numpy as np
        self.llama, self.stream, self.np = llama, stream, np
        enabled = os.environ.get('TTS_FAST_OPTIMIZE', '1') != '0'
        self.options = dict(metadata_only=enabled, bounded_sampler=enabled,
                            profile=os.environ.get('TTS_FAST_PROFILE', '0') == '1')
        self.predictor_vocab_size = llama.llama_vocab_n_tokens(stream.engine.predictor_model.vocab)
        self.stats = {}
        # b10621 llama_token_data[_array], mirrored from the official header.
        class Token(ctypes.Structure):
            _fields_ = [('id', ctypes.c_int32), ('logit', ctypes.c_float), ('p', ctypes.c_float)]
        class Candidates(ctypes.Structure):
            _fields_ = [('data', ctypes.POINTER(Token)), ('size', ctypes.c_size_t),
                        ('selected', ctypes.c_int64), ('sorted', ctypes.c_bool)]
        self.Token, self.Candidates = Token, Candidates
        self.apply = llama.llama.llama_sampler_apply
        self.apply.argtypes = [ctypes.c_void_p, ctypes.POINTER(Candidates)]
        self.apply.restype = None
        self.set_threads = llama.llama.llama_set_n_threads
        self.set_threads.argtypes = [ctypes.c_void_p, ctypes.c_int32, ctypes.c_int32]
        self.set_threads.restype = None
        self.original_sample = llama.LlamaSampler.sample

        def sample(sampler, ctx, idx=-1, limit_start=None, limit_end=None, allow_tokens=None):
            at = time.perf_counter()
            try:
                if (self.options['bounded_sampler'] and ctx is self.stream.predictor_ctx
                        and not allow_tokens and limit_start is not None and limit_end is not None
                        and 0 <= limit_start and limit_end <= self.predictor_vocab_size
                        and limit_end == limit_start + 2048):
                    return self._sample_range(sampler, ctx, idx, limit_start)
                return self.original_sample(sampler, ctx, idx, limit_start, limit_end, allow_tokens)
            finally:
                self.record('sample', at)
        llama.LlamaSampler.sample = sample
        for name, context in [('talker', stream.talker_ctx), ('predictor', stream.predictor_ctx)]:
            self._wrap_decode(name, context)

    def _wrap_decode(self, name, context):
        decode = context.decode
        def timed_decode(batch):
            if not self.options['profile']:
                return decode(batch)
            at = time.perf_counter()
            try:
                return decode(batch)
            finally:
                self.record(name + '_decode', at)
        def clear():
            at = time.perf_counter()
            try:
                self.llama.llama_memory_clear(self.llama.llama_get_memory(context.ptr),
                                               not self.options['metadata_only'])
            finally:
                self.record(name + '_clear', at)
        context.decode = timed_decode
        context.clear_kv_cache = clear

    def _sample_range(self, sampler, ctx, idx, start):
        np = self.np
        if not hasattr(sampler, '_bounded_storage'):
            storage = np.zeros(2048, dtype=[('id', np.int32), ('logit', np.float32), ('p', np.float32)])
            sampler._bounded_storage = storage
            sampler._bounded_ids = np.arange(2048, dtype=np.int32)
        storage = sampler._bounded_storage
        np.add(sampler._bounded_ids, start, out=storage['id'])
        storage['p'] = 0
        logits = np.ctypeslib.as_array(ctx.get_logits_ith(idx), shape=(self.predictor_vocab_size,))
        storage['logit'] = logits[start:start + 2048]
        candidates = self.Candidates(storage.ctypes.data_as(ctypes.POINTER(self.Token)), 2048, -1, False)
        self.apply(sampler.ptr, ctypes.byref(candidates))
        if not 0 <= candidates.selected < candidates.size:
            raise RuntimeError('原生采样器返回了无效候选索引。')
        token = candidates.data[candidates.selected].id
        self.llama.llama_sampler_accept(sampler.ptr, token)
        return token

    def configure(self, options):
        self.options.update(options)
        if 'threads' in options:
            for context in (self.stream.talker_ctx, self.stream.predictor_ctx):
                self.set_threads(context.ptr, options['threads'], options.get('batch_threads', options['threads']))
        return dict(self.options)

    def begin(self):
        self.stats = {}
        self.code_hash = hashlib.sha256()
        self.frames = 0

    def observe(self, codes):
        if self.options['profile']:
            self.code_hash.update(self.np.asarray(codes, dtype=self.np.int16).tobytes())
            self.frames += 1

    def record(self, name, started):
        if not self.options['profile']:
            return
        value = self.stats.setdefault(name, [0, 0.0])
        value[0] += 1
        value[1] += time.perf_counter() - started

    def finish(self):
        if not self.options['profile']:
            return None
        return {'stages': {name: {'calls': value[0], 'seconds': value[1]} for name, value in self.stats.items()},
                'codes_sha256': self.code_hash.hexdigest(), 'frames': self.frames}

    def send(self, connection, payload):
        started = time.perf_counter()
        connection.send(payload)
        self.record('ipc_send', started)


if __name__ == '__main__' and len(sys.argv) == 4 and sys.argv[1] == '--worker':
    _inference_worker(sys.argv[2], sys.argv[3])
