"""Turn finite state machine for session shell orchestration."""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any


class TurnState(str, Enum):
    IDLE = "IDLE"
    LISTENING = "LISTENING"
    TRANSCRIBING = "TRANSCRIBING"
    STREAMING = "STREAMING"
    SPEAKING = "SPEAKING"
    INTERRUPTED = "INTERRUPTED"
    ERROR = "ERROR"


_ALLOWED_TRANSITIONS: dict[TurnState, set[TurnState]] = {
    TurnState.IDLE: {
        TurnState.LISTENING,
        TurnState.TRANSCRIBING,
        TurnState.STREAMING,
        TurnState.ERROR,
    },
    TurnState.LISTENING: {
        TurnState.TRANSCRIBING,
        TurnState.STREAMING,
        TurnState.INTERRUPTED,
        TurnState.ERROR,
        TurnState.IDLE,
    },
    TurnState.TRANSCRIBING: {
        TurnState.STREAMING,
        TurnState.INTERRUPTED,
        TurnState.ERROR,
        TurnState.IDLE,
    },
    TurnState.STREAMING: {
        TurnState.SPEAKING,
        TurnState.INTERRUPTED,
        TurnState.ERROR,
        TurnState.IDLE,
    },
    TurnState.SPEAKING: {
        TurnState.IDLE,
        TurnState.INTERRUPTED,
        TurnState.ERROR,
    },
    TurnState.INTERRUPTED: {
        TurnState.LISTENING,
        TurnState.TRANSCRIBING,
        TurnState.STREAMING,
        TurnState.IDLE,
        TurnState.ERROR,
    },
    TurnState.ERROR: {
        TurnState.IDLE,
        TurnState.LISTENING,
        TurnState.TRANSCRIBING,
        TurnState.STREAMING,
    },
}


@dataclass
class TurnSnapshot:
    bot_id: str
    state: TurnState = TurnState.IDLE
    turn_id: str = ""
    client_msg_id: str = ""
    source: str = ""
    attempts: int = 0
    last_error: str = ""
    updated_monotonic: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["state"] = self.state.value
        return data


class TurnFSM:
    """Per-bot turn state manager with transition validation."""

    def __init__(self):
        self._state: dict[str, TurnSnapshot] = {}
        self._lock = asyncio.Lock()

    async def _ensure(self, bot_id: str) -> TurnSnapshot:
        snap = self._state.get(bot_id)
        if snap is None:
            snap = TurnSnapshot(bot_id=bot_id, updated_monotonic=asyncio.get_running_loop().time())
            self._state[bot_id] = snap
        return snap

    async def begin_turn(
        self,
        *,
        bot_id: str,
        turn_id: str,
        source: str,
        client_msg_id: str,
    ) -> dict[str, Any]:
        async with self._lock:
            snap = await self._ensure(bot_id)
            snap.turn_id = turn_id
            snap.client_msg_id = client_msg_id
            snap.source = source
            snap.attempts = 0
            snap.last_error = ""
            snap.updated_monotonic = asyncio.get_running_loop().time()
            # New turns always start from LISTENING.
            if snap.state != TurnState.IDLE:
                snap.state = TurnState.IDLE
            snap.state = TurnState.LISTENING
            return snap.to_dict()

    async def transition(
        self,
        *,
        bot_id: str,
        next_state: TurnState,
        turn_id: str = "",
        error: str = "",
    ) -> dict[str, Any]:
        async with self._lock:
            snap = await self._ensure(bot_id)
            if turn_id and snap.turn_id and turn_id != snap.turn_id:
                # Ignore stale transitions from previous turns.
                return snap.to_dict()
            prev = snap.state
            if next_state != prev and next_state not in _ALLOWED_TRANSITIONS[prev]:
                # Illegal transition: force ERROR and preserve details.
                snap.state = TurnState.ERROR
                snap.last_error = (f"illegal transition {prev.value}->{next_state.value}")[:300]
            else:
                snap.state = next_state
                if error:
                    snap.last_error = str(error)[:300]
            snap.updated_monotonic = asyncio.get_running_loop().time()
            return snap.to_dict()

    async def set_attempts(self, *, bot_id: str, attempts: int, turn_id: str = "") -> dict[str, Any]:
        async with self._lock:
            snap = await self._ensure(bot_id)
            if turn_id and snap.turn_id and turn_id != snap.turn_id:
                return snap.to_dict()
            snap.attempts = max(0, int(attempts))
            snap.updated_monotonic = asyncio.get_running_loop().time()
            return snap.to_dict()

    async def finish_turn(self, *, bot_id: str, turn_id: str = "") -> dict[str, Any]:
        async with self._lock:
            snap = await self._ensure(bot_id)
            if turn_id and snap.turn_id and turn_id != snap.turn_id:
                return snap.to_dict()
            snap.state = TurnState.IDLE
            snap.turn_id = ""
            snap.client_msg_id = ""
            snap.source = ""
            snap.attempts = 0
            snap.last_error = ""
            snap.updated_monotonic = asyncio.get_running_loop().time()
            return snap.to_dict()

    async def recover_stale(self, *, stale_seconds: float = 30.0) -> list[dict[str, Any]]:
        """Recover bots that are stuck in non-IDLE states for too long."""
        recovered: list[dict[str, Any]] = []
        now = asyncio.get_running_loop().time()
        async with self._lock:
            for bot_id, snap in self._state.items():
                if snap.state == TurnState.IDLE:
                    continue
                age = now - float(snap.updated_monotonic or 0.0)
                if age < float(stale_seconds):
                    continue
                snap.state = TurnState.ERROR
                snap.last_error = f"stale turn recovered after {int(age)}s"
                snap.updated_monotonic = now
                recovered.append(snap.to_dict())
                snap.state = TurnState.IDLE
                snap.turn_id = ""
                snap.client_msg_id = ""
                snap.source = ""
                snap.attempts = 0
                snap.updated_monotonic = now
                recovered.append(snap.to_dict())
        return recovered

    async def touch(self, *, bot_id: str, turn_id: str = "") -> None:
        """Update monotonic timestamp to prevent stale recovery."""
        async with self._lock:
            snap = await self._ensure(bot_id)
            if turn_id and snap.turn_id and turn_id != snap.turn_id:
                return
            snap.updated_monotonic = asyncio.get_running_loop().time()

    async def snapshot(self, bot_id: str) -> dict[str, Any]:
        async with self._lock:
            snap = await self._ensure(bot_id)
            return snap.to_dict()

    async def snapshot_all(self) -> dict[str, dict[str, Any]]:
        async with self._lock:
            out = {}
            for bot_id in list(self._state.keys()):
                out[bot_id] = self._state[bot_id].to_dict()
            return out
