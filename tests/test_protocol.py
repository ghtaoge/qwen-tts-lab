"""Protocol regression tests use a fake engine; the actual app never generates dummy audio."""
import threading
import time
import wave
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
import app as lab


class FakeEngine:
    device='cpu'
    precision='float32'
    calls=0
    def ensure_loaded(self): pass
    def hardware(self): return {'gpu_name':None}
    def generate(self,text,voice,language,event):
        lab.check_cancel(event)
        self.calls+=1
        return np.zeros(2400,dtype=np.float32),24000,.02,None


@pytest.fixture
def client(tmp_path,monkeypatch):
    deadline=time.time()+5
    while lab.cancel_events and time.time()<deadline: time.sleep(.01)
    for folder in ['history','cache']: (tmp_path/folder).mkdir()
    monkeypatch.setattr(lab,'OUTPUT',tmp_path)
    monkeypatch.setattr(lab,'jobs',{})
    monkeypatch.setattr(lab,'cancel_events',{})
    monkeypatch.setattr(lab,'devices',{})
    monkeypatch.setattr(lab,'engine',FakeEngine())
    with TestClient(lab.app) as client: yield client


def wait_job(client,job_id):
    for _ in range(300):
        job=client.get('/api/jobs/'+job_id).json()
        if job['status'] in lab.TERMINAL: return job
        time.sleep(.01)
    raise AssertionError('worker timeout')


def test_real_wav_format_and_cache_does_not_repeat_inference(client):
    request={'text':'你好。欢迎回来！','voice':'Serena'}
    job=client.post('/api/jobs',json=request).json()
    done=wait_job(client,job['id'])
    assert done['status']=='completed',done
    assert done['sample_rate']==24000 and done['duration']>.0
    assert client.get(done['audio_url']).content.startswith(b'RIFF')
    calls=lab.engine.calls
    cached=client.post('/api/jobs',json=request).json()
    assert cached['cache_hit'] and cached['status']=='completed'
    assert lab.engine.calls==calls
    uncached=client.post('/api/jobs',json={**request,'use_cache':False}).json()
    assert wait_job(client,uncached['id'])['status']=='completed'
    assert lab.engine.calls>calls


def test_input_validation_and_cross_site_write(client):
    for data in [{'text':'  '},{'text':'你'*301},{'text':'你好','voice':'unknown'},{'text':'你好','speed':5}, {'text':'你好','device_id':'unknown'}]:
        assert client.post('/api/jobs',json=data).status_code==422
    assert client.post('/api/jobs',json={'text':'你好'},headers={'Origin':'https://evil.example'}).status_code==403
    assert client.get('/api/audio/../server.local.json').status_code==404


def test_device_auth_lease_volume_cancel_and_ack(client):
    id=lab.CONFIG['device_id']
    headers={'X-Device-Token':lab.CONFIG['device_token']}
    base='/api/device/'+id
    assert client.get(base+'/next').status_code==401
    job=client.post('/api/jobs',json={'text':'设备测试。','device_id':id}).json()
    done=wait_job(client,job['id'])
    assert done['delivery']=='pending'
    task=client.get(base+'/next',headers=headers).json()['task']
    assert task['id']==job['id']
    assert client.get(base+'/next',headers=headers).json()['task'] is None
    payload={'job_id':task['id'],'lease':task['lease'],'status':'playing'}
    assert client.post(base+'/heartbeat',headers=headers,json={**payload,'lease':'wrong'}).status_code==409
    client.post('/api/devices/'+id+'/volume',json={'volume':32})
    reply=client.post(base+'/heartbeat',headers=headers,json=payload).json()
    assert reply['volume']==32 and not reply['cancel']
    client.post('/api/jobs/'+job['id']+'/cancel')
    assert client.post(base+'/heartbeat',headers=headers,json=payload).json()['cancel']
    client.post(base+'/heartbeat',headers=headers,json={**payload,'status':'completed'})
    assert client.get(base+'/next',headers=headers).json()['task'] is None


def test_split_never_drops_text_or_creates_overlarge_chunks():
    text='这是长句，'*45+'结束。Hello world!你好！'
    parts=lab.split_text(text)
    assert ''.join(parts)==text
    assert all(0<len(part)<=60 for part in parts)


def test_queued_cancellation_is_observed(client):
    gate=threading.Event()
    original=lab.engine.generate
    def block(*args):
        gate.wait(3)
        return original(*args)
    lab.engine.generate=block
    first=client.post('/api/jobs',json={'text':'第一个任务。','use_cache':False}).json()
    second=client.post('/api/jobs',json={'text':'第二个任务。','use_cache':False}).json()
    cancelled=client.post('/api/jobs/'+second['id']+'/cancel').json()
    assert cancelled['status']=='cancelled'  # Release queue admission before the first inference ends.
    gate.set()
    assert wait_job(client,first['id'])['status']=='completed'
    assert wait_job(client,second['id'])['status']=='cancelled'


def test_lan_requires_client_token(client):
    with TestClient(lab.app,client=('192.168.1.90',1234)) as remote:
        assert remote.get('/api/jobs').status_code==401
        assert remote.get('/api/jobs',headers={'X-Client-Token':lab.CONFIG['client_token']}).status_code==200


def test_volume_does_not_mark_offline_device_online(client):
    client.post('/api/devices/'+lab.CONFIG['device_id']+'/volume',json={'volume':20})
    assert not client.get('/api/devices').json()[0]['online']


def test_atempo_preserves_duration_ratio(client):
    audio=np.sin(2*np.pi*440*np.arange(24000)/24000).astype(np.float32)*.1
    changed=lab.process_speed(audio,24000,1.25)
    assert .72<len(changed)/len(audio)<.88
