"""Feishu inbound classifier — detects messages arriving via Feishu gateway relay."""

from __future__ import annotations


class FeishuInboundChannel:
    """Classifies messages that entered the session via Feishu gateway relay."""

    channel_id = "feishu"

    def classify(self, msg: dict) -> str | None:
        prov = msg.get("provenance")
        if not isinstance(prov, dict):
            return None
        # OpenClaw gateway tags Feishu-originated inter-session relays
        # with OriginatingChannel = "feishu"
        if str(prov.get("originatingChannel", "")).strip().lower() == "feishu":
            return self.channel_id
        return None
