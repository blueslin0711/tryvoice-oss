"""Activity-aware turn timeout monitor.

Tracks ws_send activity to distinguish idle turns (truly stuck) from
active turns (LLM thinking, agent executing tools) that just happen
to take a long time.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Coroutine


class TurnActivityMonitor:
    """Track activity signals during a turn to support idle-based timeout."""

    def __init__(self) -> None:
        self._last_activity: float = 0.0
        self._started: float = 0.0
        self._signal_count: int = 0

    def start(self) -> None:
        """Mark the turn as started and record initial activity."""
        now = time.monotonic()
        self._started = now
        self._last_activity = now
        self._signal_count = 0

    def signal(self) -> None:
        """Record an activity signal (ws_send, poll response, etc.)."""
        self._last_activity = time.monotonic()
        self._signal_count += 1

    @property
    def idle_seconds(self) -> float:
        """Seconds since last activity signal."""
        if self._last_activity <= 0.0:
            return 0.0
        return time.monotonic() - self._last_activity

    @property
    def elapsed_seconds(self) -> float:
        """Seconds since the turn started."""
        if self._started <= 0.0:
            return 0.0
        return time.monotonic() - self._started

    @property
    def signal_count(self) -> int:
        return self._signal_count

    def wrap_ws_send(
        self,
        original: Callable[[dict[str, Any]], Coroutine[Any, Any, None]],
    ) -> Callable[[dict[str, Any]], Coroutine[Any, Any, None]]:
        """Return a wrapper around ws_send that auto-records activity."""

        async def monitored_ws_send(msg: dict[str, Any]) -> None:
            self.signal()
            return await original(msg)

        return monitored_ws_send
