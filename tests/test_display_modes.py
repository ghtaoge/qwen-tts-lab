"""OLED presentation travels with a task and never invalidates its TTS cache."""
import pytest
import shutil
import subprocess
from pathlib import Path

import app as lab
from test_protocol import client, wait_job


def test_modes_reuse_audio_and_reach_the_exact_device_task(client):
    headers = {'X-Device-Token':lab.CONFIG['device_token']}
    device = '/api/device/' + lab.CONFIG['device_id']
    reference = None
    for index, mode in enumerate(('buddy', 'wave', 'text')):
        response = client.post('/api/jobs', json={'text':'和我一起说你好。', 'display_mode':mode,
                                                 'device_id':lab.CONFIG['device_id']})
        assert response.status_code == 202
        job = wait_job(client, response.json()['id'])
        assert job['display_mode'] == mode and job['status'] == 'completed'
        if reference is None:
            reference = job['audio_url']
        else:
            assert job['cache_hit'] and job['audio_url'] == reference
        assert lab.engine.calls == 1
        task = client.get(device + '/next', params={'job_id':job['id']}, headers=headers).json()['task']
        assert task['id'] == job['id'] and task['display_mode'] == mode
        manifest = client.get(task['manifest_url'], params={'lease':task['lease']}, headers=headers).json()
        assert manifest['display_mode'] == mode and manifest['parts']
        ack = client.post(device + '/heartbeat', headers=headers, json={
            'job_id':job['id'], 'lease':task['lease'], 'status':'completed', 'simulated':True})
        assert ack.status_code == 200


def test_old_client_defaults_to_buddy(client):
    response = client.post('/api/jobs', json={'text':'旧版客户端。'})
    assert response.status_code == 202 and response.json()['display_mode'] == 'buddy'
    assert wait_job(client, response.json()['id'])['status'] == 'completed'


@pytest.mark.parametrize('value', ['unknown', None, 1, {}])
def test_invalid_mode_does_not_start_model(client, value):
    response = client.post('/api/jobs', json={'text':'屏幕模式测试。', 'display_mode':value})
    assert response.status_code == 422 and lab.engine.calls == 0


def test_mini_screen_modes_do_not_add_requests_and_follow_actual_lifecycle():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js unavailable')
    result = subprocess.run([node, str(Path(__file__).with_name('mini_screen_modes.cjs'))],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
