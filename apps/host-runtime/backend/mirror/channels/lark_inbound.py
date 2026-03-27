"""Lark inbound classifier — detects messages arriving via Lark gateway relay."""

from __future__ import annotations


class LarkInboundChannel:
    """Classifies messages that entered the session via Lark gateway relay."""

    channel_id = "lark"

    def classify(self, msg: dict) -> str | None:
        prov = msg.get("provenance")
        if not isinstance(prov, dict):
            return None
        # OpenClaw gateway tags Lark-originated inter-session relays
        # with OriginatingChannel = "lark"
        if str(prov.get("originatingChannel", "")).strip().lower() == "lark":
            return self.channel_id
        return None
