"""Complete-first delivery keeps a slow producer from starving audio playback."""
import threading
import time

import numpy as np
import pytest

import app as lab
from test_protocol import client, wait_job


def blocked_stream(client, *, failure=False):
    published, finish = threading.Event(), threading.Event()

    def generate(*args):
        cancelled = args[-1]
        yield np.full(2400, .1, dtype=np.float32), 24000, .01, None
        published.set()
        if not finish.wait(5):
            raise RuntimeError('test producer was not released')
        lab.check_cancel(cancelled)
        if failure:
            raise RuntimeError('deliberate synthesis failure')
        yield np.full(2400, .2, dtype=np.float32), 24000, .02, None

    lab.engine.generate_stream = generate
    job = client.post('/api/jobs', json={
        'text': '整句转换完成后再播放。', 'device_id': lab.CONFIG['device_id'], 'use_cache': False,
    }).json()
    assert published.wait(2)
    return job, finish


def device_headers():
    return {'X-Device-Token': lab.CONFIG['device_token']}


def claim(client):
    return client.get('/api/device/' + lab.CONFIG['device_id'] + '/next', headers=device_headers()).json()['task']


def manifest(client, task, **params):
    return client.get(task['manifest_url'], params={'lease': task['lease'], **params},
                      headers=device_headers())


def test_default_hides_early_chunks_from_client_device_and_direct_download(client):
    initial, finish = blocked_stream(client)
    thread = None
    try:
        assert initial['playback_mode'] == 'complete' and not initial['playback_ready']
        source = lab.jobs[initial['id']]
        assert len(source['parts']) == 1, 'the producer really has published a valid early chunk'
        early_url = source['parts'][0]['audio_url']
        assert (lab.OUTPUT / early_url.rsplit('/', 1)[-1]).is_file()
        # An older saved record without a policy must be complete-first too.
        source.pop('playback_mode')
        current = client.get('/api/jobs/' + initial['id']).json()
        assert current['status'] == 'synthesizing'
        assert current['parts'] == [] and current['audio_url'] is None and not current['playback_ready']
        assert current['playback_mode'] == 'complete'
        assert current['first_audio_seconds'] is None and current['playback_ready_seconds'] is None
        assert current['first_generated_part_seconds'] == source['first_audio_seconds'] is not None
        listed = next(job for job in client.get('/api/jobs').json() if job['id'] == initial['id'])
        assert listed['parts'] == [] and listed['audio_url'] is None
        assert client.get(early_url).status_code == 409

        task = claim(client)
        assert task['id'] == initial['id'] and task['playback_mode'] == 'complete'
        assert not task['playback_ready'] and task['audio_url'] is None
        pending = manifest(client, task).json()
        assert pending['parts'] == [] and pending['available_parts'] == 0
        assert not pending['finished'] and not pending['playback_ready']
        current = client.get('/api/jobs/' + initial['id']).json()

        # Hidden internal fragments must not make after_parts=0 spin instead
        # of waiting for a revision/timeout when nothing playable has changed.
        started = time.monotonic()
        unchanged = client.get('/api/jobs/' + initial['id'], params={
            'revision': current['revision'], 'after_parts': 0, 'wait_ms': 75,
        }).json()
        assert time.monotonic() - started >= .04
        assert unchanged['revision'] == current['revision'] and unchanged['parts'] == []

        reply = {}
        thread = threading.Thread(target=lambda: reply.update(manifest(client, task, wait_ms=500).json()))
        thread.start()
        deadline = time.monotonic() + 1
        while not lab.updates.pending_count and time.monotonic() < deadline:
            time.sleep(.002)
        assert lab.updates.pending_count
        finish.set()
        completed = wait_job(client, initial['id'])
        thread.join(2)
        assert not thread.is_alive()
        assert completed['playback_ready'] and len(completed['parts']) == 2
        assert completed['first_audio_seconds'] == completed['playback_ready_seconds'] == completed['total_seconds']
        assert completed['first_generated_part_seconds'] == source['first_audio_seconds']
        assert completed['audio_url'] and completed['delivery'] == 'leased'
        assert reply['finished'] and reply['playback_ready'] and len(reply['parts']) == 2
        assert client.get(early_url).status_code == 200
        assert client.get(completed['audio_url']).content.startswith(b'RIFF')
        assert lab.updates.pending_count == 0
    finally:
        finish.set()
        if thread:
            thread.join(2)
        wait_job(client, initial['id'])


@pytest.mark.parametrize('terminal', ['failed', 'cancelled'])
def test_complete_mode_never_exposes_partial_audio_after_failure_or_stop(client, terminal):
    initial, finish = blocked_stream(client, failure=terminal == 'failed')
    try:
        task = claim(client)
        early_url = lab.jobs[initial['id']]['parts'][0]['audio_url']
        if terminal == 'cancelled':
            stopped = client.post('/api/jobs/' + initial['id'] + '/cancel').json()
            assert stopped['parts'] == [] and not stopped['playback_ready']
            assert manifest(client, task).json()['cancel']
        finish.set()
        done = wait_job(client, initial['id'])
        assert done['status'] == terminal
        assert done['parts'] == [] and done['audio_url'] is None and not done['playback_ready']
        assert done['first_audio_seconds'] is None and done['playback_ready_seconds'] is None
        closed = manifest(client, task).json()
        assert closed['finished'] and closed['parts'] == [] and not closed['playback_ready']
        if terminal == 'failed':
            assert closed['error'] == 'deliberate synthesis failure'
        assert client.get(early_url).status_code == 409
    finally:
        finish.set()
        wait_job(client, initial['id'])


def test_cached_audio_is_ready_immediately_and_policy_does_not_invalidate_cache(client):
    request = {'text': '缓存音频转换已完成。', 'device_id': lab.CONFIG['device_id']}
    source = client.post('/api/jobs', json={**request, 'playback_mode': 'stream'}).json()
    source = wait_job(client, source['id'])
    calls = lab.engine.calls
    source_lease = claim(client)
    client.post('/api/device/' + lab.CONFIG['device_id'] + '/heartbeat', headers=device_headers(), json={
        'job_id': source['id'], 'lease': source_lease['lease'], 'status': 'completed', 'simulated': True,
    })
    cached = client.post('/api/jobs', json=request).json()
    assert cached['playback_mode'] == 'complete' and cached['playback_ready'] and cached['cache_hit']
    assert cached['first_audio_seconds'] == cached['playback_ready_seconds'] == 0
    assert cached['parts'] == source['parts'] and cached['audio_url'] == source['audio_url']
    assert lab.engine.calls == calls
    task = claim(client)
    assert task['id'] == cached['id'] and task['playback_ready']
    reply = manifest(client, task).json()
    assert reply['finished'] and reply['playback_ready'] and reply['parts']


@pytest.mark.parametrize('mode', ['partial', '', None, {}, True])
def test_invalid_playback_policy_does_not_start_inference(client, mode):
    response = client.post('/api/jobs', json={'text': '播放策略校验。', 'playback_mode': mode})
    assert response.status_code == 422 and lab.engine.calls == 0
