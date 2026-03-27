"""OpenClaw adapter implementation (Phase 1 compatibility layer)."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, AsyncIterator, Awaitable, Callable

import aiohttp
from loguru import logger

from backend.adapter_sdk import DELIVERY_MIRROR_PROVIDERS, AdapterCapabilities, AdapterEvent
from backend.adapter_sdk.config_types import BotInfo, ConfigField

# Register openclaw as a delivery-mirror provider
DELIVERY_MIRROR_PROVIDERS.add("openclaw")

from .message_utils import extract_history_messages  # noqa: E402

GatewayInvokeFn = Callable[[str, dict[str, Any], aiohttp.ClientSession], Awaitable[dict[str, Any]]]


def _chunk_text(text: str, max_chars: int = 48) -> list[str]:
    src = (text or "").strip()
    if not src:
        return []
    chunks: list[str] = []
    buf: list[str] = []
    breaks = set("\n。！？!?；;，, ")
    for ch in src:
        buf.append(ch)
        if ch in "\n。！？!?；;":
            chunks.append("".join(buf).strip())
            buf.clear()
            continue
        if len(buf) >= max_chars and ch in breaks:
            chunks.append("".join(buf).strip())
            buf.clear()
    if buf:
        chunks.append("".join(buf).strip())
    return [re.sub(r"\s+", " ", c).strip() for c in chunks if c.strip()]


class OpenClawAdapter:
    """Adapter that wraps existing OpenClaw gateway calls.

    Phase 1 focuses on introducing an explicit adapter boundary while keeping
    external behavior unchanged. Therefore this class is additive and old
    processing pipeline still works through legacy orchestrator compatibility.
    """

    def __init__(self, invoke_fn: GatewayInvokeFn | None = None):
        self._invoke = invoke_fn
        self._caps = AdapterCapabilities(
            supports_stream=True,
            supports_streaming_turn=False,
            supports_cancel=True,
            supports_session_resume=True,
            supports_multi_slot=False,
            supports_tool_events=True,
            supports_discovery=True,
            supports_creation=False,
            turn_initial_grace_seconds=60,
            turn_idle_timeout_seconds=120,
            turn_max_timeout_seconds=600,
            processing_timeout_hint_ms=180_000,
        )
        self._cancel_marks: dict[str, float] = {}
        self._bot_session_keys: dict[str, str] = {}  # bot_id → sessionKey
        self._gateway_conn = None

    def _ensure_gateway_conn(self):
        if self._gateway_conn is None:
            from .gateway import GATEWAY_TOKEN, GATEWAY_URL
            from .ws_connection import GatewayConnection

            self._gateway_conn = GatewayConnection(
                gateway_url=GATEWAY_URL,
                gateway_token=GATEWAY_TOKEN,
            )
        return self._gateway_conn

    def apply_config(self, config: dict) -> None:
        """Apply configuration from ConfigStore at runtime."""
        from . import gateway

        if "gateway_url" in config:
            gateway.GATEWAY_URL = str(config["gateway_url"])
        if "gateway_token" in config:
            gateway.GATEWAY_TOKEN = str(config["gateway_token"])
        if self._gateway_conn is not None:
            asyncio.create_task(self._gateway_conn.close())
            self._gateway_conn = None

    async def connect(self) -> bool:
        return True

    async def authenticate(self) -> bool:
        return True

    async def send_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
    ) -> str:
        self.clear_cancel(bot_id)
        self._bot_session_keys[bot_id] = session_key
        invoke_fn = self._invoke or _resolve_invoke_fn()
        # Gateway interprets timeoutSeconds=0 as fire-and-forget (returns
        # immediately without waiting for the assistant reply).  Clamp to
        # default so the caller's "no adapter deadline" intent doesn't
        # accidentally disable reply waiting.
        effective_timeout = timeout_seconds if timeout_seconds > 0 else 240
        async with aiohttp.ClientSession() as http:
            result = await invoke_fn(
                "sessions_send",
                {
                    "sessionKey": session_key,
                    "message": text,
                    "timeoutSeconds": int(effective_timeout),
                },
                http,
            )
        details = result.get("result", {}).get("details", {})
        reply = details.get("reply", "") if isinstance(details, dict) else ""
        if self._is_cancelled(bot_id):
            return ""
        return str(reply or "").strip()

    async def stream_assistant_output(
        self,
        *,
        bot_id: str,
        text: str,
    ) -> AsyncIterator[AdapterEvent]:
        chunks = _chunk_text(text)
        if not chunks and text.strip():
            chunks = [text.strip()]
        for chunk in chunks:
            if self._is_cancelled(bot_id):
                break
            yield AdapterEvent(type="assistant_delta", bot_id=bot_id, text=chunk)
            await asyncio.sleep(0)
        if not self._is_cancelled(bot_id):
            yield AdapterEvent(type="assistant_final", bot_id=bot_id, text=text)

    async def stream_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 0,
        client_msg_id: str = "",
    ) -> AsyncIterator[AdapterEvent]:
        self.clear_cancel(bot_id)
        self._bot_session_keys[bot_id] = session_key

        conn = self._ensure_gateway_conn()
        await conn.ensure_connected()

        queue: asyncio.Queue[dict | None] = asyncio.Queue()
        run_id: str | None = None
        cumulative_text = ""

        def on_chat_event(payload: dict):
            nonlocal run_id
            evt_run_id = payload.get("runId", "")
            if run_id and evt_run_id != run_id:
                return
            queue.put_nowait(payload)

        def on_agent_event(payload: dict):
            evt_run_id = payload.get("runId", "")
            if run_id and evt_run_id != run_id:
                return
            stream_type = payload.get("stream", "")
            data = payload.get("data", {})
            if stream_type == "assistant":
                kind = data.get("kind", "")
                text = data.get("text", "")
                if kind == "thinking" and text:
                    queue.put_nowait({"_synthetic": True, "type": "thinking", "text": text})
            elif stream_type == "tool":
                phase = data.get("phase", "")
                name = data.get("name", "")
                args = data.get("args", {})
                if phase == "start" and name:
                    queue.put_nowait({"_synthetic": True, "type": "tool", "name": name, "args": args})

        conn.on_event("chat", on_chat_event)
        conn.on_event("agent", on_agent_event)
        try:
            # Use HTTP sessions_send (fire-and-forget) to start the turn,
            # because the WS gateway token lacks operator.write scope needed
            # for chat.send RPC.  The WS connection is used only to receive
            # streaming events.
            invoke_fn = self._invoke or _resolve_invoke_fn()
            async with aiohttp.ClientSession() as http:
                result = await invoke_fn(
                    "sessions_send",
                    {
                        "sessionKey": session_key,
                        "message": text,
                        "timeoutSeconds": 0,
                    },
                    http,
                )
            details = result.get("result", {}).get("details", {})
            run_id = details.get("runId", "")
            if not run_id:
                error_msg = result.get("error") or details.get("error") or "sessions_send returned no runId"
                raise RuntimeError(str(error_msg))
            effective_timeout = timeout_seconds if timeout_seconds > 0 else 600

            while True:
                if self._is_cancelled(bot_id):
                    break
                try:
                    evt = await asyncio.wait_for(queue.get(), timeout=effective_timeout)
                except asyncio.TimeoutError:
                    yield AdapterEvent(type="error", bot_id=bot_id, text="Timeout waiting for response")
                    break
                if evt is None:
                    break

                if evt.get("_synthetic"):
                    syn_type = evt.get("type")
                    if syn_type == "thinking":
                        yield AdapterEvent(
                            type="assistant_delta",
                            bot_id=bot_id,
                            text=evt["text"],
                            content_kind="thinking",
                        )
                    elif syn_type == "tool":
                        tool_text = f"{evt['name']}({json.dumps(evt.get('args', {}), ensure_ascii=False)[:200]})"
                        yield AdapterEvent(
                            type="assistant_delta",
                            bot_id=bot_id,
                            text=tool_text,
                            content_kind="tool_call",
                        )
                    continue

                state = evt.get("state", "")
                if state == "delta":
                    msg = evt.get("message", {})
                    new_text = msg.get("text", "") if isinstance(msg, dict) else str(msg)
                    delta = new_text[len(cumulative_text) :]
                    cumulative_text = new_text
                    if delta:
                        yield AdapterEvent(
                            type="assistant_delta",
                            bot_id=bot_id,
                            text=delta,
                            content_kind="result",
                        )
                elif state == "final":
                    msg = evt.get("message", {})
                    final_text = msg.get("text", "") if isinstance(msg, dict) else str(msg)
                    delta = final_text[len(cumulative_text) :]
                    if delta:
                        yield AdapterEvent(
                            type="assistant_delta",
                            bot_id=bot_id,
                            text=delta,
                            content_kind="result",
                        )
                    yield AdapterEvent(
                        type="assistant_final",
                        bot_id=bot_id,
                        text=final_text,
                        content_kind="result",
                        payload={"full_reply": final_text},
                    )
                    break
                elif state == "aborted":
                    msg = evt.get("message", {})
                    partial = msg.get("text", "") if isinstance(msg, dict) else ""
                    yield AdapterEvent(
                        type="assistant_final",
                        bot_id=bot_id,
                        text=partial,
                        content_kind="result",
                        payload={"full_reply": partial, "aborted": True},
                    )
                    break
                elif state == "error":
                    yield AdapterEvent(
                        type="error",
                        bot_id=bot_id,
                        text=evt.get("errorMessage", "Unknown error"),
                    )
                    break
        finally:
            conn.off_event("chat", on_chat_event)
            conn.off_event("agent", on_agent_event)

    async def cancel(self, *, bot_id: str, turn_id: str | None = None) -> bool:
        _ = turn_id
        self._cancel_marks[bot_id] = asyncio.get_running_loop().time()
        session_key = self._bot_session_keys.get(bot_id)
        if session_key:
            conn = self._gateway_conn
            if conn and conn.is_connected:
                try:
                    await conn.chat_abort(session_key)
                    logger.info(f"chat.abort via WS for {bot_id}")
                except Exception as exc:
                    logger.warning(f"chat.abort WS failed for {bot_id}: {exc}, falling back to HTTP")
                    from .gateway import gateway_abort_chat

                    try:
                        await gateway_abort_chat(session_key)
                    except Exception as exc2:
                        logger.warning(f"chat.abort HTTP also failed for {bot_id}: {exc2}")
            else:
                from .gateway import gateway_abort_chat

                try:
                    await gateway_abort_chat(session_key)
                except Exception as exc:
                    logger.warning(f"chat.abort failed for {bot_id}: {exc}")
        return True

    async def switch_slot(self, *, slot_id: str) -> bool:
        _ = slot_id
        return True

    async def fetch_history(self, *, session_key: str, limit: int = 100) -> list[dict[str, Any]]:
        invoke_fn = self._invoke or _resolve_invoke_fn()
        async with aiohttp.ClientSession() as http:
            result = await invoke_fn(
                "sessions_history",
                {
                    "sessionKey": session_key,
                    "limit": int(limit),
                },
                http,
            )
        return extract_history_messages(result)

    async def resume_session(self, *, session_key: str) -> bool:
        _ = session_key
        return True

    async def reset_session(self, *, session_key: str) -> bool:
        """Send /new command to gateway to reset the session."""
        invoke_fn = self._invoke or _resolve_invoke_fn()
        async with aiohttp.ClientSession() as http:
            result = await invoke_fn(
                "sessions_send",
                {
                    "sessionKey": session_key,
                    "message": "/new",
                    "timeoutSeconds": 30,
                },
                http,
            )
        return bool(result.get("ok"))

    async def poll_events(self, *, session_key: str, limit: int = 30) -> list[dict[str, Any]]:
        """Fetch recent session history for intermediate step polling."""
        invoke_fn = self._invoke or _resolve_invoke_fn()
        async with aiohttp.ClientSession() as http:
            result = await invoke_fn(
                "sessions_history",
                {
                    "sessionKey": session_key,
                    "limit": int(limit),
                },
                http,
            )
        return extract_history_messages(result)

    @classmethod
    def config_schema(cls) -> list[ConfigField]:
        return [
            ConfigField(
                "gateway_url", "OpenClaw Gateway URL", "url", default="http://localhost:18789", group="connection"
            ),
            ConfigField("gateway_token", "OpenClaw Gateway Token", "password", required=False, group="connection"),
        ]

    @classmethod
    def create_bot_schema(cls):
        return []

    async def discover_bots(self) -> list[BotInfo]:
        """Discover bots by merging openclaw.json config with active sessions."""
        from .gateway import gateway_list_agents, gateway_read_config

        # 1. Read local config for all channel accounts + agents + bindings
        config = gateway_read_config()
        accounts = config["accounts"]
        agents = config["agents"]
        bindings = config["bindings"]

        # Build agent lookup
        agent_map: dict[str, dict] = {a["id"]: a for a in agents}
        default_agent_id = ""
        for a in agents:
            if a.get("default"):
                default_agent_id = a["id"]
                break

        # 2. Fetch active sessions from gateway
        session_map: dict[str, dict] = {}
        try:
            async with aiohttp.ClientSession() as http:
                sessions = await gateway_list_agents(http)
            for s in sessions:
                dc = s.get("deliveryContext") or {}
                aid = str(dc.get("accountId", "")).strip()
                if aid:
                    session_map[aid] = s
        except Exception as e:
            logger.warning(f"discover_bots: sessions_list failed: {e}")

        # 3. Resolve which agent each account is bound to
        def resolve_agent(channel: str, account_id: str) -> str:
            best_agent = default_agent_id
            best_specificity = -1
            for b in bindings:
                match = b.get("match") or {}
                m_channel = match.get("channel", "")
                m_account = match.get("accountId", "")
                # Channel must match if specified
                if m_channel and m_channel != channel:
                    continue
                # Account must match (exact or wildcard)
                if m_account and m_account != "*" and m_account != account_id:
                    continue
                # Specificity: exact accountId > wildcard > no accountId
                specificity = 0
                if m_channel:
                    specificity += 1
                if m_account == account_id:
                    specificity += 10
                elif m_account == "*":
                    specificity += 1
                if specificity > best_specificity:
                    best_specificity = specificity
                    best_agent = b.get("agentId", default_agent_id)
            return best_agent

        # 4. Build BotInfo list from config accounts
        seen_account_ids: set[str] = set()
        bots: list[BotInfo] = []

        for acct in accounts:
            if not acct.get("enabled", True):
                continue
            account_id = acct["accountId"]
            channel = acct["channel"]
            name = acct["name"]
            seen_account_ids.add(account_id)

            agent_id = resolve_agent(channel, account_id)
            agent_info = agent_map.get(agent_id, {})

            # Prefer existing active session key from gateway (e.g. Telegram session)
            # so TryVoice shares context with the user's Telegram conversation.
            # Fall back to a dedicated voice-chat session only when no active session exists.
            sess = session_map.get(account_id, {})
            session_key = str(sess.get("key", "")).strip() or f"agent:{agent_id}:voice-chat:{account_id}:ctx:shared"
            model = str(sess.get("model", "")).strip()

            bots.append(
                BotInfo(
                    bot_id=account_id,
                    name=name,
                    session_key=session_key,
                    metadata={
                        "channel": channel,
                        "agentId": agent_id,
                        "agentName": agent_info.get("name", agent_id),
                        "model": model,
                        "enabled": True,
                        "hasActiveSession": account_id in session_map,
                        "telegramBotToken": acct.get("botToken", "") if channel == "telegram" else "",
                    },
                )
            )

        # 5. Add any sessions not in config (dynamic/unknown accounts)
        for aid, sess in session_map.items():
            if aid in seen_account_ids:
                continue
            key = str(sess.get("key", sess.get("sessionId", ""))).strip()
            if not key:
                continue
            name = str(sess.get("displayName", "") or sess.get("name", "") or aid)
            dc = sess.get("deliveryContext") or {}
            channel = str(dc.get("channel", "")).strip()
            bots.append(
                BotInfo(
                    bot_id=aid,
                    name=name,
                    session_key=key,
                    metadata={
                        "channel": channel or "unknown",
                        "agentId": "",
                        "agentName": "",
                        "model": str(sess.get("model", "")),
                        "enabled": True,
                        "hasActiveSession": True,
                    },
                )
            )

        logger.info(f"discover_bots: {len(bots)} bot(s) from config+sessions")
        return bots

    async def create_bot(self, *, params):
        raise NotImplementedError("Bot creation is managed by OpenClaw gateway")

    def report_capabilities(self) -> AdapterCapabilities:
        return self._caps

    def slash_commands(self, session_key: str = "") -> list[dict[str, Any]]:
        return [
            {"cmd": "/new", "label": "会话已重置", "description": "Start new session"},
        ]

    def clear_cancel(self, bot_id: str) -> None:
        self._cancel_marks.pop(bot_id, None)

    def _is_cancelled(self, bot_id: str) -> bool:
        return bot_id in self._cancel_marks


def _resolve_invoke_fn() -> GatewayInvokeFn:
    from .gateway import gateway_invoke

    return gateway_invoke
