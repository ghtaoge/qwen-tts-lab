"""One pitch-preserving FFmpeg tempo filter for an entire PCM source stream."""
from __future__ import annotations

import math
import queue
import subprocess
import threading

import numpy as np


def transform_audio_stream(source_iter, speed, cancel_event):
    """Yield mono float32 PCM without restarting atempo between model chunks.

    Pipes and queues apply backpressure. The model iterator is consumed and
    closed in the same producer thread, and that thread always joins before
    this generator exits, including cancellation and consumer abandonment.
    """
    if abs(float(speed) - 1.0) < .001:
        yield from source_iter
        return
    if not math.isfinite(float(speed)) or not .5 <= float(speed) <= 2:
        raise ValueError('流式语速必须在 0.5 到 2 之间')

    stop = threading.Event()
    process_ready = threading.Event()
    source_done = threading.Event()
    input_finished = threading.Event()
    header = queue.Queue(maxsize=1)
    output = queue.Queue(maxsize=4)
    state_lock = threading.Lock()
    state = {'process': None, 'error': None, 'elapsed': 0., 'peak': None}
    stderr_tail = bytearray()
    threads = []
    proc = None
    normal_end = False

    def stopped():
        return stop.is_set() or cancel_event.is_set()

    def put_output(value):
        while not stop.is_set():
            try:
                output.put(value, timeout=.05)
                return
            except queue.Full:
                pass

    def producer():
        iterator = iter(source_iter)
        rate = None
        try:
            if stopped():
                return
            for audio, sr, elapsed, peak in iterator:
                if stopped():
                    break
                audio = np.asarray(audio, dtype='<f4').reshape(-1)
                if not audio.size or not np.isfinite(audio).all():
                    raise RuntimeError('语速处理收到空音频或无效样本')
                if not isinstance(sr, (int, np.integer)) or not 8000 <= sr <= 48000:
                    raise RuntimeError('语速处理收到不支持的采样率')
                if rate is None:
                    rate = int(sr)
                    header.put(rate)
                    while not process_ready.wait(.05):
                        if stopped():
                            return
                elif int(sr) != rate:
                    raise RuntimeError('流式语速处理的采样率发生变化')
                if stopped():
                    break
                if not math.isfinite(float(elapsed)) or float(elapsed) < 0:
                    raise RuntimeError('语速处理收到无效的推理耗时')
                with state_lock:
                    state['elapsed'] += float(elapsed)
                    if peak is not None:
                        state['peak'] = max(state['peak'] or 0, float(peak))
                view = memoryview(audio.tobytes())
                offset = 0
                while offset < len(view) and not stopped():
                    written = state['process'].stdin.write(view[offset:])
                    if not written:
                        raise RuntimeError('FFmpeg 音频输入管道提前关闭')
                    offset += written
        except BaseException as exc:
            with state_lock:
                state['error'] = exc
        finally:
            try:
                close = getattr(iterator, 'close', None)
                if close:
                    close()
            except BaseException as exc:
                with state_lock:
                    state['error'] = state['error'] or exc
            # Mark iterator completion before closing stdin: closing the pipe
            # releases the GIL and can let FFmpeg/its reader reach EOF first.
            input_finished.set()
            process = state['process']
            if process is not None:
                try:
                    process.stdin.close()
                except (OSError, ValueError):
                    pass
            source_done.set()

    def reader():
        try:
            while not stop.is_set():
                block = proc.stdout.read(4096)  # 1,024 float32 samples, bounded.
                if not block:
                    break
                put_output(block)
        except (OSError, ValueError) as exc:
            if not stop.is_set():
                put_output(exc)
        finally:
            put_output(None)

    def drain_stderr():
        try:
            while True:
                block = proc.stderr.read(2048)
                if not block:
                    break
                stderr_tail.extend(block)
                if len(stderr_tail) > 16384:
                    del stderr_tail[:-16384]
        except (OSError, ValueError):
            pass

    def result(raw, rate):
        with state_lock:
            elapsed, peak = state['elapsed'], state['peak']
            state['elapsed'] = 0.
        return np.frombuffer(raw, dtype='<f4').astype(np.float32, copy=True), rate, elapsed, peak

    try:
        thread = threading.Thread(target=producer, name='tts-tempo-source')
        threads.append(thread)
        thread.start()
        while True:
            if cancel_event.is_set():
                return
            try:
                rate = header.get(timeout=.05)
                break
            except queue.Empty:
                if source_done.is_set():
                    if state['error']:
                        raise state['error']
                    raise RuntimeError('模型没有生成可供语速处理的音频')

        import imageio_ffmpeg
        proc = subprocess.Popen([
            imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error',
            '-probesize', '32', '-analyzeduration', '0', '-f', 'f32le',
            '-ar', str(rate), '-ac', '1', '-i', 'pipe:0',
            '-af', f'atempo={float(speed):.9g}', '-f', 'f32le',
            '-ar', str(rate), '-ac', '1', '-flush_packets', '1', 'pipe:1'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            bufsize=0, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        state['process'] = proc
        for target, name in ((reader, 'tts-tempo-output'), (drain_stderr, 'tts-tempo-errors')):
            thread = threading.Thread(target=target, name=name)
            threads.append(thread)
            thread.start()
        process_ready.set()

        # Keep one small block until the next block/EOF. This lets the final
        # output carry every source timing increment, including the filter tail.
        pending, aggregate, first = b'', bytearray(), True
        target = max(4, int(rate * .24) * 4)
        while True:
            if cancel_event.is_set():
                return
            try:
                block = output.get(timeout=.05)
            except queue.Empty:
                continue
            if isinstance(block, BaseException):
                raise block
            if block is None:
                break
            aggregate.extend(pending)
            pending = block
            if len(aggregate) >= target:
                raw = bytes(aggregate[:target])
                del aggregate[:target]
                yield result(raw, rate)
                first = False

        returncode = proc.wait(timeout=10)
        threads[-1].join()
        if state['error']:
            raise state['error']
        if returncode:
            raise RuntimeError('FFmpeg 流式语速处理失败：' + stderr_tail.decode('utf-8', errors='replace')[-1000:])
        if not input_finished.is_set():
            raise RuntimeError('FFmpeg 在模型音频输入完成前提前退出')
        aggregate.extend(pending)
        if len(aggregate) % 4:
            raise RuntimeError('FFmpeg 返回的 PCM 字节不完整')
        if aggregate:
            yield result(bytes(aggregate), rate)
        elif first:
            raise RuntimeError('FFmpeg 没有返回有效音频，输入可能过短')
        normal_end = True
    finally:
        stop.set()
        process_ready.set()
        if not normal_end and not source_done.is_set():
            cancel_event.set()
        if proc is not None:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
        # Never leave a model iterator running when the single inference worker
        # is about to accept another request.
        for thread in threads:
            thread.join()
        if proc is not None:
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    pipe.close()
                except (OSError, ValueError):
                    pass
