"""Persistent WebSocket connection to the OpenClaw gateway."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Callable

import aiohttp
from loguru import logger

_RECONNECT_BASE_S = 1.0
_RECONNECT_MAX_S = 30.0
_CONNECT_TIMEOUT_S = 10.0


class GatewayConnection:
    """Manages a persistent WebSocket connection to the OpenClaw gateway.

    Handles connect handshake (protocol v3), RPC request/response,
    event dispatching, and automatic reconnection.
    """

    def __init__(self, *, gateway_url: str, gateway_token: str):
        self.gateway_url = gateway_url
        self.gateway_token = gateway_token
        self._ws_url = gateway_url.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._session: aiohttp.ClientSession | None = None
        self._reader_task: asyncio.Task | None = None
        self._pending_rpcs: dict[str, asyncio.Future] = {}
        self._event_callbacks: dict[str, list[Callable[[dict], None]]] = {}
        self._connected = asyncio.Event()
        self._closing = False
        self._reconnect_attempts = 0

    @property
    def is_connected(self) -> bool:
        return self._connected.is_set()

    async def connect(self) -> bool:
        if self._closing:
            return False
        try:
            if self._session is None:
                self._session = aiohttp.ClientSession()
            headers: dict[str, str] = {}
            if self.gateway_token:
                headers["Authorization"] = f"Bearer {self.gateway_token}"
            self._ws = await self._session.ws_connect(self._ws_url, headers=headers, timeout=_CONNECT_TIMEOUT_S)
            challenge_msg = await asyncio.wait_for(self._ws.receive(), timeout=5.0)
            if challenge_msg.type != aiohttp.WSMsgType.TEXT:
                logger.error(f"GatewayConnection: expected challenge, got {challenge_msg.type}")
                return False
            challenge = json.loads(challenge_msg.data)
            if challenge.get("event") != "connect.challenge":
                logger.error(f"GatewayConnection: unexpected first event: {challenge.get('event')}")
                return False

            connect_id = f"connect-{uuid.uuid4().hex[:8]}"
            connect_req = {
                "type": "req",
                "id": connect_id,
                "method": "connect",
                "params": {
                    "minProtocol": 3,
                    "maxProtocol": 3,
                    "client": {
                        "id": "gateway-client",
                        "displayName": "TryVoice",
                        "version": "1.0.0",
                        "platform": "python",
                        "mode": "backend",
                    },
                    "auth": {"token": self.gateway_token},
                },
            }
            await self._ws.send_str(json.dumps(connect_req))

            hello_msg = await asyncio.wait_for(self._ws.receive(), timeout=5.0)
            if hello_msg.type != aiohttp.WSMsgType.TEXT:
                logger.error(f"GatewayConnection: expected hello-ok, got {hello_msg.type}")
                return False
            hello = json.loads(hello_msg.data)
            if not hello.get("ok"):
                logger.error(f"GatewayConnection: connect rejected: {hello.get('error')}")
                return False

            self._connected.set()
            self._reconnect_attempts = 0
            logger.info("GatewayConnection: connected to gateway")
            self._reader_task = asyncio.create_task(self._read_loop())
            return True

        except Exception as e:
            logger.error(f"GatewayConnection: connect failed: {e}")
            return False

    async def _read_loop(self):
        try:
            async for msg in self._ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue
                    frame_type = data.get("type")
                    if frame_type == "res":
                        req_id = data.get("id")
                        fut = self._pending_rpcs.pop(req_id, None)
                        if fut and not fut.done():
                            fut.set_result(data)
                    elif frame_type == "event":
                        event_name = data.get("event", "")
                        payload = data.get("payload", {})
                        for cb in self._event_callbacks.get(event_name, []):
                            try:
                                cb(payload)
                            except Exception as e:
                                logger.warning(f"GatewayConnection: event callback error: {e}")
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break
        except Exception as e:
            logger.warning(f"GatewayConnection: read loop error: {e}")
        finally:
            self._connected.clear()
            if not self._closing:
                asyncio.create_task(self._reconnect())

    async def _reconnect(self):
        while not self._closing:
            delay = min(_RECONNECT_BASE_S * (2**self._reconnect_attempts), _RECONNECT_MAX_S)
            self._reconnect_attempts += 1
            logger.info(f"GatewayConnection: reconnecting in {delay:.1f}s (attempt {self._reconnect_attempts})")
            await asyncio.sleep(delay)
            if await self.connect():
                return

    async def send_rpc(self, method: str, params: dict) -> dict:
        if not self.is_connected:
            raise ConnectionError("GatewayConnection: not connected")
        req_id = f"{method}-{uuid.uuid4().hex[:8]}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending_rpcs[req_id] = fut
        msg = json.dumps({"type": "req", "id": req_id, "method": method, "params": params})
        await self._ws.send_str(msg)
        try:
            return await asyncio.wait_for(fut, timeout=10.0)
        except asyncio.TimeoutError:
            self._pending_rpcs.pop(req_id, None)
            raise

    async def chat_send(self, session_key: str, message: str) -> str:
        idempotency_key = uuid.uuid4().hex
        resp = await self.send_rpc(
            "chat.send",
            {
                "sessionKey": session_key,
                "message": message,
                "idempotencyKey": idempotency_key,
            },
        )
        if not resp.get("ok"):
            raise RuntimeError(f"chat.send failed: {resp.get('error')}")
        return resp.get("payload", {}).get("runId", "")

    async def chat_abort(self, session_key: str, run_id: str | None = None) -> None:
        params: dict[str, Any] = {"sessionKey": session_key}
        if run_id:
            params["runId"] = run_id
        await self.send_rpc("chat.abort", params)

    def on_event(self, event_name: str, callback: Callable[[dict], None]) -> None:
        self._event_callbacks.setdefault(event_name, []).append(callback)

    def off_event(self, event_name: str, callback: Callable[[dict], None]) -> None:
        cbs = self._event_callbacks.get(event_name, [])
        if callback in cbs:
            cbs.remove(callback)

    async def close(self):
        self._closing = True
        self._connected.clear()
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session and not self._session.closed:
            await self._session.close()
        for fut in self._pending_rpcs.values():
            if not fut.done():
                fut.set_exception(ConnectionError("connection closed"))
        self._pending_rpcs.clear()

    async def ensure_connected(self) -> None:
        if not self.is_connected:
            await self.connect()
