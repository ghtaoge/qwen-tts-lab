"""Integration checks: generated audio must reach device before synthesis finishes."""
import threading
import time

import numpy as np
import app as lab
from test_protocol import client, wait_job


def test_first_part_is_deliverable_before_final_wav_and_lease_survives_completion(client):
    published = threading.Event()
    finish = threading.Event()

    def generate_stream(text, voice, language, cancelled):
        yield np.zeros(2400, dtype=np.float32), 24000, .01, None
        published.set()
        finish.wait(3)
        lab.check_cancel(cancelled)
        yield np.zeros(2400, dtype=np.float32), 24000, .01, None

    lab.engine.generate_stream = generate_stream
    device_id = lab.CONFIG['device_id']
    headers = {'X-Device-Token':lab.CONFIG['device_token']}
    job = client.post('/api/jobs', json={'text':'测试语音。', 'device_id':device_id, 'use_cache':False}).json()
    try:
        assert published.wait(2)
        current = client.get('/api/jobs/'+job['id']).json()
        assert current['status'] == 'synthesizing'
        assert current['audio_url'] is None
        task = client.get(f'/api/device/{device_id}/next',headers=headers).json()['task']
        assert task['id'] == job['id'] and task['protocol'] == 2
        manifest_url = task['manifest_url'] + '?lease=' + task['lease']
        manifest = client.get(manifest_url,headers=headers).json()
        assert not manifest['finished'] and len(manifest['parts']) == 1
        assert client.get(manifest['parts'][0]['audio_url'], headers=headers).content.startswith(b'RIFF')
        acknowledgement = {'job_id':job['id'], 'lease':task['lease'], 'status':'playing',
                           'first_audio':True,'first_audio_elapsed_ms':1,'played_parts':0}
        assert client.post(f'/api/device/{device_id}/heartbeat',headers=headers,json=acknowledgement).status_code == 200
        finish.set()
        done = wait_job(client,job['id'])
        assert done['status'] == 'completed' and len(done['parts']) == 2
        assert done['delivery'] == 'playing'  # Do not enqueue it again when inference ends.
        assert done['device_first_audio_seconds'] is not None
        assert done['first_audio_seconds'] < done['total_seconds'] + done['queued_seconds']
        assert client.get(f'/api/device/{device_id}/next',headers=headers).json()['task'] is None
        tail=client.get(manifest_url+'&after=1',headers=headers).json()
        assert tail['finished'] and [part['index'] for part in tail['parts']] == [2]
    finally:
        finish.set()


def test_cancel_reaches_device_while_generation_still_running(client):
    published = threading.Event()
    finish = threading.Event()
    def generate_stream(text,voice,language,cancelled):
        yield np.zeros(2400,dtype=np.float32),24000,.01,None
        published.set()
        finish.wait(3)
        lab.check_cancel(cancelled)
    lab.engine.generate_stream=generate_stream
    device_id=lab.CONFIG['device_id']
    headers={'X-Device-Token':lab.CONFIG['device_token']}
    job=client.post('/api/jobs',json={'text':'停止测试。','device_id':device_id,'use_cache':False}).json()
    try:
        assert published.wait(2)
        task=client.get(f'/api/device/{device_id}/next',headers=headers).json()['task']
        client.post('/api/jobs/'+job['id']+'/cancel')
        result=client.get(task['manifest_url']+'?lease='+task['lease'],headers=headers).json()
        assert result['cancel']
    finally:
        finish.set()
    assert wait_job(client,job['id'])['status']=='cancelled'


def test_invalid_stream_chunk_is_not_published(client):
    def generate_stream(*args):
        yield np.array([float('nan')],dtype=np.float32),24000,.01,None
    lab.engine.generate_stream=generate_stream
    job=client.post('/api/jobs',json={'text':'无效样本测试。','use_cache':False}).json()
    done=wait_job(client,job['id'])
    assert done['status']=='failed' and not done['parts'] and done['audio_url'] is None


def test_cache_hit_bypasses_full_inference_queue(client):
    request={'text':'重复播报。','voice':'Serena'}
    cached=client.post('/api/jobs',json=request).json()
    assert wait_job(client,cached['id'])['status']=='completed'
    gate=threading.Event()
    original=lab.engine.generate
    def block(*args):
        gate.wait(3)
        return original(*args)
    lab.engine.generate=block
    queued=[]
    try:
        for index in range(4):
            response=client.post('/api/jobs',json={'text':f'其他任务{index}。','use_cache':False})
            assert response.status_code==202
            queued.append(response.json()['id'])
        response=client.post('/api/jobs',json=request)
        assert response.status_code==202 and response.json()['cache_hit']
        assert client.post('/api/jobs',json={'text':'队列已满。','use_cache':False}).status_code==429
    finally:
        gate.set()
        for id in queued:wait_job(client,id)


def test_tempo_process_spans_all_text_sentences(client, monkeypatch):
    import tempo_stream
    calls = []
    original = tempo_stream.subprocess.Popen
    def start(args, **kwargs):
        if '-af' in args:
            calls.append(args)
        return original(args, **kwargs)
    monkeypatch.setattr(tempo_stream.subprocess, 'Popen', start)
    text = '这是一段需要分句处理的较长中文测试。' * 7
    assert len(lab.split_text(text)) > 2
    job = client.post('/api/jobs', json={'text':text, 'speed':1.15, 'use_cache':False}).json()
    done = wait_job(client, job['id'])
    assert done['status'] == 'completed', done
    assert len(calls) == 1
    assert done['parts'] and all(part['text'] == text for part in done['parts'])
    assert done['duration'] > .1
