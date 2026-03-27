"""Compatibility orchestrator that delegates to existing ws processing flow."""

from __future__ import annotations

from typing import Any

from backend.session.orchestrator import SessionOrchestrator, WSMessageSender
from backend.session.turn_executor import process_bot_message


class LegacySessionOrchestrator(SessionOrchestrator):
    """Phase 1 bridge: keeps current behavior while introducing orchestration API."""

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
    ) -> None:
        await process_bot_message(
            user_text=user_text,
            bot_id=bot_id,
            source=source,
            client_msg_id=client_msg_id,
            ws_send=ws_send,
            current_bot_id=current_bot_id,
            bot_voices=bot_voices,
            bot_tts_rates=bot_tts_rates,
            recent_bot_replies=recent_bot_replies,
            history_store=history_store,
        )

    async def request_cancel(
        self,
        *,
        bot_id: str,
        ws_send: WSMessageSender,
        turn_id: str = "",
        reason: str = "user",
    ) -> dict[str, Any]:
        _ = (ws_send, turn_id, reason)
        return {
            "ok": False,
            "botId": bot_id,
            "active": False,
            "supportsCancel": False,
            "mode": "tts_only_stop",
            "reason": "legacy_orchestrator_no_cancel",
        }
