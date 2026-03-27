"""Telegram inbound classifier — detects messages arriving via Telegram gateway relay."""

from __future__ import annotations


class TelegramInboundChannel:
    """Classifies messages that entered the session via Telegram gateway relay."""

    channel_id = "telegram"

    def classify(self, msg: dict) -> str | None:
        prov = msg.get("provenance")
        if not isinstance(prov, dict):
            return None
        # OpenClaw gateway tags Telegram-originated inter-session relays
        # with originatingChannel = "telegram".
        # Previously matched on sessions_send tool name, but that also
        # matches TryVoice web sends (both use sessions_send).
        if str(prov.get("originatingChannel", "")).strip().lower() == "telegram":
            return self.channel_id
        return None
