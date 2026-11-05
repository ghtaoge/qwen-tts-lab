"""Wake HTTP long polls from model/device threads without blocking ASGI workers."""
from __future__ import annotations

import asyncio
import threading


class JobUpdates:
    def __init__(self):
        self._lock = threading.Lock()
        self._waiters = {}

    def subscribe(self, job_id):
        future = asyncio.get_running_loop().create_future()
        with self._lock:
            self._waiters.setdefault(job_id, set()).add(future)
        return future

    def unsubscribe(self, job_id, future):
        with self._lock:
            waiters = self._waiters.get(job_id)
            if waiters is not None:
                waiters.discard(future)
                if not waiters:
                    self._waiters.pop(job_id, None)
        future.cancel()

    def notify(self, job_id):
        with self._lock:
            waiters = self._waiters.pop(job_id, ())
        for future in waiters:
            def resolve(target=future):
                if not target.done():
                    target.set_result(None)
            try:
                future.get_loop().call_soon_threadsafe(resolve)
            except RuntimeError:
                # An old disconnected client/test loop must never break synthesis.
                pass

    @property
    def pending_count(self):
        with self._lock:
            return sum(map(len, self._waiters.values()))
