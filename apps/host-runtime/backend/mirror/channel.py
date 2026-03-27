"""MirrorChannel protocol — interface for pluggable message mirror backends."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import aiohttp


@runtime_checkable
class MirrorChannel(Protocol):
    """A channel that can deliver mirrored messages to an external platform.

    Each channel implementation is self-contained: it knows how to read its
    own env vars (via ``env_defaults``), resolve per-bot credentials (via
    ``send``), and deliver messages to the external platform.
    """

    @property
    def channel_id(self) -> str:
        """Unique identifier for this channel type, e.g. "telegram", "slack"."""
        ...

    def env_defaults(self) -> dict:
        """Return adapter-level defaults read from this channel's env vars.

        Called once at registration time.  The returned dict should contain:
        - ``enabled`` (bool): whether this channel is globally enabled
        - ``target`` (str): default delivery target (chat id, channel id, …)
        - any other channel-specific fallback values (e.g. ``token``)

        Even when ``enabled`` is False, the ``target`` and other fallbacks
        are still used when a per-bot override sets ``enabled: true``.
        """
        ...

    async def send(
        self,
        *,
        text: str,
        target: str,
        bot_id: str,
        account_id: str,
        session: aiohttp.ClientSession,
    ) -> tuple[bool, str]:
        """Send a message to the external platform.

        Returns (success, error_message).
        """
        ...
