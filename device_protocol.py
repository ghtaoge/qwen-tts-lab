"""Authenticated, leased, incremental audio delivery for the ESP32.

The getters deliberately resolve current app state, so protocol tests can replace
the backing dictionaries and the model worker can publish parts concurrently.
"""
from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field


class DeviceHeartbeat(BaseModel):
    job_id: str | None = None
    lease: str | None = None
    status: str = Field(default='idle', pattern='^(idle|waiting|buffering|playing|completed|error)$')
    error: str = Field(default='', max_length=300)
    played_parts: int = Field(default=0, ge=0)
    first_audio: bool = False
    first_audio_elapsed_ms: int | None = Field(default=None, ge=0)
    first_download_elapsed_ms: int | None = Field(default=None, ge=0)
    simulated: bool = False


def create_device_router(*, config: dict, get_jobs: Callable, get_devices: Callable,
                         lock, save_job: Callable, lease_seconds=30.0,
                         notify_job: Callable = lambda job_id: None,
                         subscribe_job: Callable | None = None,
                         unsubscribe_job: Callable | None = None):
    if (subscribe_job is None) != (unsubscribe_job is None):
        raise ValueError('subscribe_job and unsubscribe_job must be supplied together')
    router = APIRouter(prefix='/api/device', tags=['device'])
    final_delivery = {'delivered', 'error', 'cancelled'}

    def auth(device_id: str, request: Request):
        if device_id != config['device_id'] or not secrets.compare_digest(
                request.headers.get('x-device-token', ''), config['device_token']):
            raise HTTPException(401, '设备认证失败')

    def device_record(device_id: str):
        value = get_devices().setdefault(device_id, {
            'volume': 70, 'last_seen': 0, 'status': 'idle', 'job_id': None})
        value['last_seen'] = time.time()
        return value

    def leased_job(device_id: str, job_id: str, lease: str):
        job = get_jobs().get(job_id)
        if (not job or job.get('device_id') != device_id or not lease
                or job.get('delivery') == 'expired'
                or not secrets.compare_digest(lease, job.get('lease', ''))):
            raise HTTPException(409, '任务租约已失效')
        # A new claim replaces the token. Completed/failed synthesis must still be
        # readable by its current player until the final ACK is sent.
        if job.get('delivery') not in final_delivery:
            job['lease_until'] = time.time() + lease_seconds
        return job

    def snapshot(device_id: str, job: dict, after: int):
        record = device_record(device_id)
        playback_ready = bool(job.get('status') == 'completed' and job.get('audio_url'))
        complete_only = job.get('playback_mode', 'complete') != 'stream'
        if job.get('delivery') in final_delivery:
            # A delayed request carrying the old valid token must not receive
            # audio again after an ACK or error. Keep this lease readable only
            # as a closed manifest so the old player stops safely.
            return {'id': job['id'], 'status': job.get('status'), 'parts': [],
                    'available_parts': len(job.get('parts', [])) if not complete_only or playback_ready else 0, 'finished': True,
                    'cancel': True, 'error': job.get('device_error') if job.get('delivery') == 'error' else None,
                    'volume': record['volume'], 'poll_after_ms': 60, 'delivery_closed': True,
                    'display_mode': job.get('display_mode', 'buddy'),
                    'playback_mode': job.get('playback_mode', 'complete'), 'playback_ready': playback_ready}
        source = list(job.get('parts', [])) if not complete_only or playback_ready else []
        # Backward compatibility for an old completed cache with only one WAV.
        if not source and job.get('status') == 'completed' and job.get('audio_url'):
            source = [{'index': 1, 'audio_url': job['audio_url'],
                       'duration': job.get('duration'), 'text': job.get('text', '')}]
        source.sort(key=lambda part: part['index'])
        terminal = job.get('status') in {'completed', 'cancelled', 'failed'}
        cancelled = bool(job.get('cancel_playback') or job.get('status') == 'cancelled')
        return {
            'id': job['id'], 'status': job.get('status'),
            'parts': [dict(part) for part in source if part['index'] > after][:16],
            'available_parts': len(source), 'finished': terminal,
            'cancel': cancelled, 'error': job.get('error') if job.get('status') == 'failed' else None,
            'volume': record['volume'], 'poll_after_ms': 60,
            'display_mode': job.get('display_mode', 'buddy'),
            'playback_mode': job.get('playback_mode', 'complete'), 'playback_ready': playback_ready,
        }

    @router.get('/{device_id}/next')
    async def next_task(device_id: str, request: Request,
                        wait_ms: int = Query(default=0, ge=0, le=2000),
                        job_id: str | None = Query(default=None, min_length=1, max_length=64)):
        auth(device_id, request)
        deadline = time.monotonic() + wait_ms / 1000
        while True:
            with lock:
                device_record(device_id)
                candidates = sorted(get_jobs().values(), key=lambda job: job['created_at'])
                now = time.time()
                active = any(
                    job.get('device_id') == device_id
                    and job.get('delivery') in {'leased', 'waiting', 'buffering', 'playing'}
                    and job.get('lease_until', 0) > now for job in candidates)
                if not active:
                    for job in candidates:
                        if job_id is not None and job['id'] != job_id:
                            continue
                        if (job.get('device_id') != device_id or job.get('cancel_playback')
                                or job.get('status') in {'cancelled', 'failed'}):
                            continue
                        delivery = job.get('delivery')
                        eligible = (delivery == 'pending'
                                    or delivery is None and job.get('status') in {'queued', 'loading', 'synthesizing'}
                                    or delivery in {'leased', 'waiting', 'buffering', 'playing'}
                                    and job.get('lease_until', 0) <= now)
                        if not eligible:
                            continue
                        job.update(delivery='leased', lease=secrets.token_hex(12),
                                   lease_until=now + lease_seconds, device_claimed_at=now)
                        notify_job(job['id'])
                        return {'task': {
                            'id': job['id'], 'lease': job['lease'], 'text': job['text'],
                            'manifest_url': f"/api/device/{device_id}/jobs/{job['id']}/manifest",
                            'audio_url': job.get('audio_url') if (
                                job.get('playback_mode', 'complete') == 'stream'
                                or job.get('status') == 'completed') else None,
                            'sample_rate': job.get('sample_rate'),
                            'volume': get_devices()[device_id]['volume'], 'protocol': 2,
                            'created_at': job['created_at'],
                            'display_mode': job.get('display_mode', 'buddy'), 'status': job.get('status'),
                            'playback_mode': job.get('playback_mode', 'complete'),
                            'playback_ready': bool(job.get('status') == 'completed' and job.get('audio_url')),
                        }}
            if time.monotonic() >= deadline:
                return {'task': None}
            await asyncio.sleep(min(.04, max(0, deadline - time.monotonic())))

    @router.get('/{device_id}/jobs/{job_id}/manifest')
    async def manifest(device_id: str, job_id: str, request: Request, lease: str,
                       after: int = Query(default=0, ge=0),
                       wait_ms: int = Query(default=0, ge=0, le=500)):
        auth(device_id, request)
        deadline = time.monotonic() + wait_ms / 1000
        while True:
            # Register and snapshot under the job lock. A part published between
            # this snapshot and await cannot lose its wakeup. No job lock is held
            # while waiting for the model thread or a cancellation notification.
            future = None
            try:
                with lock:
                    future = subscribe_job(job_id) if subscribe_job and wait_ms else None
                    job = leased_job(device_id, job_id, lease)
                    result = snapshot(device_id, job, after)
                remaining = deadline - time.monotonic()
                if result['parts'] or result['finished'] or result['cancel'] or remaining <= 0:
                    return result
                if future is None:
                    await asyncio.sleep(min(.02, remaining))
                else:
                    try:
                        await asyncio.wait_for(future, timeout=remaining)
                    except TimeoutError:
                        pass
            finally:
                if future is not None:
                    unsubscribe_job(job_id, future)

    @router.post('/{device_id}/heartbeat')
    def heartbeat(device_id: str, body: DeviceHeartbeat, request: Request):
        auth(device_id, request)
        with lock:
            job = leased_job(device_id, body.job_id, body.lease or '') if body.job_id else None
            record = device_record(device_id)
            if job and job.get('delivery') in final_delivery:
                # Final ACKs are idempotent. Ignore old playing/buffering/waiting
                # heartbeats, including their device-record fields and timings;
                # they may arrive after a different job has already been claimed.
                return {'volume': record['volume'], 'already_final': True,
                        'cancel': bool(job.get('delivery') != 'delivered'
                                       or body.status not in {'completed', 'error'})}
            record.update(status=body.status, job_id=body.job_id, simulated=body.simulated)
            if job:
                now = time.time()
                if body.simulated:
                    job['device_delivery_simulated'] = True
                download_metric = 'device_simulated_download_seconds' if body.simulated else 'device_download_seconds'
                if body.first_download_elapsed_ms is not None and job.get(download_metric) is None:
                    job[download_metric] = round(body.first_download_elapsed_ms / 1000, 3)
                job['device_played_parts'] = max(job.get('device_played_parts', 0), body.played_parts)
                metric = 'device_simulated_first_audio_seconds' if body.simulated else 'device_first_audio_seconds'
                if body.first_audio and job.get(metric) is None:
                    observed = 'device_simulated_first_audio_observed_seconds' if body.simulated else 'device_first_audio_observed_seconds'
                    job[observed] = round(now - job['created_at'], 3)
                    elapsed = body.first_audio_elapsed_ms
                    # Time from task acceptance to first accepted I2S write comes
                    # from the device monotonic clock. Clamp it to the observation
                    # interval so a bad clock/report cannot produce future times.
                    if elapsed is not None:
                        claimed = job.get('device_claimed_at', now)
                        start_at = min(now, claimed + elapsed / 1000)
                        job[metric] = round(max(0, start_at - job['created_at']), 3)
                    else:
                        job[metric] = job[observed]
                    if body.simulated:
                        job['device_simulated_first_audio_measurement'] = 'simulated_pcm_buffer_ready'
                    else:
                        job['device_first_audio_measurement'] = 'first_i2s_write'
                if not job.get('cancel_playback'):
                    job['delivery'] = {
                        'waiting': 'waiting', 'buffering': 'buffering', 'playing': 'playing',
                        'completed': 'delivered', 'error': 'error',
                    }.get(body.status, job.get('delivery'))
                if body.error:
                    job['device_error'] = body.error
                if body.status in {'completed', 'error'}:
                    save_job(job)
                notify_job(job['id'])
            return {'volume': record['volume'],
                    'cancel': bool(job and (job.get('cancel_playback') or job.get('status') in {'cancelled', 'failed'}))}

    return router
