"""Uncached real TTS + HTTP transfer benchmark, with simulated speaker scheduling.

Never claims physical ESP32 measurements. No device tasks/ACKs are created.
"""
import argparse
import json
import time
from pathlib import Path

import httpx


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8766')
    parser.add_argument('--text', default='你好，欢迎来到语音实验室。')
    parser.add_argument('--voice', default='Serena')
    parser.add_argument('--speed', type=float, default=1.0)
    parser.add_argument('--output', default='logs/latency-benchmark.json')
    args = parser.parse_args()
    result = {'measurement': 'HTTP audio delivery and simulated playback; not physical ESP32',
              'text':args.text, 'voice':args.voice, 'speed':args.speed, 'chunks':[]}
    with httpx.Client(base_url=args.url, timeout=120) as client:
        status = client.get('/api/status');status.raise_for_status()
        result['backend'] = status.json().get('backend', 'torch')
        result['hardware'] = status.json()['hardware']
        started = time.perf_counter()
        response = client.post('/api/jobs',json={'text':args.text,'voice':args.voice,
                                               'speed':args.speed,'use_cache':False})
        response.raise_for_status()
        job = response.json()
        result['job_id'] = job['id']
        seen, schedule_end, total_gap = 0, None, 0.0
        while True:
            response=client.get('/api/jobs/'+job['id']);response.raise_for_status();job=response.json()
            for part in job['parts'][seen:]:
                fetch_started=time.perf_counter()
                audio=client.get(part['audio_url']);audio.raise_for_status()
                if not audio.content.startswith(b'RIFF'):raise RuntimeError('Not a PCM WAV')
                arrived=time.perf_counter()-started
                if schedule_end is None:
                    result['first_download_seconds']=round(arrived,4)
                    schedule_end=arrived
                gap=max(0,arrived-schedule_end)
                total_gap+=gap
                schedule_end=max(arrived,schedule_end)+part['duration']
                result['chunks'].append({'index':part['index'],'ready_to_client_seconds':round(arrived,4),
                                         'download_ms':round((time.perf_counter()-fetch_started)*1000,2),
                                         'bytes':len(audio.content),'audio_duration':part['duration'],
                                         'simulated_underflow_seconds':round(gap,4)})
                seen+=1
            if job['status'] in {'completed','failed','cancelled'}:
                result.update(job_status=job['status'],error=job.get('error'),
                              total_client_seconds=round(time.perf_counter()-started,4),
                              model_first_audio_seconds=job['first_audio_seconds'],
                              inference_seconds=job['inference_seconds'],duration=job['duration'],rtf=job['rtf'],
                              simulated_underflow_seconds=round(total_gap,4),cache_hit=job['cache_hit'])
                break
            time.sleep(.06)
    target=Path(args.output);target.parent.mkdir(exist_ok=True,parents=True)
    target.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in {'chunks','hardware'}},ensure_ascii=False,indent=2))
    print(f'Wrote {target}')
    if result['job_status']!='completed':raise SystemExit(1)


if __name__=='__main__':main()
