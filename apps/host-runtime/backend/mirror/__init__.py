"""Pluggable message mirror framework.

Usage (from app.py lifespan):

    from backend import mirror
    mirror_mgr = mirror.init(history_store)
    await mirror_mgr.start()
    # ... on shutdown:
    await mirror_mgr.stop()

Usage (from turn_executor.py):

    from backend.mirror import get_mirror_manager
    get_mirror_manager().enqueue(bot_id=..., account_id=..., event_key=..., message_text=...)

Adding a new channel:

    1. Create ``backend/mirror/channels/my_platform.py``
    2. Implement ``MirrorChannel`` protocol (channel_id, env_defaults, send)
    3. Register in ``init()`` below
"""

from __future__ import annotations

from loguru import logger

from backend.mirror.inbound_channel import InboundMirrorChannel
from backend.mirror.manager import MirrorManager

_mirror_manager: MirrorManager | None = None
_inbound_channels: list[InboundMirrorChannel] = []


def init_inbound() -> None:
    """Register inbound channel classifiers for source attribution."""
    global _inbound_channels

    from backend.mirror.channels.feishu_inbound import FeishuInboundChannel
    from backend.mirror.channels.lark_inbound import LarkInboundChannel
    from backend.mirror.channels.telegram_inbound import TelegramInboundChannel

    _inbound_channels = [
        TelegramInboundChannel(),
        FeishuInboundChannel(),
        LarkInboundChannel(),
    ]
    logger.info(
        "mirror: inbound classifiers registered",
        extra={
            "component": "mirror",
            "data": {"channels": [ch.channel_id for ch in _inbound_channels]},
        },
    )


def classify_source_channel(msg: dict) -> str:
    """Return the source channel for a raw message (first match or ``'web'``)."""
    for ch in _inbound_channels:
        result = ch.classify(msg)
        if result:
            return result
    return "web"


def init(store) -> MirrorManager:
    """Initialize the mirror subsystem.

    Each channel is self-contained — ``register_channel()`` calls its
    ``env_defaults()`` automatically, so no central config needs updating.
    """
    global _mirror_manager

    from backend.mirror.channels.feishu import FeishuMirrorChannel
    from backend.mirror.channels.lark import LarkMirrorChannel
    from backend.mirror.channels.telegram import TelegramMirrorChannel

    mgr = MirrorManager(store)
    mgr.register_channel(TelegramMirrorChannel())
    mgr.register_channel(FeishuMirrorChannel())
    mgr.register_channel(LarkMirrorChannel())
    # Future: mgr.register_channel(SlackMirrorChannel())
    # Future: mgr.register_channel(DiscordMirrorChannel())

    # Reset any previously failed outbox entries so they get retried
    if hasattr(store, "reset_failed_mirror_outbox"):
        count = store.reset_failed_mirror_outbox()
        if count:
            logger.info(f"mirror: reset {count} failed outbox entries to pending")

    _mirror_manager = mgr
    return mgr


def get_mirror_manager() -> MirrorManager:
    """Return the singleton MirrorManager. Must call init() first."""
    if _mirror_manager is None:
        raise RuntimeError("mirror.init() has not been called")
    return _mirror_manager
