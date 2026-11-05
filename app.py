"""Local Qwen3-TTS lab. One model, one inference worker, real audio only."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import os
import platform
import re
import secrets
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from tempo_stream import transform_audio_stream
from job_updates import JobUpdates

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / 'outputs'
OUTPUT.mkdir(exist_ok=True)
(OUTPUT / 'history').mkdir(exist_ok=True)
(OUTPUT / 'cache').mkdir(exist_ok=True)
MODEL_ID = 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice'
MODEL_PATH = Path(os.environ.get('TTS_MODEL_PATH', ROOT / 'models' / MODEL_ID.split('/')[-1]))
CONFIG_PATH = ROOT / 'server.local.json'
if not CONFIG_PATH.exists():
    CONFIG_PATH.write_text(json.dumps({'client_token': secrets.token_hex(24), 'device_id': 'esp32_01',
                                      'device_token': secrets.token_hex(24)}, indent=2), encoding='utf-8')
CONFIG = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
VOICES = [
    {'id': 'Vivian', 'name': '明亮女声', 'description': '明亮年轻 · 普通话', 'group': '中文'},
    {'id': 'Serena', 'name': '温柔女声', 'description': '温暖柔和 · 普通话', 'group': '中文'},
    {'id': 'Uncle_Fu', 'name': '沉稳男声', 'description': '低沉成熟 · 普通话', 'group': '中文'},
    {'id': 'Dylan', 'name': '北京男声', 'description': '年轻自然 · 北京口音', 'group': '中文'},
    {'id': 'Eric', 'name': '成都男声', 'description': '活泼略沙哑 · 四川口音', 'group': '中文'},
    {'id': 'Ryan', 'name': 'Ryan', 'description': '英语男声', 'group': '其他'},
    {'id': 'Aiden', 'name': 'Aiden', 'description': '美式英语男声', 'group': '其他'},
    {'id': 'Ono_Anna', 'name': 'Anna', 'description': '日语女声', 'group': '其他'},
    {'id': 'Sohee', 'name': 'Sohee', 'description': '韩语女声', 'group': '其他'},
]
TERMINAL = {'completed', 'failed', 'cancelled'}
lock = threading.RLock()
updates = JobUpdates()
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='qwen-inference')
jobs: dict[str, dict] = {}
cancel_events: dict[str, threading.Event] = {}
devices: dict[str, dict] = {}
engine_state = {'state': 'unloaded', 'message': '模型尚未加载', 'device': None, 'precision': None,
                'load_seconds': None, 'warmup_seconds': None, 'error': None}
log = logging.getLogger('qwen-lab')


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    voice: str = 'Serena'
    language: str = 'Chinese'
    speed: float = Field(default=1.0, ge=0.75, le=1.5)
    device_id: str | None = None
    use_cache: bool = True

    @field_validator('text')
    @classmethod
    def text_not_blank(cls, value):
        value = value.strip()
        if not value or any(ord(c) < 32 and c not in '\n\t\r' for c in value):
            raise ValueError('请输入有效文字')
        return value

    @field_validator('voice')
    @classmethod
    def valid_voice(cls, value):
        if value not in {v['id'] for v in VOICES}:
            raise ValueError('未知音色')
        return value

    @field_validator('language')
    @classmethod
    def valid_language(cls, value):
        if value not in {'Chinese', 'English', 'Japanese', 'Korean', 'Auto'}:
            raise ValueError('不支持的语言')
        return value

    @field_validator('device_id')
    @classmethod
    def valid_device(cls, value):
        if value is not None and value != CONFIG['device_id']:
            raise ValueError('未知设备编号')
        return value


class Heartbeat(BaseModel):
    job_id: str | None = None
    lease: str | None = None
    status: str = Field(default='idle', pattern='^(idle|playing|completed|error)$')
    error: str = Field(default='', max_length=300)


class VolumeRequest(BaseModel):
    volume: int = Field(ge=0, le=100)


def save_job(job):
    path = OUTPUT / 'history' / f"{job['id']}.json"
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def public_job(job):
    value = copy.deepcopy(job)
    value.pop('lease', None)
    value.pop('lease_until', None)
    value['revision'] = job_revision(job)
    return value


def job_revision(job):
    # Published parts are immutable. Hash their count and the small metadata,
    # avoiding a copy/hash of every earlier WAV descriptor on each heartbeat.
    state = {key: value for key, value in job.items()
             if key not in {'lease', 'lease_until', 'parts', 'revision'}}
    state['parts_count'] = len(job.get('parts', ()))
    return hashlib.sha256(json.dumps(state, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()[:20]


def split_text(text, limit=48):
    """Keep punctuation/prosody, bound each inference to fit small GPUs."""
    chunks, current = [], ''
    for piece in re.findall(r'[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+', text):
        if len(current) + len(piece) > limit and current.strip():
            chunks.append(current.strip())
            current = ''
        while len(piece) > limit:
            cut = max(piece.rfind('，', 15, limit), piece.rfind('、', 15, limit), piece.rfind(' ', 15, limit))
            cut = cut + 1 if cut >= 15 else limit
            chunks.append(piece[:cut].strip())
            piece = piece[cut:]
        current += piece
    if current.strip():
        chunks.append(current.strip())
    return chunks


class Cancelled(Exception):
    pass


def check_cancel(event):
    if event.is_set():
        raise Cancelled()


def friendly_error(exc):
    message = str(exc)
    lower = message.lower()
    if 'out of memory' in lower:
        return '显存不足：关闭占用显卡的软件，缩短文本，或用 start.ps1 -Device cpu 重启。'
    if 'no kernel image' in lower or 'not compatible' in lower:
        return '当前 PyTorch 构建不兼容显卡，请运行 setup.ps1 安装 CUDA 12.6 构建，或切换 CPU。'
    if 'nan' in lower or 'inf' in lower or 'probability tensor' in lower:
        return '当前精度发生数值异常，请用 start.ps1 -Device cpu -Precision float32 重试。'
    return message[:700] or type(exc).__name__


class QwenEngine:
    backend_name = 'torch'
    def __init__(self):
        self.model = None
        self.torch = None
        self.device = None
        self.precision = None

    def ensure_loaded(self):
        if engine_state.get('restart_required'):
            raise RuntimeError('GPU 上下文发生执行错误，请关闭并重新启动服务；可选择 BF16（支持的显卡）或 CPU FP32。')
        if self.model is not None:
            return
        with lock:
            engine_state.update(state='loading', message='正在加载本地模型', error=None)
        started = time.perf_counter()
        try:
            if not (MODEL_PATH / 'config.json').exists():
                raise RuntimeError('本地模型未下载。请运行 download-model.ps1，完成后再次点击加载。')
            # Imports/load happen only in the inference worker, keeping the UI responsive.
            import torch
            from qwen_tts import Qwen3TTSModel
            self.torch = torch
            torch.set_num_threads(max(1, min(4, os.cpu_count() or 2)))
            requested = os.environ.get('TTS_DEVICE', 'auto')
            self.device = 'cuda:0' if requested != 'cpu' and torch.cuda.is_available() else 'cpu'
            if requested == 'cuda' and self.device == 'cpu':
                raise RuntimeError('指定了 CUDA，但 PyTorch 未检测到可用显卡。请检查驱动或改用 CPU。')
            requested_precision = os.environ.get('TTS_PRECISION', 'auto')
            self.precision = requested_precision if requested_precision != 'auto' else ('bfloat16' if self.device.startswith('cuda') and torch.cuda.is_bf16_supported() else 'float32')
            if self.precision == 'bfloat16' and (self.device == 'cpu' or not torch.cuda.is_bf16_supported()):
                raise RuntimeError('当前设备不支持 GPU BF16，请选择 float32 或 CPU 模式。')
            if self.device == 'cpu' and self.precision == 'float16':
                self.precision = 'float32'
            dtype = getattr(torch, self.precision)
            self.model = Qwen3TTSModel.from_pretrained(str(MODEL_PATH), device_map=self.device,
                                                     dtype=dtype, attn_implementation='sdpa',
                                                     local_files_only=True)
            with lock:
                engine_state.update(state='ready', message='模型已加载', device=self.device,
                                    precision=self.precision, load_seconds=round(time.perf_counter() - started, 3))
        except Exception as exc:
            self.model = None
            with lock:
                engine_state.update(state='error', message='模型加载失败', error=friendly_error(exc))
            raise

    def generate(self, text, voice, language, event):
        self.ensure_loaded()
        check_cancel(event)
        torch = self.torch
        from transformers import StoppingCriteria, StoppingCriteriaList

        class StopOnCancel(StoppingCriteria):
            def __call__(self, input_ids, scores, **kwargs):
                return event.is_set()

        if self.device.startswith('cuda'):
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()
        started = time.perf_counter()
        with torch.inference_mode():
            wavs, sr = self.model.generate_custom_voice(
                text=text, language=language, speaker=voice,
                do_sample=True, subtalker_dosample=True, max_new_tokens=1024,
                stopping_criteria=StoppingCriteriaList([StopOnCancel()]))
        if self.device.startswith('cuda'):
            torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        check_cancel(event)
        import numpy as np
        audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
        if not audio.size or not np.isfinite(audio).all():
            raise RuntimeError('模型输出为空或包含无效样本，请缩短文本或切换精度后重试。')
        peak = round(torch.cuda.max_memory_allocated() / 1024**2, 1) if self.device.startswith('cuda') else None
        return audio, int(sr), elapsed, peak

    def hardware(self):
        import torch
        info = {'python': platform.python_version(), 'torch': torch.__version__, 'cuda_available': torch.cuda.is_available(),
                'gpu_name': None, 'gpu_memory_mb': None, 'compute_capability': None, 'cuda_runtime': torch.version.cuda,
                'cpu_threads': os.cpu_count(), 'requested_device': os.environ.get('TTS_DEVICE', 'auto')}
        if info['cuda_available']:
            props = torch.cuda.get_device_properties(0)
            info.update(gpu_name=props.name, gpu_memory_mb=round(props.total_memory / 1024**2),
                        compute_capability=f'{props.major}.{props.minor}')
        return info


def update_engine_state(**values):
    with lock:
        engine_state.update(values)


def create_engine():
    mode = os.environ.get('TTS_BACKEND', 'auto').lower()
    if mode not in {'auto', 'fast', 'torch'}:
        raise RuntimeError('TTS_BACKEND 必须是 auto、fast 或 torch')
    if mode != 'torch' and (ROOT / 'fast_engine.py').is_file():
        from fast_engine import FastQwenEngine, assets_ready
        if assets_ready() or mode == 'fast':
            accelerated = FastQwenEngine(state_callback=update_engine_state)
            if not callable(getattr(accelerated, 'hardware', None)):
                accelerated.hardware = QwenEngine().hardware
            return accelerated
    if mode == 'fast':
        raise RuntimeError('加速引擎尚未安装，请运行加速安装工具，或设置 TTS_BACKEND=torch')
    return QwenEngine()


engine = create_engine()
hardware_cache = None


def process_speed(audio, sr, speed):
    if abs(speed - 1) < 0.001:
        return audio
    import soundfile as sf
    import imageio_ffmpeg
    import tempfile
    with tempfile.TemporaryDirectory(prefix='qwen-speed-') as directory:
        source, target = Path(directory) / 'in.wav', Path(directory) / 'out.wav'
        sf.write(source, audio, sr, subtype='PCM_16')
        result = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error',
                                 '-i', str(source), '-af', f'atempo={speed}', '-ac', '1', '-ar', str(sr),
                                 '-c:a', 'pcm_s16le', str(target)], capture_output=True, timeout=120,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise RuntimeError('语速处理失败：' + result.stderr.decode('utf-8', errors='replace')[:200])
        return sf.read(target, dtype='float32')[0]


def run_job(job_id, event):
    with lock:
        job = jobs[job_id]
    started = time.perf_counter()
    processing_started = time.time()
    try:
        check_cancel(event)
        with lock:
            check_cancel(event)
            job.update(status='loading', stage='加载模型', processing_started_at=processing_started,
                       queued_seconds=round(processing_started - job['created_at'], 3))
            updates.notify(job_id)
        engine.ensure_loaded()
        check_cancel(event)
        import numpy as np
        import soundfile as sf
        chunks = split_text(job['text'])
        arrays, sample_rate, inference_total, processing_total, max_peak = [], None, 0.0, 0.0, None
        with lock:
            job.update(status='synthesizing', total_parts=None, stage='正在流式生成音频',
                       engine_backend=getattr(engine, 'backend_name', 'torch'))
            updates.notify(job_id)
        source_text = {'value': job['text']}

        def generate_sentences():
            for index, chunk in enumerate(chunks):
                check_cancel(event)
                source_text['value'] = chunk
                with lock:
                    job['stage'] = f'合成第 {index + 1} / {len(chunks)} 句'
                    updates.notify(job_id)
                if callable(getattr(engine, 'generate_stream', None)):
                    sentence = engine.generate_stream(chunk, job['voice'], job['language'], event)
                else:
                    sentence = iter([engine.generate(chunk, job['voice'], job['language'], event)])
                try:
                    yield from sentence
                finally:
                    close = getattr(sentence, 'close', None)
                    if close:
                        close()

        # One filter spans all sentences, including its look-ahead and tail.
        # Restarting FFmpeg at every text boundary costs startup time and resets
        # the pitch-preserving filter even though playback is continuous.
        stream = transform_audio_stream(generate_sentences(), job['speed'], event)
        part_index, sample_count = 0, 0
        try:
            for audio, sr, elapsed, peak in stream:
                audio = np.asarray(audio, dtype=np.float32).reshape(-1)
                if not audio.size or not np.isfinite(audio).all():
                    raise RuntimeError('模型输出为空或包含无效样本，未发布音频片段。')
                if not isinstance(sr, (int, np.integer)) or not 8000 <= sr <= 48000:
                    raise RuntimeError('模型输出的音频采样率不受设备支持。')
                if sample_rate is not None and sr != sample_rate:
                    raise RuntimeError('模型分段采样率不一致')
                sample_rate = sr
                post_at = time.perf_counter()
                check_cancel(event)
                part_index += 1
                name = f'{job_id}_p{part_index}.wav'
                # Publish only closed files. A manifest reader never receives a partial WAV.
                sf.write(OUTPUT / name, audio, sr, subtype='PCM_16')
                arrays.append(audio)
                sample_count += len(audio)
                inference_total += elapsed
                processing_total += time.perf_counter() - post_at
                max_peak = max(max_peak or 0, peak) if peak is not None else max_peak
                # atempo may blend a sentence boundary and its producer can run
                # ahead; its packets intentionally carry the whole job text.
                caption = source_text['value'] if abs(job['speed'] - 1) < .001 else job['text']
                with lock:
                    job['parts'].append({'index': part_index, 'text': caption, 'audio_url': f'/api/audio/{name}',
                                         'duration': round(len(audio) / sr, 3), 'generation_seconds': round(elapsed, 3)})
                    if job['first_audio_seconds'] is None:
                        job['first_audio_seconds'] = round(time.time() - job['created_at'], 3)
                    job.update(sample_rate=sample_rate, inference_seconds=round(inference_total, 3),
                               duration=round(sample_count / sample_rate, 3))
                    updates.notify(job_id)
        finally:
            close = getattr(stream, 'close', None)
            if close:
                close()

        check_cancel(event)
        combined = np.concatenate(arrays)
        output_name = f'{job_id}.wav'
        sf.write(OUTPUT / output_name, combined, sample_rate, subtype='PCM_16')
        duration = len(combined) / sample_rate
        with lock:
            job.update(status='completed', stage='生成完成', total_parts=part_index, audio_url=f'/api/audio/{output_name}',
                       duration=round(duration, 3), sample_rate=sample_rate, inference_seconds=round(inference_total, 3),
                       processing_seconds=round(processing_total, 3), worker_seconds=round(time.perf_counter() - started, 3),
                       total_seconds=round(time.time() - job['created_at'], 3),
                       rtf=round(inference_total / duration, 3), peak_vram_mb=max_peak,
                       engine_device=getattr(engine, 'device', None), precision=getattr(engine, 'precision', None),
                       delivery=job.get('delivery') if job['device_id'] else None)
            save_job(job)
            (OUTPUT / 'cache' / f"{job['cache_key']}.json").write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
    except Cancelled:
        with lock:
            if job['status'] != 'cancelled':
                job.update(status='cancelled', stage='已停止', total_seconds=round(time.time() - job['created_at'], 3))
    except Exception as exc:
        log.exception('Synthesis failed: %s', job_id)
        with lock:
            job.update(status='failed', stage='生成失败', error=friendly_error(exc), total_seconds=round(time.time() - job['created_at'], 3))
            if job.get('delivery') == 'pending':
                job['delivery'] = 'error'
            if engine_state['state'] == 'loading':
                engine_state.update(state='error', message='模型加载失败', error=friendly_error(exc))
            if 'device-side assert' in str(exc).lower() or 'illegal memory access' in str(exc).lower():
                engine_state.update(state='error', message='GPU 执行失败，需要重启服务', error='请重启服务。支持 BF16 的显卡使用默认 auto，其他设备可使用 CPU FP32。', restart_required=True)
        if getattr(engine, 'torch', None) is not None and engine.torch.cuda.is_available():
            try:
                engine.torch.cuda.empty_cache()
            except RuntimeError:
                pass
    finally:
        with lock:
            cancel_events.pop(job_id, None)
            updates.notify(job_id)


def preload():
    try:
        engine.ensure_loaded()
        with lock:
            engine_state.update(state='warming', message='正在预热：首次推理可能较慢')
        started = time.perf_counter()
        engine.generate('你好，语音测试已准备好。', 'Serena', 'Chinese', threading.Event())
        with lock:
            engine_state.update(state='ready', message='模型已预热，可以生成语音', warmup_seconds=round(time.perf_counter() - started, 3))
    except Exception as exc:
        log.exception('Preload failed')
        with lock:
            engine_state.update(state='error', message='加载或预热失败', error=friendly_error(exc))


@asynccontextmanager
async def lifespan(application):
    if os.environ.get('TTS_PRELOAD', '0') == '1':
        executor.submit(preload)
    yield


app = FastAPI(title='Qwen TTS Lab', version='1.2.0', lifespan=lifespan)


@app.middleware('http')
async def local_access(request: Request, call_next):
    host = request.headers.get('host', '')
    origin = request.headers.get('origin')
    # Reject cross-origin browser writes, including a hostile site targeting localhost.
    if request.method not in {'GET', 'HEAD', 'OPTIONS'} and origin and urlsplit(origin).netloc != host:
        return JSONResponse({'detail': '不允许跨站请求'}, status_code=403)
    if request.url.path.startswith('/api/') and not request.url.path.startswith('/api/device/'):
        peer = request.client.host if request.client else ''
        token = request.headers.get('x-client-token', '')
        device_audio = request.url.path.startswith('/api/audio/') and secrets.compare_digest(request.headers.get('x-device-token', ''), CONFIG['device_token'])
        if peer not in {'127.0.0.1', '::1', 'testclient'} and not device_audio and not secrets.compare_digest(token, CONFIG['client_token']):
            return JSONResponse({'detail': '请在小程序配置正确的 clientToken'}, status_code=401)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@app.get('/api/status')
def status():
    global hardware_cache
    if hardware_cache is None:
        try:
            hardware_cache = engine.hardware()
        except Exception as exc:
            hardware_cache = {'error': friendly_error(exc)}
    with lock:
        return {'model': MODEL_ID, 'model_downloaded': (MODEL_PATH / 'config.json').exists(),
                'engine': copy.deepcopy(engine_state), 'hardware': hardware_cache,
                'backend': getattr(engine, 'backend_name', 'torch'),
                'active_jobs': sum(j['status'] not in TERMINAL for j in jobs.values()), 'device_id': CONFIG['device_id']}


@app.get('/api/voices')
def voices():
    return VOICES


@app.post('/api/model/load', status_code=202)
def load_model():
    with lock:
        if any(j['status'] not in TERMINAL for j in jobs.values()) or engine_state['state'] in {'loading', 'warming'}:
            raise HTTPException(409, '正在处理任务，请稍后再预热')
        engine_state.update(state='loading', message='准备加载并预热', error=None)
        executor.submit(preload)
    return {'message': '加载和预热已开始'}


@app.post('/api/jobs', status_code=202)
def submit(body: SynthesisRequest):
    with lock:
        settings = {'model': MODEL_ID, 'text': body.text, 'voice': body.voice, 'language': body.language,
                    'speed': body.speed, 'version': 3,
                    'backend':getattr(engine, 'backend_name', 'torch')}
        cache_key = hashlib.sha256(json.dumps(settings, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:24]
        job_id = uuid.uuid4().hex
        job = dict(id=job_id, text=body.text, voice=body.voice, language=body.language, speed=body.speed,
                   device_id=body.device_id, status='queued', stage='等待推理', created_at=time.time(),
                   parts=[], total_parts=None, first_audio_seconds=None, audio_url=None, duration=None,
                   sample_rate=None, inference_seconds=None, processing_seconds=None, total_seconds=None,
                   rtf=None, peak_vram_mb=None, error=None, cache_hit=False, cache_key=cache_key,
                   queued_seconds=None, device_first_audio_seconds=None,
                   delivery='pending' if body.device_id else None)
        cache_file = OUTPUT / 'cache' / f'{cache_key}.json'
        if body.use_cache and cache_file.exists():
            try:
                cached = json.loads(cache_file.read_text(encoding='utf-8'))
                audio_path = OUTPUT / Path(cached['audio_url']).name
                if audio_path.exists() and all((OUTPUT / Path(p['audio_url']).name).exists() for p in cached['parts']):
                    for key in ('audio_url', 'duration', 'sample_rate', 'parts', 'total_parts'):
                        job[key] = cached[key]
                    job.update(status='completed', stage='缓存命中', cache_hit=True, total_seconds=0, queued_seconds=0,
                               inference_seconds=0, processing_seconds=0, first_audio_seconds=0,
                               delivery='pending' if body.device_id else None)
            except (OSError, ValueError, KeyError):
                pass
        if job['status'] != 'completed' and sum(j['status'] not in TERMINAL for j in jobs.values()) >= 4:
            raise HTTPException(429, '队列已满，请等待当前任务完成')
        jobs[job_id] = job
        if job['status'] == 'completed':
            save_job(job)
        else:
            event = threading.Event()
            cancel_events[job_id] = event
            executor.submit(run_job, job_id, event)
        # Cap in-memory history; keep all active and undelivered device work.
        for old_id, old in list(jobs.items()):
            if len(jobs) <= 100:
                break
            if old['status'] in TERMINAL and old.get('delivery') not in {'pending', 'leased', 'waiting', 'buffering', 'playing'}:
                jobs.pop(old_id)
        return public_job(job)


@app.get('/api/jobs')
def history():
    with lock:
        return [public_job(j) for j in sorted(jobs.values(), key=lambda j: j['created_at'], reverse=True)[:30]]


@app.get('/api/jobs/{job_id}')
async def get_job(job_id: str, after_parts: int = Query(default=0, ge=0),
                  revision: str | None = Query(default=None, max_length=64),
                  wait_ms: int = Query(default=0, ge=0, le=2000)):
    deadline = time.monotonic() + wait_ms / 1000
    while True:
        with lock:
            if job_id not in jobs:
                raise HTTPException(404, '任务不存在')
            job = jobs[job_id]
            finished = job['status'] in TERMINAL and job.get('delivery') not in {
                'pending', 'leased', 'waiting', 'buffering', 'playing'}
            if (not revision or revision != job_revision(job) or len(job.get('parts', ())) > after_parts
                    or finished or time.monotonic() >= deadline):
                return public_job(job)
            # Register under the same lock as publication: a packet cannot be
            # published between checking the snapshot and subscribing its waiter.
            future = updates.subscribe(job_id)
        try:
            await asyncio.wait_for(future, timeout=max(0, deadline - time.monotonic()))
        except asyncio.TimeoutError:
            pass
        finally:
            updates.unsubscribe(job_id, future)


@app.post('/api/jobs/{job_id}/cancel')
def cancel_job(job_id: str):
    with lock:
        if job_id not in jobs:
            raise HTTPException(404, '任务不存在')
        job = jobs[job_id]
        if job_id in cancel_events:
            cancel_events[job_id].set()
            job['stage'] = '正在停止，请等待当前计算结束'
            if job['status'] == 'queued':
                job.update(status='cancelled', stage='已停止', total_seconds=round(time.time() - job['created_at'], 3))
        if job['device_id']:
            job['cancel_playback'] = True
            job['delivery'] = 'cancelled'
        updates.notify(job_id)
        return public_job(job)


@app.get('/api/audio/{filename}')
def audio_file(filename: str):
    if not re.fullmatch(r'[a-f0-9]{32}(?:_p[1-9][0-9]*)?\.wav', filename):
        raise HTTPException(404, '音频不存在')
    path = OUTPUT / filename
    if not path.is_file():
        raise HTTPException(404, '音频不存在')
    return FileResponse(path, media_type='audio/wav', filename=filename)


def device_auth(device_id, request):
    if device_id != CONFIG['device_id'] or not secrets.compare_digest(request.headers.get('x-device-token', ''), CONFIG['device_token']):
        raise HTTPException(401, '设备认证失败')


def device_record(device_id):
    value = devices.setdefault(device_id, {'volume': 70, 'last_seen': 0, 'status': 'idle', 'job_id': None})
    value['last_seen'] = time.time()
    return value


@app.get('/api/devices')
def list_devices():
    with lock:
        value = devices.get(CONFIG['device_id'], {'volume': 70, 'last_seen': 0, 'status': 'offline', 'job_id': None})
        return [dict(id=CONFIG['device_id'], **value, online=time.time() - value['last_seen'] < 15)]


@app.post('/api/devices/{device_id}/volume')
def volume(device_id: str, body: VolumeRequest):
    if device_id != CONFIG['device_id']:
        raise HTTPException(404, '设备不存在')
    with lock:
        # A control request is not a device heartbeat: do not mark an offline device online.
        value = devices.setdefault(device_id, {'volume': 70, 'last_seen': 0, 'status': 'offline', 'job_id': None})
        value['volume'] = body.volume
    return {'volume': body.volume}


from device_protocol import create_device_router
app.include_router(create_device_router(config=CONFIG, get_jobs=lambda: jobs,
                                       get_devices=lambda: devices, lock=lock, save_job=save_job,
                                       notify_job=updates.notify, subscribe_job=updates.subscribe,
                                       unsubscribe_job=updates.unsubscribe))


for saved in sorted((OUTPUT / 'history').glob('*.json'), key=lambda p: p.stat().st_mtime)[-100:]:
    try:
        value = json.loads(saved.read_text(encoding='utf-8'))
        # Never automatically replay saved audio after restarting the backend.
        if value.get('delivery') in {'pending', 'leased', 'waiting', 'buffering', 'playing'}:
            value['delivery'] = 'expired'
        jobs[value['id']] = value
    except (ValueError, OSError, KeyError):
        pass

app.mount('/', StaticFiles(directory=ROOT / 'static', html=True), name='web')
