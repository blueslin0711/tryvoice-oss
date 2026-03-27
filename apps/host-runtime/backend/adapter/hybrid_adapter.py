"""AdapterRouter — routes requests to different backends based on session_key prefix.

Session keys are matched against a prefix map (e.g. "claude:" → claude-code adapter,
"agent:" → openclaw adapter).  Unmatched keys fall back to a configurable default.

This allows Claude Code TUI sessions, Claw Manager tmux sessions, and OpenClaw
agent sessions to coexist in the same TryVoice instance.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from loguru import logger

from backend.adapter.contract import AdapterCapabilities, AdapterEvent


class AdapterRouter:
    """Routes to the correct sub-adapter based on session_key prefix."""

    def __init__(
        self,
        adapters: dict[str, object],
        prefix_map: dict[str, str],
        fallback_id: str = "claude-code",
    ) -> None:
        self._adapters = adapters
        self._prefix_map = prefix_map
        self._fallback_id = fallback_id
        parts = [f"{prefix}->{aid}" for prefix, aid in prefix_map.items()]
        parts.append(f"fallback={fallback_id}")
        logger.info(f"AdapterRouter: {', '.join(parts)} ({len(adapters)} adapters)")

    @property
    def fallback_id(self) -> str:
        return self._fallback_id

    @fallback_id.setter
    def fallback_id(self, value: str) -> None:
        if value in self._adapters:
            self._fallback_id = value

    def _pick(self, session_key: str | None = None):
        """Return the correct adapter for this session_key."""
        if session_key:
            for prefix, adapter_id in self._prefix_map.items():
                if session_key.startswith(prefix) and adapter_id in self._adapters:
                    return self._adapters[adapter_id]
        return self._adapters.get(self._fallback_id, next(iter(self._adapters.values())))

    def _all_adapters(self):
        """Yield all unique adapter instances."""
        seen = set()
        for adapter in self._adapters.values():
            aid = id(adapter)
            if aid not in seen:
                seen.add(aid)
                yield adapter

    # -- AgentAdapter protocol --

    async def connect(self) -> bool:
        results = [await a.connect() for a in self._all_adapters()]
        return all(results)

    async def authenticate(self) -> bool:
        results = [await a.authenticate() for a in self._all_adapters()]
        return all(results)

    async def send_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
    ) -> str:
        adapter = self._pick(session_key)
        return await adapter.send_user_turn(
            bot_id=bot_id,
            session_key=session_key,
            text=text,
            timeout_seconds=timeout_seconds,
        )

    async def stream_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
        client_msg_id: str = "",
    ) -> AsyncIterator[AdapterEvent]:
        adapter = self._pick(session_key)
        if not hasattr(adapter, "stream_user_turn"):
            # Fallback: use send_user_turn + emit as final event
            reply = await adapter.send_user_turn(
                bot_id=bot_id,
                session_key=session_key,
                text=text,
                timeout_seconds=timeout_seconds,
            )
            if reply:
                yield AdapterEvent(type="assistant_final", bot_id=bot_id, text=reply)
            return
        async for event in adapter.stream_user_turn(
            bot_id=bot_id,
            session_key=session_key,
            text=text,
            timeout_seconds=timeout_seconds,
            client_msg_id=client_msg_id,
        ):
            yield event

    async def stream_assistant_output(
        self,
        *,
        bot_id: str,
        text: str,
    ) -> AsyncIterator[AdapterEvent]:
        # stream_assistant_output doesn't take session_key — delegate to fallback.
        fallback = self._adapters.get(self._fallback_id, next(iter(self._adapters.values())))
        async for event in fallback.stream_assistant_output(bot_id=bot_id, text=text):
            yield event

    async def cancel(self, *, bot_id: str, turn_id: str | None = None) -> bool:
        # Cancel on all — harmless if one has nothing to cancel
        results = []
        for adapter in self._all_adapters():
            try:
                results.append(await adapter.cancel(bot_id=bot_id, turn_id=turn_id))
            except Exception as exc:
                logger.bind(component="adapter.hybrid").warning("cancel failed for {}: {}", type(adapter).__name__, exc)
                results.append(False)
        return any(results)

    async def switch_slot(self, *, slot_id: str) -> bool:
        fallback = self._adapters.get(self._fallback_id, next(iter(self._adapters.values())))
        return await fallback.switch_slot(slot_id=slot_id)

    async def fetch_history(self, *, session_key: str, limit: int = 100) -> list[dict[str, Any]]:
        adapter = self._pick(session_key)
        return await adapter.fetch_history(session_key=session_key, limit=limit)

    async def resume_session(self, *, session_key: str) -> bool:
        adapter = self._pick(session_key)
        return await adapter.resume_session(session_key=session_key)

    async def reset_session(self, *, session_key: str) -> bool:
        adapter = self._pick(session_key)
        return await adapter.reset_session(session_key=session_key)

    async def compact_session(self, *, session_key: str) -> bool:
        adapter = self._pick(session_key)
        fn = getattr(adapter, "compact_session", None)
        if fn is not None:
            return await fn(session_key=session_key)
        return False

    async def send_user_input_reply(
        self,
        *,
        bot_id: str,
        session_key: str,
        reply_text: str,
    ) -> None:
        adapter = self._pick(session_key)
        if hasattr(adapter, "send_user_input_reply"):
            await adapter.send_user_input_reply(
                bot_id=bot_id,
                session_key=session_key,
                reply_text=reply_text,
            )

    async def poll_events(self, *, session_key: str, limit: int = 30) -> list[dict[str, Any]]:
        adapter = self._pick(session_key)
        return await adapter.poll_events(session_key=session_key, limit=limit)

    def _find_creator(self):
        """Return the first sub-adapter that supports bot creation, or None."""
        for adapter in self._all_adapters():
            if hasattr(adapter, "create_bot"):
                caps = getattr(adapter, "report_capabilities", lambda: None)()
                if caps and getattr(caps, "supports_creation", False):
                    return adapter
        return None

    def create_bot_schema(self):
        """Delegate create_bot_schema to the first sub-adapter that supports creation."""
        creator = self._find_creator()
        if creator is None:
            return []
        schema_fn = getattr(type(creator), "create_bot_schema", None)
        if schema_fn is None:
            return []
        return schema_fn()

    async def create_bot(self, *, params: dict):
        """Delegate create_bot to the first sub-adapter that supports creation."""
        creator = self._find_creator()
        if creator is None:
            raise AttributeError("No sub-adapter supports bot creation")
        return await creator.create_bot(params=params)

    async def discover_bots(self):
        """Delegate discover_bots to all sub-adapters and merge results."""
        all_bots = []
        for adapter in self._all_adapters():
            if hasattr(adapter, "discover_bots"):
                try:
                    bots = await adapter.discover_bots()
                    all_bots.extend(bots)
                except Exception as e:
                    logger.warning(f"AdapterRouter discover_bots failed for {type(adapter).__name__}: {e}")
        return all_bots

    def slash_commands(self, session_key: str = "") -> list[dict[str, Any]]:
        return self._pick(session_key).slash_commands(session_key)

    def report_capabilities(self) -> AdapterCapabilities:
        """Report union of all adapters' capabilities."""
        all_caps = [a.report_capabilities() for a in self._all_adapters()]
        return AdapterCapabilities(
            supports_stream=any(c.supports_stream for c in all_caps),
            supports_cancel=any(c.supports_cancel for c in all_caps),
            supports_session_resume=any(c.supports_session_resume for c in all_caps),
            supports_multi_slot=True,
            supports_tool_events=any(c.supports_tool_events for c in all_caps),
            supports_remote_history=True,
            supports_streaming_turn=any(getattr(c, "supports_streaming_turn", False) for c in all_caps),
            supports_discovery=any(getattr(c, "supports_discovery", False) for c in all_caps),
            supports_creation=any(getattr(c, "supports_creation", False) for c in all_caps),
            reconnect_burst_sync_ms=max(getattr(c, "reconnect_burst_sync_ms", 0) for c in all_caps),
            reconnect_burst_duration_ms=max(getattr(c, "reconnect_burst_duration_ms", 0) for c in all_caps),
            turn_initial_grace_seconds=max(getattr(c, "turn_initial_grace_seconds", 30) for c in all_caps),
            turn_idle_timeout_seconds=max(getattr(c, "turn_idle_timeout_seconds", 120) for c in all_caps),
            turn_max_timeout_seconds=max(getattr(c, "turn_max_timeout_seconds", 0) for c in all_caps),
            processing_timeout_hint_ms=max(getattr(c, "processing_timeout_hint_ms", 180_000) for c in all_caps),
        )

    def capabilities_for(self, session_key: str) -> AdapterCapabilities:
        """Report capabilities of the adapter that would handle this session_key."""
        return self._pick(session_key).report_capabilities()

    async def attach_terminal(self, *, session_key: str) -> bool:
        """Route attach_terminal to the correct sub-adapter."""
        adapter = self._pick(session_key)
        fn = getattr(adapter, "attach_terminal", None)
        if fn is not None:
            return await fn(session_key=session_key)
        return False

    async def pre_warm(self, *, session_key: str) -> None:
        """Route pre_warm to the correct sub-adapter based on session_key prefix."""
        adapter = self._pick(session_key)
        fn = getattr(adapter, "pre_warm", None)
        if fn is not None:
            await fn(session_key=session_key)

    async def on_slot_removed(self, *, session_key: str) -> None:
        """Route on_slot_removed to the correct sub-adapter based on session_key prefix."""
        adapter = self._pick(session_key)
        fn = getattr(adapter, "on_slot_removed", None)
        if fn is not None:
            await fn(session_key=session_key)

    async def get_session_status(self, *, session_key: str) -> str:
        """Route get_session_status to the correct sub-adapter.

        Returns "connected" for adapters that don't implement this method.
        """
        adapter = self._pick(session_key)
        fn = getattr(adapter, "get_session_status", None)
        if fn is not None:
            return await fn(session_key=session_key)
        return "connected"

    # -- Dependency injection forwarding --

    def set_ws_broadcast(self, broadcast_fn) -> None:
        """Forward WebSocket broadcast function to all sub-adapters."""
        for adapter in self._all_adapters():
            fn = getattr(adapter, "set_ws_broadcast", None)
            if fn is not None:
                fn(broadcast_fn)

    def set_canonical_store(self, store) -> None:
        """Forward canonical store reference to all sub-adapters."""
        for adapter in self._all_adapters():
            fn = getattr(adapter, "set_canonical_store", None)
            if fn is not None:
                fn(store)

    def apply_config(self, config: dict) -> None:
        """Forward config to all sub-adapters."""
        for adapter in self._all_adapters():
            fn = getattr(adapter, "apply_config", None)
            if fn is not None:
                fn(config)

    # -- Lifecycle forwarding --

    async def cleanup_orphaned_tmux_sessions(self) -> int:
        """Forward cleanup to all sub-adapters that support it."""
        total = 0
        for adapter in self._all_adapters():
            fn = getattr(adapter, "cleanup_orphaned_tmux_sessions", None)
            if fn is not None:
                total += await fn()
        return total

    async def scan_recovering_turns(self) -> list[dict[str, Any]]:
        """Forward turn recovery scan to all sub-adapters that support it."""
        all_turns: list[dict[str, Any]] = []
        for adapter in self._all_adapters():
            fn = getattr(adapter, "scan_recovering_turns", None)
            if fn is not None:
                turns = await fn()
                all_turns.extend(turns)
        return all_turns

    # -- Hook forwarding --

    async def handle_session_start_hook(self, hook_data: dict) -> dict:
        """Forward SessionStart hook to the first sub-adapter that handles it."""
        for adapter in self._all_adapters():
            fn = getattr(adapter, "handle_session_start_hook", None)
            if fn is not None:
                result = await fn(hook_data)
                if result.get("ok"):
                    return result
        return {"ok": False, "error": "no_adapter_handled"}

    async def handle_hook_interactive(self, hook_data: dict) -> dict:
        """Forward interactive hook to the first sub-adapter that handles it."""
        for adapter in self._all_adapters():
            fn = getattr(adapter, "handle_hook_interactive", None)
            if fn is not None:
                result = await fn(hook_data)
                if result.get("decision"):
                    return result
        return {"decision": "allow", "error": "no_adapter_handled"}


# Backward compatibility alias
HybridAdapter = AdapterRouter
