import asyncio
import threading
import time

import app as lab
from job_updates import JobUpdates
from test_protocol import client, wait_job


def wait_until(predicate):
    deadline = time.monotonic() + 2
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError('Update waiter did not reach expected state')
        time.sleep(.005)


def test_cross_thread_notification_wakes_all_and_cancelled_waiter_is_safe():
    updates = JobUpdates()
    async def scenario():
        first, second, cancelled = [updates.subscribe('job') for _ in range(3)]
        cancelled.cancel()
        await asyncio.to_thread(updates.notify, 'job')
        await asyncio.wait_for(asyncio.gather(first, second), 1)
        assert updates.pending_count == 0
        assert cancelled.cancelled()
    asyncio.run(scenario())


def test_closed_client_loop_does_not_break_model_thread():
    updates = JobUpdates()
    async def subscribe():
        return updates.subscribe('job')
    asyncio.run(subscribe())
    updates.notify('job')
    assert updates.pending_count == 0


def test_revision_ignores_lease_renewal_but_tracks_device_timing_and_parts():
    job = {'id':'id', 'status':'synthesizing', 'parts':[], 'lease':'one', 'lease_until':1}
    original = lab.job_revision(job)
    job.update(lease='two', lease_until=2)
    assert lab.job_revision(job) == original
    job['parts'].append({'index':1})
    part = lab.job_revision(job)
    assert part != original
    job['device_first_audio_seconds'] = .4
    assert lab.job_revision(job) != part


def blocked_job(client):
    gate, generating = threading.Event(), threading.Event()
    original = lab.engine.generate
    def generate(*args):
        generating.set()
        gate.wait(3)
        return original(*args)
    lab.engine.generate = generate
    job = client.post('/api/jobs', json={'text':'通知测试。', 'use_cache':False}).json()
    assert generating.wait(2)
    return gate, client.get('/api/jobs/' + job['id']).json()


def test_long_poll_wakes_on_first_packet_and_does_not_block_control_api(client):
    gate, snapshot = blocked_job(client)
    replies = []
    def receive():
        replies.append(client.get('/api/jobs/' + snapshot['id'], params={
            'revision':snapshot['revision'], 'after_parts':0, 'wait_ms':1500}))
    thread = threading.Thread(target=receive)
    thread.start()
    try:
        wait_until(lambda: lab.updates.pending_count > 0)
        assert client.get('/api/status').status_code == 200
        gate.set()
        thread.join(2)
        assert not thread.is_alive()
        job = replies[0].json()
        assert job['parts'] and job['revision'] != snapshot['revision']
        assert 'lease' not in job
    finally:
        gate.set()
        thread.join(3)
        wait_job(client, snapshot['id'])
    assert lab.updates.pending_count == 0


def test_long_poll_timeout_cleans_waiter_and_newer_snapshot_returns_immediately(client):
    gate, snapshot = blocked_job(client)
    try:
        response = client.get('/api/jobs/' + snapshot['id'], params={
            'revision':snapshot['revision'], 'wait_ms':30})
        assert response.status_code == 200
        assert response.json()['revision'] == snapshot['revision']
        assert lab.updates.pending_count == 0
        latest = client.get('/api/jobs/' + snapshot['id'], params={
            'revision':'outdated', 'wait_ms':1000})
        assert latest.json()['revision'] == snapshot['revision']
        assert lab.updates.pending_count == 0
        assert client.get('/api/jobs/' + snapshot['id'], params={'wait_ms':2001}).status_code == 422
    finally:
        gate.set()
        wait_job(client, snapshot['id'])


def test_cancel_wakes_pending_snapshot_without_waiting_for_gpu(client):
    gate, snapshot = blocked_job(client)
    replies = []
    thread = threading.Thread(target=lambda: replies.append(client.get(
        '/api/jobs/' + snapshot['id'], params={'revision':snapshot['revision'], 'wait_ms':1500})))
    thread.start()
    try:
        wait_until(lambda: lab.updates.pending_count > 0)
        client.post('/api/jobs/' + snapshot['id'] + '/cancel')
        thread.join(2)
        assert not thread.is_alive()
        assert replies[0].json()['revision'] != snapshot['revision']
    finally:
        gate.set()
        thread.join(3)
        wait_job(client, snapshot['id'])
    assert lab.updates.pending_count == 0


def test_device_ack_wakes_completed_job_with_pending_delivery(client):
    device_id = lab.CONFIG['device_id']
    headers = {'X-Device-Token':lab.CONFIG['device_token']}
    job = client.post('/api/jobs', json={'text':'设备通知。', 'device_id':device_id, 'use_cache':False}).json()
    wait_job(client, job['id'])
    task = client.get(f'/api/device/{device_id}/next', headers=headers).json()['task']
    snapshot = client.get('/api/jobs/' + job['id']).json()
    replies = []
    thread = threading.Thread(target=lambda: replies.append(client.get(
        '/api/jobs/' + job['id'], params={'revision':snapshot['revision'],
                                        'after_parts':len(snapshot['parts']), 'wait_ms':1500})))
    thread.start()
    try:
        wait_until(lambda: lab.updates.pending_count > 0)
        ack = client.post(f'/api/device/{device_id}/heartbeat', headers=headers, json={
            'job_id':job['id'], 'lease':task['lease'], 'status':'completed',
            'first_audio':True, 'first_audio_elapsed_ms':10})
        assert ack.status_code == 200
        thread.join(2)
        assert not thread.is_alive()
        latest = replies[0].json()
        assert latest['delivery'] == 'delivered'
        assert latest['device_first_audio_seconds'] is not None
    finally:
        thread.join(3)
    assert lab.updates.pending_count == 0
