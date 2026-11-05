"""Benchmark one newly submitted TTS task through protocol 2, without sound.

Only the returned exact job ID is claimed. Timing reports never contain client,
device or lease tokens. This is a PCM receiver/FIFO playback simulation, not an
ESP32, I2S, speaker or microphone measurement.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import httpx

try:
    from .device_simulator import validate_pcm
except ImportError:
    from device_simulator import validate_pcm

ROOT = Path(__file__).resolve().parents[1]


def benchmark(client, *, device_id, text, voice='Serena', speed=1.0, max_wait=300):
    """Run a real HTTP protocol benchmark with a caller-configured client.

    The output's virtual playback clock starts at the first complete PCM buffer.
    Download/validation is real; audio drain and underruns are calculated using
    the PCM durations. The final ACK is delayed until the virtual FIFO drains.
    """
    start = time.perf_counter()
    deadline = start + max_wait
    report = {
        'simulated': True,
        'measurement': 'HTTP PCM buffers + simulated FIFO; no physical sound',
        'device_id': device_id,
        'request': {'text': text, 'voice': voice, 'language': 'Chinese', 'speed': speed, 'use_cache': False},
        'parts': [],
        'first_buffer_from_submit_s': None,
        'claim_to_first_buffer_s': None,
        'first_buffer_job_status': None,
        'first_buffer_manifest_status': None,
        'generation_finished_observed_s': None,
        'simulated_underrun_count': 0,
        'simulated_underrun_seconds': 0.0,
    }
    job_id = None
    task = None
    played_parts = 0
    heartbeat_at = 0.0
    claimed_at = None
    playback_end = None
    first_ready = None
    total_audio = 0.0
    underruns = []
    device_path = f'/api/device/{device_id}'

    def elapsed():
        return time.perf_counter() - start

    def check_timeout():
        if time.perf_counter() > deadline:
            raise TimeoutError('Benchmark exceeded max-wait; only its own task will be cancelled')

    def update_played():
        nonlocal played_parts
        now = elapsed()
        played_parts = sum(part['simulated_play_end_s'] <= now for part in report['parts'])

    def heartbeat(status, error=''):
        nonlocal heartbeat_at, played_parts
        if status == 'completed':
            played_parts = len(report['parts'])
        else:
            update_played()
        payload = {'job_id': job_id, 'lease': task['lease'], 'status': status,
                   'simulated': True, 'played_parts': played_parts, 'error': error[:300]}
        if first_ready is not None:
            payload.update(first_audio=True, first_audio_elapsed_ms=round((first_ready - claimed_at) * 1000))
        response = client.post(device_path + '/heartbeat', json=payload)
        response.raise_for_status()
        heartbeat_at = time.perf_counter()
        return response.json()

    def generation_result():
        response = client.get('/api/jobs/' + job_id)
        response.raise_for_status()
        return response.json()

    try:
        # This request always disables cache: no historical audio can masquerade
        # as faster model inference. No existing user task is modified.
        response = client.post('/api/jobs', json={
            'text': text, 'voice': voice, 'language': 'Chinese', 'speed': speed,
            'device_id': device_id, 'use_cache': False})
        response.raise_for_status()
        submitted = response.json()
        job_id = submitted['id']
        report.update(job_id=job_id, submit_http_ms=round(elapsed() * 1000, 3))
        if submitted.get('cache_hit'):
            raise RuntimeError('Server returned cached audio despite use_cache=false')
        while task is None:
            check_timeout()
            response = client.get(device_path + '/next', params={
                'job_id': job_id, 'wait_ms': max(0, min(500, int((deadline - time.perf_counter()) * 1000)))})
            response.raise_for_status()
            task = response.json()['task']
            if task is not None and task['id'] != job_id:
                # Never ACK/download an unrelated task, even if a broken server
                # ignores the selector. It is left for normal lease recovery.
                task = None
                raise RuntimeError('Server ignored exact job-id selector; unrelated audio was not consumed')
            if task is None:
                state = generation_result()
                if state['status'] in {'failed', 'cancelled'}:
                    raise RuntimeError('Generation ended before claim: ' + (state.get('error') or state['status']))
        claimed_at = time.perf_counter()
        report['claim_after_submit_s'] = round(elapsed(), 6)
        heartbeat('waiting')
        received = 0
        expected_rate = None
        finished = False
        while not finished:
            check_timeout()
            response = client.get(task['manifest_url'], params={
                'lease': task['lease'], 'after': received, 'wait_ms': 100})
            response.raise_for_status()
            manifest = response.json()
            if manifest.get('cancel') or manifest.get('error'):
                raise RuntimeError('Task stopped: ' + (manifest.get('error') or 'cancelled'))
            if manifest['finished'] and report['generation_finished_observed_s'] is None:
                report['generation_finished_observed_s'] = round(elapsed(), 6)
            for part in manifest['parts']:
                check_timeout()
                if part['index'] != received + 1:
                    raise ValueError('Non-contiguous audio sequence')
                download_started = time.perf_counter()
                audio = client.get(part['audio_url'])
                audio.raise_for_status()
                downloaded_at = time.perf_counter()
                rate, duration = validate_pcm(audio.content)
                ready_at = time.perf_counter()
                if expected_rate is not None and expected_rate != rate:
                    raise ValueError('PCM sample rate changed between chunks')
                expected_rate = rate
                if first_ready is None:
                    first_ready = ready_at
                    report['first_buffer_from_submit_s'] = round(first_ready - start, 6)
                    report['claim_to_first_buffer_s'] = round(first_ready - claimed_at, 6)
                    report['first_buffer_manifest_status'] = manifest['status']
                    report['first_buffer_job_status'] = generation_result()['status']
                    heartbeat('playing')
                arrival = ready_at - start
                buffered_before = max(0.0, (playback_end or arrival) - arrival)
                gap = max(0.0, arrival - playback_end) if playback_end is not None else 0.0
                if gap > .002:
                    underruns.append({'after_part': received, 'start_s': round(playback_end, 6),
                                      'end_s': round(arrival, 6), 'seconds': round(gap, 6)})
                play_start = max(arrival, playback_end or arrival)
                playback_end = play_start + duration
                total_audio += duration
                report['parts'].append({
                    'index': part['index'], 'bytes': len(audio.content), 'sample_rate': rate,
                    'duration_s': round(duration, 6),
                    'download_ms': round((downloaded_at - download_started) * 1000, 3),
                    'validation_ms': round((ready_at - downloaded_at) * 1000, 3),
                    'buffer_ready_from_submit_s': round(arrival, 6),
                    'buffered_audio_before_s': round(buffered_before, 6),
                    'simulated_play_start_s': round(play_start, 6),
                    'simulated_play_end_s': round(playback_end, 6),
                    'simulated_gap_before_s': round(gap, 6),
                    'manifest_job_status': manifest['status'],
                })
                received = part['index']
            finished = bool(manifest['finished'] and received >= manifest['available_parts'])
            if time.perf_counter() - heartbeat_at > .5:
                update_played()
                active_audio = playback_end is not None and elapsed() < playback_end
                if heartbeat('playing' if active_audio else 'buffering' if first_ready else 'waiting').get('cancel'):
                    raise RuntimeError('Task was cancelled during protocol benchmark')
        if not received:
            raise RuntimeError('Completed generation did not produce any PCM buffers')
        report['all_buffers_received_s'] = round(elapsed(), 6)
        final = generation_result()
        report['generation'] = {key: final.get(key) for key in (
            'status', 'cache_hit', 'inference_seconds', 'processing_seconds', 'total_seconds',
            'queued_seconds', 'first_audio_seconds', 'duration', 'rtf', 'engine_device',
            'precision', 'peak_vram_mb', 'engine_backend', 'streaming')}
        while elapsed() < playback_end:
            check_timeout()
            if time.perf_counter() - heartbeat_at > .5 and heartbeat('playing').get('cancel'):
                raise RuntimeError('Task was cancelled while the virtual audio FIFO drained')
            time.sleep(min(.04, max(0, playback_end - elapsed())))
        heartbeat('completed')
        report.update(
            success=True,
            pcm_duration_s=round(total_audio, 6),
            sample_rate=expected_rate,
            part_count=received,
            simulated_underrun_count=len(underruns),
            simulated_underrun_seconds=round(sum(gap['seconds'] for gap in underruns), 6),
            simulated_underruns=underruns,
            simulated_playback_complete_s=round(playback_end, 6),
            benchmark_elapsed_s=round(elapsed(), 6),
        )
        return report
    except Exception as error:
        if task is not None:
            try:
                heartbeat('error', str(error))
            except Exception:
                pass
        if job_id:
            try:
                # This ID is only the task created by this benchmark invocation.
                client.post('/api/jobs/' + job_id + '/cancel')
            except Exception:
                pass
        report.update(success=False, error=str(error), error_type=type(error).__name__,
                      benchmark_elapsed_s=round(elapsed(), 6))
        return report


def redact(value, tokens):
    if isinstance(value, dict):
        return {key: redact(item, tokens) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item, tokens) for item in value]
    if isinstance(value, str):
        value = re.sub(r'([?&]lease=)[^&\s\"\']+', r'\1<redacted>', value)
        for token in tokens:
            if token:
                value = value.replace(token, '<redacted>')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8766')
    parser.add_argument('--text', default='你好，欢迎来到语音实验室。这里正在测试边生成边播放。')
    parser.add_argument('--voice', default='Serena')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--device-id')
    parser.add_argument('--max-wait', type=float, default=300)
    parser.add_argument('--output', type=Path, default=ROOT / 'logs' / 'device-benchmark.json')
    args = parser.parse_args()
    config = json.loads((ROOT / 'server.local.json').read_text(encoding='utf-8'))
    headers = {'X-Device-Token': config['device_token'], 'X-Client-Token': config['client_token']}
    with httpx.Client(base_url=args.url.rstrip('/'), headers=headers, timeout=20) as client:
        result = benchmark(client, device_id=args.device_id or config['device_id'], text=args.text,
                           voice=args.voice, speed=args.speed, max_wait=args.max_wait)
    result = redact(result, [config['device_token'], config['client_token']])
    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded + '\n', encoding='utf-8')
    print(encoded, flush=True)
    print('Report: ' + str(args.output), file=sys.stderr, flush=True)
    return 0 if result['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
