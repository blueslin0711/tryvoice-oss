"""InboundMirrorChannel protocol — interface for classifying inbound message sources."""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class InboundMirrorChannel(Protocol):
    """Inspects raw Gateway message provenance and returns a channel identifier.

    Each implementation knows how to detect messages originating from a
    specific external platform (Telegram, Slack, etc.).
    """

    @property
    def channel_id(self) -> str:
        """Unique identifier for this channel type, e.g. "telegram", "slack"."""
        ...

    def classify(self, msg: dict) -> str | None:
        """Return ``channel_id`` if *msg* originated from this channel, else ``None``."""
        ...
