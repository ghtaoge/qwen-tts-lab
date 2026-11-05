"""Compare 150ms polling and event-driven JSON waits on the same real TTS jobs."""
from __future__ import annotations

import argparse
import json
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx


def watch(client, job, started, request_wall, *, long_poll, poll_ms):
    snapshot, requests = job, 0
    deadline = time.monotonic() + 120
    while not snapshot['parts']:
        if time.monotonic() > deadline:
            raise TimeoutError('No audio before benchmark timeout')
        if snapshot['status'] in {'failed', 'cancelled'}:
            raise RuntimeError(snapshot.get('error') or snapshot['status'])
        if requests and not long_poll:
            time.sleep(poll_ms / 1000)
        params = ({'revision': snapshot['revision'], 'after_parts': 0, 'wait_ms': 1000}
                  if long_poll else {})
        response = client.get('/api/jobs/' + job['id'], params=params)
        response.raise_for_status()
        snapshot = response.json()
        requests += 1
    detected = time.perf_counter() - started
    published = snapshot['created_at'] - request_wall + snapshot['first_audio_seconds']
    fetch_at = time.perf_counter()
    audio = client.get(snapshot['parts'][0]['audio_url'])
    audio.raise_for_status()
    if not audio.content.startswith(b'RIFF'):
        raise ValueError('Expected real PCM WAV')
    return {'mode': 'event_wait' if long_poll else 'fixed_poll', 'requests_to_first_part': requests,
            'service_first_audio_s': snapshot['first_audio_seconds'],
            'first_part_detected_s': round(detected, 6),
            'detection_after_publication_ms': round((detected - published) * 1000, 3),
            'wav_download_ms': round((time.perf_counter() - fetch_at) * 1000, 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8766')
    parser.add_argument('--runs', type=int, default=5)
    parser.add_argument('--poll-ms', type=float, default=150)
    parser.add_argument('--text', default='你好，欢迎来到语音实验室。')
    parser.add_argument('--output', type=Path, default=Path('logs/notification-benchmark.json'))
    args = parser.parse_args()
    if not 1 <= args.runs <= 20 or not 10 <= args.poll_ms <= 2000:
        parser.error('runs must be 1..20 and poll-ms 10..2000')
    report = {'measurement': 'same-job real HTTP notification comparison; no physical speaker',
              'cache': False, 'poll_ms': args.poll_ms, 'rounds': []}
    with (httpx.Client(base_url=args.url, timeout=125) as submitter,
          httpx.Client(base_url=args.url, timeout=5) as short,
          httpx.Client(base_url=args.url, timeout=5) as long,
          ThreadPoolExecutor(max_workers=2) as pool):
        status = submitter.get('/api/status'); status.raise_for_status()
        report['hardware'] = status.json()['hardware']
        report['backend'] = status.json()['backend']
        # Establish both connections before the model can publish a short first packet.
        for client in (short, long):
            client.get('/api/status').raise_for_status()
        for index in range(args.runs):
            started, wall = time.perf_counter(), time.time()
            response = submitter.post('/api/jobs', json={'text':args.text, 'voice':'Serena', 'use_cache':False})
            response.raise_for_status()
            job = response.json()
            futures = [pool.submit(watch, client, job, started, wall, long_poll=waiting, poll_ms=args.poll_ms)
                       for client, waiting in ((short, False), (long, True))]
            observed = [future.result() for future in futures]
            report['rounds'].append({'job_id': job['id'], 'watchers':observed})
            while True:
                response = submitter.get('/api/jobs/' + job['id']); response.raise_for_status()
                state = response.json()
                if state['status'] in {'completed', 'failed', 'cancelled'}:
                    if state['status'] != 'completed':
                        raise RuntimeError(state.get('error') or state['status'])
                    break
                time.sleep(.03)
            print(f'Round {index + 1}: ' + ', '.join(
                f"{item['mode']} {item['detection_after_publication_ms']:.1f}ms" for item in observed), flush=True)
    report['median_detection_ms'] = {
        mode: round(statistics.median(item['detection_after_publication_ms']
                    for row in report['rounds'] for item in row['watchers'] if item['mode'] == mode), 3)
        for mode in ('fixed_poll', 'event_wait')}
    args.output.parent.mkdir(exist_ok=True, parents=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report['median_detection_ms'], indent=2))
    print(f'Report: {args.output}')


if __name__ == '__main__':
    main()
