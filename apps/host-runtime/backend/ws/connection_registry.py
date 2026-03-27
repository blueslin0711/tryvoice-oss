"""
ConnectionRegistry: thread-safe registry of connected WebSocket clients
with built-in structured logging for multi-device sync observability.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from loguru import logger

_log = logger.bind(component="ws.registry")


@dataclass
class ClientInfo:
    conn_id: str
    client_id: str
    device_type: str
    push_queue: asyncio.Queue
    connected_at: float


class ConnectionRegistry:
    """Thread-safe registry of connected WebSocket clients with built-in logging."""

    def __init__(self) -> None:
        self._clients: dict[asyncio.Queue, ClientInfo] = {}
        self._lock = asyncio.Lock()

    async def register(self, info: ClientInfo) -> dict:
        """Register a client. Returns {"reconnect": bool, "concurrent": int}."""
        async with self._lock:
            same_client = [ci for ci in self._clients.values() if ci.client_id == info.client_id]
            self._clients[info.push_queue] = info
            concurrent = len(same_client) + 1
            reconnect = len(same_client) > 0

        _log.bind(
            conn_id=info.conn_id,
            client_id=info.client_id,
            device_type=info.device_type,
            data={"total_clients": self.count, "reconnect": reconnect, "concurrent": concurrent},
        ).info(
            "Client connected (conn={}, device={})",
            info.conn_id,
            info.device_type,
        )
        return {"reconnect": reconnect, "concurrent": concurrent}

    async def unregister(self, push_queue: asyncio.Queue) -> ClientInfo | None:
        """Remove a client. Returns ClientInfo for logging, or None."""
        async with self._lock:
            info = self._clients.pop(push_queue, None)
        if info:
            _log.bind(
                conn_id=info.conn_id,
                client_id=info.client_id,
                device_type=info.device_type,
                data={"total_clients": self.count},
            ).info(
                "Client disconnected (conn={}, device={})",
                info.conn_id,
                info.device_type,
            )
        return info

    async def broadcast(
        self,
        msg: dict,
        *,
        exclude: asyncio.Queue | None = None,
        event_label: str = "",
    ) -> None:
        """Send msg to all clients except exclude. Logs delivery stats."""
        dead: list[asyncio.Queue] = []
        sent = 0
        excluded_count = 0
        dropped: list[ClientInfo] = []

        async with self._lock:
            total = len(self._clients)
            for q, info in self._clients.items():
                if q is exclude:
                    excluded_count += 1
                    continue
                try:
                    q.put_nowait(msg)
                    sent += 1
                except asyncio.QueueFull:
                    dead.append(q)
                    dropped.append(info)
            for q in dead:
                self._clients.pop(q, None)

        if dropped:
            for info in dropped:
                _log.bind(
                    conn_id=info.conn_id,
                    client_id=info.client_id,
                    device_type=info.device_type,
                    data={"event": event_label},
                ).warning("Broadcast drop: queue full")

        _log.bind(
            data={
                "event": event_label,
                "total": total,
                "sent": sent,
                "excluded": excluded_count,
                "dropped": len(dropped),
            },
        ).debug(
            "Broadcast: {} → {} clients ({} excluded, {} dropped)",
            event_label,
            sent,
            excluded_count,
            len(dropped),
        )

    def snapshot(self) -> list[ClientInfo]:
        """Non-async snapshot of current clients (debug/status use only)."""
        return list(self._clients.values())

    @property
    def count(self) -> int:
        return len(self._clients)


# Module-level singleton
registry = ConnectionRegistry()
