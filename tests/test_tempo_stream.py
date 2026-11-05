import threading
import time

import numpy as np
import pytest

import tempo_stream
from tempo_stream import transform_audio_stream


def tone(samples, offset=0, rate=24000):
    return (.2 * np.sin(2 * np.pi * 440 * (np.arange(samples) + offset) / rate)).astype(np.float32)


def tempo_threads():
    return [thread for thread in threading.enumerate() if thread.name.startswith('tts-tempo-')]


def test_normal_speed_passes_original_items_without_ffmpeg(monkeypatch):
    items = [(tone(2400), 24000, .1, 12)]
    monkeypatch.setattr(tempo_stream.subprocess, 'Popen', lambda *args, **kwargs: pytest.fail('FFmpeg unnecessary'))
    actual = list(transform_audio_stream(iter(items), 1., threading.Event()))
    assert actual[0] is items[0]


@pytest.mark.parametrize('speed', [.75, 1.15, 1.5])
def test_one_process_preserves_pitch_duration_and_all_timings(monkeypatch, speed):
    original = tempo_stream.subprocess.Popen
    processes = []

    def start(*args, **kwargs):
        process = original(*args, **kwargs)
        if '-af' in args[0]:
            processes.append(process)
        return process

    monkeypatch.setattr(tempo_stream.subprocess, 'Popen', start)
    items = [(tone(2400, i * 2400), 24000, .01, i) for i in range(12)]
    parts = list(transform_audio_stream(iter(items), speed, threading.Event()))
    audio = np.concatenate([part[0] for part in parts])
    assert len(processes) == 1 and processes[0].poll() == 0
    assert abs(len(audio) / 24000 - 1.2 / speed) < .06
    spectrum = abs(np.fft.rfft(audio))
    peak_hz = np.fft.rfftfreq(len(audio), 1 / 24000)[spectrum.argmax()]
    assert abs(peak_hz - 440) < 5
    assert sum(part[2] for part in parts) == pytest.approx(.12)
    assert parts[-1][3] == 11
    assert len(parts[0][0]) / parts[0][1] >= .2
    assert all(part[0].dtype == np.float32 and 0 < len(part[0]) <= part[1] for part in parts)
    assert not tempo_threads()


def test_audio_arrives_before_source_finishes_and_iterator_keeps_one_thread():
    finish = threading.Event()
    forced_finish = threading.Event()
    closed = threading.Event()
    producer_threads = []

    def unblock():
        forced_finish.set()
        finish.set()

    def source():
        try:
            producer_threads.append(threading.get_ident())
            yield tone(24000), 24000, .1, None
            finish.wait(3)
            producer_threads.append(threading.get_ident())
            yield tone(24000, 24000), 24000, .2, None
        finally:
            producer_threads.append(threading.get_ident())
            closed.set()

    watchdog = threading.Timer(2, unblock)
    watchdog.start()
    iterator = transform_audio_stream(source(), 1.15, threading.Event())
    try:
        first = next(iterator)
        assert not forced_finish.is_set(), 'FFmpeg buffered until the entire source finished'
        assert first[0].size and not closed.is_set()
        finish.set()
        parts = [first, *iterator]
        assert sum(part[2] for part in parts) == pytest.approx(.3)
        assert closed.is_set() and len(set(producer_threads)) == 1
        assert producer_threads[0] != threading.get_ident()
    finally:
        finish.set()
        iterator.close()
        watchdog.cancel()
        watchdog.join()
    assert not tempo_threads()


def test_source_error_propagates_and_cleans_every_worker():
    closed = threading.Event()
    failure = ValueError('source failed during generation')

    def source():
        try:
            yield tone(24000), 24000, .1, None
            raise failure
        finally:
            closed.set()

    with pytest.raises(ValueError, match='source failed') as error:
        list(transform_audio_stream(source(), 1.15, threading.Event()))
    assert error.value is failure
    assert closed.is_set() and not tempo_threads()


@pytest.mark.parametrize('abandon', [False, True])
def test_cancel_or_consumer_close_joins_model_producer(abandon):
    cancelled = threading.Event()
    closed = threading.Event()

    def source():
        try:
            yield tone(48000), 24000, .1, None
            while not cancelled.wait(.01):
                pass
        finally:
            closed.set()

    iterator = transform_audio_stream(source(), 1.15, cancelled)
    next(iterator)
    started = time.monotonic()
    if abandon:
        iterator.close()
    else:
        cancelled.set()
        assert list(iterator) == []
    assert time.monotonic() - started < 2
    assert closed.is_set() and not tempo_threads()


def test_rate_changes_are_reported_instead_of_silent_truncation():
    items = [(tone(2400), 24000, .1, None), (tone(2400), 22050, .1, None)]
    with pytest.raises(RuntimeError, match='采样率发生变化'):
        list(transform_audio_stream(iter(items), 1.15, threading.Event()))
    assert not tempo_threads()


def test_ffmpeg_failure_cannot_silently_complete_or_leave_model_running(monkeypatch):
    original = tempo_stream.subprocess.Popen
    cancelled = threading.Event()
    closed = threading.Event()

    def start(args, **kwargs):
        args = list(args)
        if '-af' in args:
            args[args.index('-af') + 1] = 'missing_test_filter'
        return original(args, **kwargs)

    def source():
        try:
            yield tone(24000), 24000, .1, None
            cancelled.wait(3)
        finally:
            closed.set()

    monkeypatch.setattr(tempo_stream.subprocess, 'Popen', start)
    with pytest.raises((OSError, RuntimeError)):
        list(transform_audio_stream(source(), 1.15, cancelled))
    assert closed.is_set() and not tempo_threads()


def test_normal_eof_does_not_race_the_producer_stdin_close(monkeypatch):
    original = tempo_stream.subprocess.Popen
    closing = threading.Event()
    release = threading.Event()

    class DelayedClose:
        def __init__(self, pipe):
            self.pipe = pipe

        def write(self, data):
            return self.pipe.write(data)

        def close(self):
            self.pipe.close()
            closing.set()
            release.wait(2)

    def start(args, **kwargs):
        process = original(args, **kwargs)
        if '-af' in args:
            process.stdin = DelayedClose(process.stdin)
        return process

    monkeypatch.setattr(tempo_stream.subprocess, 'Popen', start)
    watchdog = threading.Timer(2, release.set)
    watchdog.start()
    iterator = transform_audio_stream(iter([(tone(4800), 24000, .1, None)]), 1.15, threading.Event())
    try:
        first = next(iterator)  # A short utterance emits only its final tail.
        assert closing.is_set() and not release.is_set()
        assert first[0].size
        release.set()
        assert list(iterator) == []
    finally:
        release.set()
        iterator.close()
        watchdog.cancel()
        watchdog.join()
    assert not tempo_threads()
