import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from device_protocol import create_device_router
from job_updates import JobUpdates


@pytest.fixture
def protocol():
    updates = JobUpdates()
    state = {'jobs': {}, 'devices': {}, 'saved': [], 'notified': [], 'updates': updates}
    def notify(job_id):
        state['notified'].append(job_id)
        updates.notify(job_id)
    config = {'device_id': 'board', 'device_token': 'test-token'}
    app = FastAPI()
    app.include_router(create_device_router(
        config=config, get_jobs=lambda: state['jobs'], get_devices=lambda: state['devices'],
        lock=threading.RLock(), save_job=lambda job: state['saved'].append(dict(job)),
        notify_job=notify, subscribe_job=updates.subscribe, unsubscribe_job=updates.unsubscribe))
    with TestClient(app) as client:
        client.headers['X-Device-Token'] = 'test-token'
        yield client, state


def job(id='a', **extra):
    return {'id': id, 'created_at': time.time(), 'device_id': 'board',
            'text': '你好，开始显示。', 'status': 'queued', 'parts': [], 'delivery': 'pending',
            'playback_mode': 'stream', **extra}


def claim(client):
    response = client.get('/api/device/board/next')
    assert response.status_code == 200
    return response.json()['task']


def manifest(client, task, after=0):
    return client.get(task['manifest_url'], params={'lease': task['lease'], 'after': after})


def test_claim_queued_text_before_first_audio(protocol):
    client, state = protocol
    state['jobs']['a'] = job()
    task = claim(client)
    assert task['text'] == '你好，开始显示。'
    assert task['audio_url'] is None
    reply = manifest(client, task).json()
    assert reply['parts'] == [] and not reply['finished']
    assert state['jobs']['a']['delivery'] == 'leased'


def test_incremental_manifest_without_waiting_for_complete(protocol):
    client, state = protocol
    source = state['jobs']['a'] = job(status='synthesizing')
    task = claim(client)
    source['parts'].append({'index': 1, 'audio_url': '/api/audio/first.wav', 'duration': .24})
    reply = manifest(client, task).json()
    assert reply['available_parts'] == 1 and not reply['finished']
    assert reply['parts'][0]['index'] == 1
    assert manifest(client, task, after=1).json()['parts'] == []
    source['parts'].append({'index': 2, 'audio_url': '/api/audio/second.wav', 'duration': .2})
    source['status'] = 'completed'
    reply = manifest(client, task, after=1).json()
    assert reply['finished'] and reply['parts'][0]['index'] == 2


def test_one_active_device_lease_includes_buffering(protocol):
    client, state = protocol
    state['jobs']['a'] = job()
    task = claim(client)
    state['jobs']['b'] = job('b')
    response = client.post('/api/device/board/heartbeat', json={
        'job_id': task['id'], 'lease': task['lease'], 'status': 'buffering'})
    assert response.status_code == 200
    assert claim(client) is None
    client.post('/api/device/board/heartbeat', json={
        'job_id': task['id'], 'lease': task['lease'], 'status': 'completed'})
    assert claim(client)['id'] == 'b'


def test_manifest_cancellation_and_failure_are_immediate(protocol):
    client, state = protocol
    source = state['jobs']['a'] = job()
    task = claim(client)
    source['cancel_playback'] = True
    assert manifest(client, task).json()['cancel']
    source['cancel_playback'] = False
    source.update(status='failed', error='model unavailable')
    assert manifest(client, task).json()['error'] == 'model unavailable'
    assert manifest(client, task).json()['finished']


def test_first_i2s_write_measurement_is_monotonic_and_not_overwritten(protocol):
    client, state = protocol
    source = state['jobs']['a'] = job(created_at=time.time() - 3)
    task = claim(client)
    payload = {'job_id': 'a', 'lease': task['lease'], 'status': 'playing',
               'first_audio': True, 'first_audio_elapsed_ms': 20, 'played_parts': 1}
    assert client.post('/api/device/board/heartbeat', json=payload).status_code == 200
    first = source['device_first_audio_seconds']
    assert 2.9 < first < 3.3
    assert source['device_first_audio_measurement'] == 'first_i2s_write'
    client.post('/api/device/board/heartbeat', json={**payload, 'first_audio_elapsed_ms': 900, 'played_parts': 0})
    assert source['device_first_audio_seconds'] == first
    assert source['device_played_parts'] == 1


def test_auth_and_lease_required_for_partial_audio_manifest(protocol):
    client, state = protocol
    state['jobs']['a'] = job()
    task = claim(client)
    assert client.get(task['manifest_url'], params={'lease': 'wrong'}).status_code == 409
    assert client.get(task['manifest_url'], params={'lease': task['lease']},
                      headers={'X-Device-Token': 'wrong'}).status_code == 401


def test_completed_legacy_cache_falls_back_to_one_part(protocol):
    client, state = protocol
    state['jobs']['a'] = job(status='completed', audio_url='/api/audio/complete.wav', duration=1.2)
    task = claim(client)
    reply = manifest(client, task).json()
    assert reply['finished'] and reply['available_parts'] == 1
    assert reply['parts'][0]['audio_url'] == '/api/audio/complete.wav'


def test_backend_restart_expired_lease_cannot_resume_old_audio(protocol):
    client, state = protocol
    source = state['jobs']['a'] = job()
    task = claim(client)
    source['delivery'] = 'expired'
    assert manifest(client, task).status_code == 409
    assert client.post('/api/device/board/heartbeat', json={
        'job_id': 'a', 'lease': task['lease'], 'status': 'playing'}).status_code == 409


def test_targeted_simulator_claim_does_not_consume_other_job(protocol):
    client, state = protocol
    state['jobs']['a'] = job()
    state['jobs']['b'] = job('b')
    reply = client.get('/api/device/board/next', params={'job_id': 'b'}).json()
    assert reply['task']['id'] == 'b'
    assert state['jobs']['a']['delivery'] == 'pending'


def test_simulated_timing_is_never_reported_as_physical_i2s(protocol):
    client, state = protocol
    source = state['jobs']['a'] = job()
    task = claim(client)
    client.post('/api/device/board/heartbeat', json={
        'job_id': 'a', 'lease': task['lease'], 'status': 'playing', 'simulated': True,
        'first_audio': True, 'first_audio_elapsed_ms': 20})
    assert 'device_first_audio_seconds' not in source
    assert source['device_simulated_first_audio_seconds'] >= 0
    assert source['device_delivery_simulated']


def test_protocol_simulator_receives_parts_before_full_synthesis_finishes(protocol):
    import io
    import wave
    from fastapi.responses import Response
    from tools.device_simulator import receive_task

    client, state = protocol
    source = state['jobs']['a'] = job(status='synthesizing')
    source['parts'] = [{'index': 1, 'audio_url': '/audio/first.wav'}]
    with io.BytesIO() as buffer:
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(24000)
            wav.writeframes(b'\x01\x00' * 2400)
        pcm = buffer.getvalue()

    @client.app.get('/audio/first.wav')
    def first_audio():
        assert source['status'] == 'synthesizing'
        source['parts'].append({'index': 2, 'audio_url': '/audio/second.wav'})
        source['status'] = 'completed'
        return Response(pcm, media_type='audio/wav')

    @client.app.get('/audio/second.wav')
    def second_audio():
        return Response(pcm, media_type='audio/wav')

    task = claim(client)
    summary = receive_task(client, '/api/device/board', task, max_wait=5)
    assert summary['parts'] == 2 and summary['simulated']
    assert source['delivery'] == 'delivered'
    assert source['device_delivery_simulated']
    assert 'device_first_audio_seconds' not in source


@pytest.mark.parametrize('late_status', ['playing', 'buffering', 'waiting'])
def test_late_heartbeat_cannot_reactivate_acknowledged_job(protocol, late_status):
    client, state = protocol
    source = state['jobs']['a'] = job(status='completed')
    task = claim(client)
    payload = {'job_id': 'a', 'lease': task['lease'], 'status': 'completed'}
    assert client.post('/api/device/board/heartbeat', json=payload).status_code == 200
    assert source['delivery'] == 'delivered'
    saved_count = len(state['saved'])
    state['jobs']['b'] = job('b')
    reply = client.post('/api/device/board/heartbeat', json={**payload, 'status': late_status})
    assert reply.status_code == 200 and reply.json()['cancel']
    assert source['delivery'] == 'delivered'
    assert len(state['saved']) == saved_count
    closed = manifest(client, task).json()
    assert closed['finished'] and closed['delivery_closed'] and closed['parts'] == []
    next_job = claim(client)
    assert next_job['id'] == 'b'
    client.post('/api/device/board/heartbeat', json={
        'job_id': 'b', 'lease': next_job['lease'], 'status': 'waiting'})
    # Even after the next job starts, an old duplicate final ACK or stale active
    # heartbeat must not overwrite the physical device's current task record.
    assert client.post('/api/device/board/heartbeat', json=payload).json()['already_final']
    client.post('/api/device/board/heartbeat', json={**payload, 'status': late_status})
    assert state['devices']['board']['job_id'] == 'b'
    assert source['delivery'] == 'delivered'


@pytest.mark.parametrize('final_status', ['error', 'completed'])
def test_error_ack_is_final_even_if_delayed_completed_ack_arrives(protocol, final_status):
    client, state = protocol
    source = state['jobs']['a'] = job()
    task = claim(client)
    payload = {'job_id': 'a', 'lease': task['lease'], 'status': 'error', 'error': 'download failed'}
    client.post('/api/device/board/heartbeat', json=payload)
    assert source['delivery'] == 'error'
    client.post('/api/device/board/heartbeat', json={**payload, 'status': 'playing', 'error': ''})
    client.post('/api/device/board/heartbeat', json={**payload, 'status': final_status, 'error': ''})
    assert source['delivery'] == 'error'
    assert source['device_error'] == 'download failed'
    state['jobs']['b'] = job('b')
    assert claim(client)['id'] == 'b'


def test_device_benchmark_submits_uncached_and_consumes_only_its_new_job(protocol):
    import io
    import json
    import wave
    from fastapi import Request
    from fastapi.responses import Response
    from tools.benchmark_device import benchmark

    client, state = protocol
    state['jobs']['unrelated'] = job('unrelated')
    with io.BytesIO() as buffer:
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(24000)
            wav.writeframes(b'\x01\x00' * 1200)
        pcm = buffer.getvalue()

    @client.app.post('/api/jobs')
    async def submit_benchmark(request: Request):
        payload = await request.json()
        assert payload['use_cache'] is False and payload['device_id'] == 'board'
        source = state['jobs']['new-benchmark'] = job('new-benchmark', status='synthesizing')
        source['parts'] = [{'index': 1, 'audio_url': '/audio/one.wav'},
                           {'index': 2, 'audio_url': '/audio/two.wav'}]
        return {'id': 'new-benchmark', 'cache_hit': False}

    @client.app.get('/api/jobs/{job_id}')
    def job_status(job_id: str):
        source = state['jobs'][job_id]
        result = dict(source)
        # The first PCM exists while generation is still running. Finish only
        # after the benchmark observes this first-buffer status.
        source['status'] = 'completed'
        return result

    @client.app.get('/audio/{name}.wav')
    def audio(name: str):
        return Response(pcm, media_type='audio/wav')

    result = benchmark(client, device_id='board', text='端到端测试。', speed=1.0, max_wait=3)
    assert result['success'] and result['simulated']
    assert result['job_id'] == 'new-benchmark' and result['part_count'] == 2
    assert result['first_buffer_job_status'] == 'synthesizing'
    assert result['first_buffer_from_submit_s'] >= result['claim_to_first_buffer_s'] >= 0
    assert all(part['download_ms'] >= 0 and part['duration_s'] == .05 for part in result['parts'])
    assert state['jobs']['unrelated']['delivery'] == 'pending'
    assert state['jobs']['new-benchmark']['delivery'] == 'delivered'
    assert 'device_first_audio_seconds' not in state['jobs']['new-benchmark']
    assert state['jobs']['new-benchmark']['lease'] not in json.dumps(result)


def test_benchmark_redacts_lease_urls_and_private_tokens():
    from tools.benchmark_device import redact
    result = redact({'error': "http://localhost/manifest?lease=secret-lease&after=1 'client-secret'", 'parts': []},
                    ['client-secret'])
    assert 'secret-lease' not in result['error'] and 'client-secret' not in result['error']


def test_first_download_timing_and_device_kind_are_isolated(protocol):
    client, state = protocol
    physical = state['jobs']['physical'] = job('physical')
    task = claim(client)
    payload = {'job_id': task['id'], 'lease': task['lease'], 'status': 'playing',
               'first_download_elapsed_ms': 123}
    client.post('/api/device/board/heartbeat', json=payload)
    assert physical['device_download_seconds'] == .123
    assert 'device_simulated_download_seconds' not in physical
    assert state['devices']['board']['simulated'] is False
    client.post('/api/device/board/heartbeat', json={**payload, 'first_download_elapsed_ms': 999})
    assert physical['device_download_seconds'] == .123
    client.post('/api/device/board/heartbeat', json={**payload, 'status': 'completed'})

    simulated = state['jobs']['simulated'] = job('simulated')
    task = claim(client)
    client.post('/api/device/board/heartbeat', json={
        'job_id': task['id'], 'lease': task['lease'], 'status': 'playing',
        'first_download_elapsed_ms': 45, 'simulated': True})
    assert simulated['device_simulated_download_seconds'] == .045
    assert 'device_download_seconds' not in simulated
    assert state['devices']['board']['simulated'] is True


def test_job_notifications_cover_claim_metrics_and_delivery_but_ignore_invalid_or_stale(protocol):
    client, state = protocol
    state['jobs']['a'] = job()
    task = claim(client)
    assert state['notified'] == ['a']
    # Read-only polling and rejected leases must not produce job updates.
    manifest(client, task)
    client.post('/api/device/board/heartbeat', json={
        'job_id': 'a', 'lease': 'wrong', 'status': 'playing'})
    assert state['notified'] == ['a']
    payload = {'job_id': 'a', 'lease': task['lease'], 'status': 'playing',
               'first_audio': True, 'first_audio_elapsed_ms': 5}
    client.post('/api/device/board/heartbeat', json=payload)
    client.post('/api/device/board/heartbeat', json={**payload, 'status': 'completed'})
    assert state['notified'] == ['a', 'a', 'a']
    client.post('/api/device/board/heartbeat', json=payload)
    assert state['notified'] == ['a', 'a', 'a']


def test_manifest_long_poll_wakes_on_new_audio_and_removes_subscription(protocol):
    client, state = protocol
    source = state['jobs']['a'] = job(status='synthesizing')
    task = claim(client)
    result = {}
    def wait_manifest():
        result.update(client.get(task['manifest_url'], params={
            'lease': task['lease'], 'after': 0, 'wait_ms': 500}).json())
    thread = threading.Thread(target=wait_manifest)
    thread.start()
    deadline = time.monotonic() + 1
    while not state['updates'].pending_count and time.monotonic() < deadline:
        time.sleep(.001)
    assert state['updates'].pending_count == 1
    source['parts'].append({'index': 1, 'audio_url': '/api/audio/first.wav'})
    state['updates'].notify('a')
    thread.join(timeout=1)
    assert not thread.is_alive()
    assert result['parts'][0]['index'] == 1 and not result['finished']
    assert state['updates'].pending_count == 0


def test_manifest_timeout_and_invalid_lease_remove_subscription(protocol):
    client, state = protocol
    state['jobs']['a'] = job()
    task = claim(client)
    params = {'lease': task['lease'], 'after': 0, 'wait_ms': 5}
    assert client.get(task['manifest_url'], params=params).json()['parts'] == []
    assert state['updates'].pending_count == 0
    assert client.get(task['manifest_url'], params={**params, 'lease': 'wrong'}).status_code == 409
    assert state['updates'].pending_count == 0
