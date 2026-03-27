"""Session orchestrator contract."""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Protocol

WSMessageSender = Callable[[dict[str, Any]], Awaitable[None]]


class SessionOrchestrator(Protocol):
    """Defines one-turn orchestration boundary for Session Shell layer."""

    async def start_turn(
        self,
        *,
        user_text: str,
        bot_id: str,
        source: str,
        client_msg_id: str,
        ws_send: WSMessageSender,
        current_bot_id: str,
        bot_voices: dict[str, str],
        bot_tts_rates: dict[str, str],
        recent_bot_replies: dict[str, dict[str, Any]],
        history_store: Any,
    ) -> None: ...

    async def request_cancel(
        self,
        *,
        bot_id: str,
        ws_send: WSMessageSender,
        turn_id: str = "",
        reason: str = "user",
    ) -> dict[str, Any]: ...
