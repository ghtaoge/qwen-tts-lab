"""Protocol-2 receiver simulator; never claims to drive physical I2S/OLED.

Choose an exact --job-id, or explicitly opt into consuming the next task.
"""
from __future__ import annotations

import argparse
import io
import json
import time
import wave
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]


def validate_pcm(content):
    with wave.open(io.BytesIO(content), 'rb') as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getcomptype() != 'NONE':
            raise ValueError('Expected uncompressed PCM16 mono WAV')
        rate, frames = wav.getframerate(), wav.getnframes()
        if not 8000 <= rate <= 48000 or not frames:
            raise ValueError('Invalid PCM sample rate or empty audio')
        if len(wav.readframes(frames)) != frames * 2:
            raise ValueError('Truncated PCM audio')
        return rate, frames / rate


def receive_task(client, path, task, *, simulate_pace=False, max_wait=180):
    started = time.perf_counter()
    played = 0
    first_elapsed_ms = None
    heartbeat_at = 0.0
    total_duration = 0.0
    expected_rate = None
    payload = {'job_id': task['id'], 'lease': task['lease'], 'status': 'waiting', 'simulated': True}

    def heartbeat(status, error=''):
        nonlocal heartbeat_at
        report = {**payload, 'status': status, 'played_parts': played, 'error': error}
        if first_elapsed_ms is not None:
            report.update(first_audio=True, first_audio_elapsed_ms=first_elapsed_ms)
        response = client.post(path + '/heartbeat', json=report)
        response.raise_for_status()
        heartbeat_at = time.perf_counter()
        return response.json()

    heartbeat('waiting')
    print(f"SIMULATION ONLY: receiving task {task['id']} (no speaker playback)", flush=True)
    while time.perf_counter() - started < max_wait:
        response = client.get(task['manifest_url'], params={
            'lease': task['lease'], 'after': played, 'wait_ms': 100})
        response.raise_for_status()
        manifest = response.json()
        if manifest['cancel'] or manifest.get('error'):
            error = manifest.get('error') or ''
            heartbeat('error' if error else 'completed', error)
            print('Task stopped: ' + (error or 'cancelled'), flush=True)
            return {'cancelled': True, 'parts': played}
        for part in manifest['parts']:
            if part['index'] != played + 1:
                raise ValueError('Non-contiguous audio part index')
            audio = client.get(part['audio_url'])
            audio.raise_for_status()
            rate, duration = validate_pcm(audio.content)
            if expected_rate is not None and expected_rate != rate:
                raise ValueError('Sample rate changed between parts')
            expected_rate = rate
            if first_elapsed_ms is None:
                first_elapsed_ms = round((time.perf_counter() - started) * 1000)
                print(f'First simulated PCM buffer ready: {first_elapsed_ms} ms after claim; '
                      'this is not measured physical first sound.', flush=True)
                heartbeat('playing')
            total_duration += duration
            print(f"Part {part['index']}: PCM16 mono, {rate} Hz, {duration:.3f}s, {len(audio.content)} bytes", flush=True)
            if simulate_pace:
                # Intentional protocol pacing, not an emulator of the hardware DMA.
                until = time.perf_counter() + duration
                while time.perf_counter() < until:
                    if time.perf_counter() - heartbeat_at > .5 and heartbeat('playing')['cancel']:
                        heartbeat('completed')
                        return {'cancelled': True, 'parts': played}
                    time.sleep(min(.04, max(0, until - time.perf_counter())))
            played = part['index']
        if manifest['finished'] and played >= manifest['available_parts']:
            heartbeat('completed')
            summary = {'job_id': task['id'], 'simulated': True, 'parts': played,
                       'audio_seconds': round(total_duration, 3), 'first_buffer_after_claim_ms': first_elapsed_ms,
                       'receive_seconds': round(time.perf_counter() - started, 3)}
            print(json.dumps(summary, ensure_ascii=False), flush=True)
            return summary
        if time.perf_counter() - heartbeat_at > .5:
            if heartbeat('buffering' if first_elapsed_ms is not None else 'waiting')['cancel']:
                heartbeat('completed')
                return {'cancelled': True, 'parts': played}
    heartbeat('error', 'Simulator timed out waiting for audio')
    raise TimeoutError('Timed out waiting for incremental audio')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:8766')
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument('--job-id', help='Receive only this job; never consume other pending jobs')
    selection.add_argument('--consume-next', action='store_true', help='Explicitly allow consuming the next device task')
    parser.add_argument('--once', action='store_true', help='Exit after one task (always enabled with --job-id)')
    parser.add_argument('--simulate-pace', action='store_true', help='Wait each chunk duration; does not play physical audio')
    parser.add_argument('--max-wait', type=float, default=180)
    args = parser.parse_args()
    config = json.loads((ROOT / 'server.local.json').read_text(encoding='utf-8'))
    path = f"/api/device/{config['device_id']}"
    headers = {'X-Device-Token': config['device_token'], 'X-Client-Token': config['client_token']}
    with httpx.Client(base_url=args.base_url, headers=headers, timeout=20) as client:
        deadline = time.monotonic() + args.max_wait
        while True:
            params = {'wait_ms': 1000}
            if args.job_id:
                params['job_id'] = args.job_id
            reply = client.get(path + '/next', params=params)
            reply.raise_for_status()
            task = reply.json()['task']
            if task is None:
                if args.job_id:
                    job_reply = client.get('/api/jobs/' + args.job_id)
                    job_reply.raise_for_status()
                    job = job_reply.json()
                    if job['status'] in {'failed', 'cancelled'} or job.get('delivery') in {'delivered', 'cancelled', 'expired', 'error'}:
                        print('Selected task is no longer eligible; no unrelated task consumed.')
                        return
                if time.monotonic() >= deadline:
                    raise TimeoutError('No eligible task before timeout; no unrelated task consumed')
                continue
            try:
                receive_task(client, path, task, simulate_pace=args.simulate_pace, max_wait=args.max_wait)
            except Exception as error:
                try:
                    client.post(path + '/heartbeat', json={
                        'job_id': task['id'], 'lease': task['lease'], 'status': 'error',
                        'simulated': True, 'error': str(error)[:300]})
                except httpx.HTTPError:
                    pass
                raise
            if args.once or args.job_id:
                return
            deadline = time.monotonic() + args.max_wait


if __name__ == '__main__':
    main()
