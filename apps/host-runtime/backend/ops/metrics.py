"""In-process operational metrics."""

from __future__ import annotations

import os
import threading
import time
from typing import Any

_lock = threading.RLock()
_started = time.time()
_http_total = 0
_http_errors = 0
_http_status_buckets: dict[str, int] = {
    "2xx": 0,
    "3xx": 0,
    "4xx": 0,
    "5xx": 0,
}
_http_last_duration_ms = 0
_http_last_path = ""
_last_exception = ""
_last_exception_ts = 0
_ws_total_connections = 0
_ws_active_connections = 0
_ws_disconnects = 0


def _status_bucket(code: int) -> str:
    if 200 <= code < 300:
        return "2xx"
    if 300 <= code < 400:
        return "3xx"
    if 400 <= code < 500:
        return "4xx"
    return "5xx"


def record_http(path: str, status_code: int, duration_ms: int) -> None:
    global _http_total, _http_errors, _http_last_duration_ms, _http_last_path
    with _lock:
        _http_total += 1
        bucket = _status_bucket(int(status_code))
        _http_status_buckets[bucket] = int(_http_status_buckets.get(bucket, 0)) + 1
        if int(status_code) >= 500:
            _http_errors += 1
        _http_last_duration_ms = int(duration_ms)
        _http_last_path = str(path or "")


def record_exception(error: str) -> None:
    global _last_exception, _last_exception_ts
    with _lock:
        _last_exception = str(error or "")
        _last_exception_ts = int(time.time() * 1000)


def ws_connected() -> None:
    global _ws_total_connections, _ws_active_connections
    with _lock:
        _ws_total_connections += 1
        _ws_active_connections += 1


def ws_disconnected() -> None:
    global _ws_active_connections, _ws_disconnects
    with _lock:
        _ws_active_connections = max(0, _ws_active_connections - 1)
        _ws_disconnects += 1


def snapshot() -> dict[str, Any]:
    with _lock:
        return {
            "uptimeSec": int(max(0, time.time() - _started)),
            "pid": int(os.getpid()),
            "http": {
                "total": int(_http_total),
                "errors5xx": int(_http_errors),
                "statusBuckets": dict(_http_status_buckets),
                "lastDurationMs": int(_http_last_duration_ms),
                "lastPath": _http_last_path,
            },
            "exceptions": {
                "lastError": _last_exception,
                "lastErrorTs": int(_last_exception_ts),
            },
            "websocket": {
                "totalConnections": int(_ws_total_connections),
                "activeConnections": int(_ws_active_connections),
                "disconnects": int(_ws_disconnects),
            },
        }
