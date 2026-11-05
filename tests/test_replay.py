"""Existing audio replay creates delivery work, never another inference request."""
import copy
import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app as lab
from test_protocol import client, wait_job


def generate_source(client):
    submitted = client.post('/api/jobs', json={
        'text': '重复播放测试。' * 8, 'voice': 'Serena', 'use_cache': False,
        'display_mode': 'wave',
    }).json()
    return wait_job(client, submitted['id'])


def replay(client, source, **options):
    return client.post('/api/jobs/' + source['id'] + '/replay', json={
        'device_id': lab.CONFIG['device_id'], **options,
    })


def audio_hashes():
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in lab.OUTPUT.glob('*.wav')}


def test_replay_uses_existing_audio_without_cache_or_inference(client, monkeypatch):
    source = generate_source(client)
    assert source['status'] == 'completed' and len(source['parts']) > 1
    before = copy.deepcopy(lab.jobs[source['id']])
    files = audio_hashes()
    calls = lab.engine.calls
    for cache in (lab.OUTPUT / 'cache').glob('*.json'):
        cache.unlink()

    def forbid_submission(*args, **kwargs):
        raise AssertionError('Replay must not submit model work')

    monkeypatch.setattr(lab.executor, 'submit', forbid_submission)
    response = replay(client, source)
    assert response.status_code == 202
    job = response.json()
    assert job['id'] != source['id'] and job['replay_of'] == source['id']
    assert job['status'] == 'completed' and job['delivery'] == 'pending'
    assert job['playback_mode'] == 'complete' and job['playback_ready']
    assert job['playback_ready_seconds'] == 0
    assert job['cache_hit'] and job['reused_audio']
    assert job['audio_url'] == source['audio_url'] and job['parts'] == source['parts']
    assert job['display_mode'] == 'wave'
    for metric in ('first_audio_seconds', 'inference_seconds', 'processing_seconds',
                   'worker_seconds', 'total_seconds', 'queued_seconds', 'rtf'):
        assert job[metric] == 0
    assert lab.engine.calls == calls and audio_hashes() == files
    assert lab.jobs[source['id']] == before
    assert (lab.OUTPUT / 'history' / (job['id'] + '.json')).is_file()


def test_replay_resets_delivery_state_and_has_independent_device_lease(client):
    source = generate_source(client)
    original = lab.jobs[source['id']]
    original.update(device_id=lab.CONFIG['device_id'], delivery='error',
                    lease='old-lease', lease_until=1, cancel_playback=True,
                    device_error='old failure', device_claimed_at=1,
                    device_first_audio_seconds=99, device_download_seconds=88,
                    device_played_parts=50, device_delivery_simulated=True)
    before = copy.deepcopy(original)
    replayed = replay(client, source, display_mode='text').json()
    assert replayed['display_mode'] == 'text'
    assert replayed['device_first_audio_seconds'] is None
    for stale in ('lease', 'lease_until', 'cancel_playback', 'device_error',
                  'device_claimed_at', 'device_download_seconds', 'device_played_parts',
                  'device_delivery_simulated'):
        assert stale not in replayed

    device = lab.CONFIG['device_id']
    headers = {'X-Device-Token': lab.CONFIG['device_token']}
    base = '/api/device/' + device
    task = client.get(base + '/next', headers=headers).json()['task']
    assert task['id'] == replayed['id'] and task['lease'] != 'old-lease'
    manifest_path = task['manifest_url'] + '?lease=' + task['lease']
    manifest = client.get(manifest_path, headers=headers).json()
    assert manifest['finished'] and not manifest['cancel'] and not manifest['error']
    assert manifest['parts'] == source['parts']
    assert manifest['display_mode'] == 'text'
    for part in manifest['parts']:
        assert client.get(part['audio_url'], headers=headers).content.startswith(b'RIFF')
    body = {'job_id': task['id'], 'lease': task['lease'], 'status': 'playing',
            'first_audio': True, 'first_audio_elapsed_ms': 1, 'played_parts': 1}
    assert client.post(base + '/heartbeat', headers=headers, json=body).status_code == 200
    body.update(status='completed', played_parts=len(manifest['parts']))
    assert client.post(base + '/heartbeat', headers=headers, json=body).status_code == 200
    finished = client.get('/api/jobs/' + replayed['id']).json()
    assert finished['delivery'] == 'delivered'
    assert finished['device_played_parts'] == len(source['parts'])
    assert finished['device_first_audio_seconds'] < 1
    assert lab.jobs[source['id']] == before
    assert client.get(base + '/next', headers=headers).json()['task'] is None


def test_replay_of_replay_keeps_lineage_and_does_not_cancel_other_playback(client):
    source = generate_source(client)
    first = replay(client, source).json()
    second = replay(client, first, display_mode='buddy').json()
    assert len({source['id'], first['id'], second['id']}) == 3
    assert second['replay_of'] == source['id']
    assert second['parts'] == source['parts']
    client.post('/api/jobs/' + first['id'] + '/cancel')
    assert lab.jobs[first['id']]['delivery'] == 'cancelled'
    assert lab.jobs[second['id']]['delivery'] == 'pending'
    assert lab.jobs[source['id']]['delivery'] is None


def test_replay_accepts_legacy_full_wav_without_parts(client):
    source = generate_source(client)
    lab.jobs[source['id']]['parts'] = []
    job = replay(client, source).json()
    assert job['total_parts'] == 1
    assert job['parts'][0]['index'] == 1
    assert job['parts'][0]['audio_url'] == source['audio_url']


@pytest.mark.parametrize('state', ['queued', 'loading', 'synthesizing', 'failed', 'cancelled'])
def test_replay_rejects_incomplete_or_unsuccessful_generation(client, state):
    source = generate_source(client)
    lab.jobs[source['id']]['status'] = state
    before = set(lab.jobs)
    assert replay(client, source).status_code == 409
    assert set(lab.jobs) == before


def test_replay_rejects_missing_record_or_invalid_request(client):
    source = generate_source(client)
    assert replay(client, {'id': 'f' * 32}).status_code == 404
    assert replay(client, source, device_id='unknown').status_code == 422
    assert replay(client, source, display_mode='invalid').status_code == 422
    assert client.post('/api/jobs/' + source['id'] + '/replay', json={}).status_code == 422


@pytest.mark.parametrize('missing', ['audio_url', 'part'])
def test_replay_rejects_deleted_audio_without_regenerating(client, monkeypatch, missing):
    source = generate_source(client)
    url = source['audio_url'] if missing == 'audio_url' else source['parts'][0]['audio_url']
    (lab.OUTPUT / Path(url).name).unlink()
    calls = lab.engine.calls
    before = set(lab.jobs)
    assert replay(client, source).status_code == 404
    assert lab.engine.calls == calls and set(lab.jobs) == before


@pytest.mark.parametrize('url', ['../private.wav', 'https://example.invalid/audio.wav',
                                '/api/audio/' + 'a' * 32 + '.wav?other=1'])
def test_replay_rejects_unsafe_saved_audio_references(client, url):
    source = generate_source(client)
    lab.jobs[source['id']]['parts'][0]['audio_url'] = url
    assert replay(client, source).status_code == 404


def test_replay_checks_part_sequence(client):
    source = generate_source(client)
    lab.jobs[source['id']]['parts'][0]['index'] = 4
    assert replay(client, source).status_code == 409


def test_replay_queue_is_bounded_and_cancel_frees_capacity(client):
    source = generate_source(client)
    queued = [replay(client, source) for _ in range(4)]
    assert all(response.status_code == 202 for response in queued)
    assert replay(client, source).status_code == 429
    client.post('/api/jobs/' + queued[0].json()['id'] + '/cancel')
    assert replay(client, source).status_code == 202


def test_replay_requires_client_auth_and_rejects_cross_site_writes(client):
    source = generate_source(client)
    path = '/api/jobs/' + source['id'] + '/replay'
    body = {'device_id': lab.CONFIG['device_id']}
    with TestClient(lab.app, client=('192.168.1.90', 1234)) as remote:
        assert remote.post(path, json=body).status_code == 401
        assert remote.post(path, json=body, headers={
            'X-Device-Token': lab.CONFIG['device_token'],
        }).status_code == 401
        assert remote.post(path, json=body, headers={
            'X-Client-Token': lab.CONFIG['client_token'], 'Origin': 'https://evil.invalid',
        }).status_code == 403
        assert remote.post(path, json=body, headers={
            'X-Client-Token': lab.CONFIG['client_token'],
        }).status_code == 202
