"""MirrorManager — registry, per-bot config resolution, enqueue, and drain loop."""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp
from loguru import logger

from backend.mirror.channel import MirrorChannel
from backend.mirror.config import BATCH_SIZE, MAX_RETRIES, POLL_SECONDS, RETRY_SECONDS
from backend.runtime.slot_registry import find_slot_by_account_id, get_slot


class MirrorManager:
    """Central coordinator for all mirror channels.

    Each channel is self-contained: it provides its own ``env_defaults()``
    which the manager collects at registration time.  No central config
    function needs to know about every platform.
    """

    def __init__(self, store):
        self._store = store
        self._channels: dict[str, MirrorChannel] = {}
        self._channel_defaults: dict[str, dict] = {}
        self._stop_evt: asyncio.Event | None = None
        self._drain_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Channel registration
    # ------------------------------------------------------------------

    def register_channel(self, channel: MirrorChannel) -> None:
        """Register a channel and collect its env-var defaults."""
        cid = channel.channel_id
        self._channels[cid] = channel
        defaults = channel.env_defaults()
        self._channel_defaults[cid] = defaults
        enabled = defaults.get("enabled", False)
        logger.info(f"mirror: {cid} channel registered (global={'on' if enabled else 'off'})")

    # ------------------------------------------------------------------
    # Per-bot config resolution
    # ------------------------------------------------------------------

    def resolve_bot_channels(self, bot_id: str, account_id: str = "") -> list[tuple[str, str]]:
        """Return list of (channel_id, target) for a given bot.

        Resolution order:
        1. per-bot ``slot.mirror.<channel>.enabled`` — explicit on/off
        2. channel env-var default ``enabled`` — global on/off
        3. disabled

        Target resolution: per-bot target > channel default target.
        """
        slot = get_slot(bot_id) or find_slot_by_account_id(account_id) or {}
        bot_mirror: dict[str, Any] = slot.get("mirror", {})
        result: list[tuple[str, str]] = []

        for ch_id, ch in self._channels.items():
            ch_defaults = self._channel_defaults.get(ch_id, {})
            bot_ch = bot_mirror.get(ch_id, {})
            if not isinstance(bot_ch, dict):
                bot_ch = {}

            # per-bot explicit disable overrides everything
            if bot_ch.get("enabled") is False:
                continue
            # per-bot explicit enable OR channel global enable
            if bot_ch.get("enabled") is True or ch_defaults.get("enabled"):
                target = bot_ch.get("target") or ch_defaults.get("target", "")
                if target:
                    result.append((ch_id, str(target)))

        return result

    # ------------------------------------------------------------------
    # Enqueue
    # ------------------------------------------------------------------

    def enqueue(
        self,
        bot_id: str,
        account_id: str,
        event_key: str,
        message_text: str,
    ) -> int:
        """Enqueue a message to all enabled mirror channels for this bot.

        Returns the number of outbox rows inserted.
        """
        channels = self.resolve_bot_channels(bot_id, account_id)
        if not channels:
            return 0

        inserted = 0
        for ch_id, target in channels:
            ok = self._store.enqueue_mirror_outbox(
                event_key=event_key,
                channel=ch_id,
                bot_id=bot_id,
                account_id=account_id,
                target=target,
                message_text=message_text,
            )
            if ok:
                inserted += 1
        return inserted

    # ------------------------------------------------------------------
    # Background drain loop
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if not self._channels:
            logger.info("mirror: no channels registered, drain loop not started")
            return
        self._stop_evt = asyncio.Event()
        self._drain_task = asyncio.create_task(self._drain_loop(self._stop_evt))
        logger.info("mirror: drain loop started")

    async def stop(self) -> None:
        if self._stop_evt:
            self._stop_evt.set()
        if self._drain_task:
            self._drain_task.cancel()
            try:
                await self._drain_task
            except asyncio.CancelledError:
                pass
        logger.info("mirror: drain loop stopped")

    async def _drain_loop(self, stop_evt: asyncio.Event) -> None:
        async with aiohttp.ClientSession() as http:
            while not stop_evt.is_set():
                sent = 0
                try:
                    sent = await self._drain_once(http)
                except Exception as e:
                    logger.error(f"mirror: drain loop error: {e}")
                delay = 0.2 if sent > 0 else POLL_SECONDS
                try:
                    await asyncio.wait_for(stop_evt.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    continue

    async def _drain_once(self, http: aiohttp.ClientSession) -> int:
        rows = self._store.list_pending_mirror_outbox(BATCH_SIZE)
        if not rows:
            return 0

        sent = 0
        for row in rows:
            ch_id = str(row["channel"])
            channel = self._channels.get(ch_id)
            if not channel:
                self._store.mark_mirror_failed(
                    int(row["outbox_id"]),
                    f"unknown channel: {ch_id}",
                )
                continue

            ok, err = await channel.send(
                text=str(row["message_text"]),
                target=str(row["target"]),
                bot_id=str(row["bot_id"]),
                account_id=str(row["account_id"]),
                session=http,
            )
            outbox_id = int(row["outbox_id"])
            if ok:
                self._store.mark_mirror_sent(outbox_id)
                sent += 1
                continue
            self._store.mark_mirror_retry(
                outbox_id=outbox_id,
                error=err,
                retry_delay_seconds=RETRY_SECONDS,
                max_retries=MAX_RETRIES,
            )
        return sent

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def status(self) -> dict:
        """Return mirror subsystem status for health/metrics endpoints."""
        channels_info = {}
        for ch_id in self._channels:
            defaults = self._channel_defaults.get(ch_id, {})
            channels_info[ch_id] = {
                "globalEnabled": bool(defaults.get("enabled")),
                "defaultTarget": defaults.get("target", ""),
            }
        outbox = self._store.mirror_outbox_stats() if self._store else {}
        return {
            "channels": channels_info,
            "outbox": outbox,
            "drainRunning": self._drain_task is not None and not self._drain_task.done(),
        }
