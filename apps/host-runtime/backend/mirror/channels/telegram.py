"""Telegram mirror channel — sends messages via Telegram Bot API."""

from __future__ import annotations

import json
from pathlib import Path

import aiohttp
from loguru import logger

from backend.config.telegram import (
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    TELEGRAM_MIRROR_ENABLED,
)
from backend.runtime.slot_registry import find_slot_by_account_id, get_slot


class TelegramMirrorChannel:
    """Mirror channel that delivers messages to Telegram via Bot API.

    Bypasses agent gateway to avoid echo: the gateway would re-ingest
    mirrored messages as new user input and generate unwanted replies.
    """

    @property
    def channel_id(self) -> str:
        return "telegram"

    def env_defaults(self) -> dict:
        """Read Telegram-specific env vars as adapter-level defaults."""
        return {
            "enabled": TELEGRAM_MIRROR_ENABLED,
            "target": TELEGRAM_CHAT_ID,
            "token": TELEGRAM_BOT_TOKEN,
        }

    def _resolve_token(self, bot_id: str, account_id: str) -> str:
        """Resolve Telegram bot token with layered fallback.

        Order:
          1. slot.mirror.telegram.token
          2. slot.telegramBotToken
          3. env TELEGRAM_BOT_TOKEN
          4. openclaw.json gateway config (last-resort, file-based)
        """
        slot = get_slot(bot_id) or find_slot_by_account_id(account_id) or {}
        mirror_cfg = slot.get("mirror", {}).get("telegram", {})
        token = mirror_cfg.get("token", "")
        if token:
            return token
        token = slot.get("telegramBotToken", "")
        if token:
            return token
        if TELEGRAM_BOT_TOKEN:
            return TELEGRAM_BOT_TOKEN
        # Layer 4: read directly from gateway config file
        return self._read_gateway_bot_token(bot_id or account_id)

    @staticmethod
    def _read_gateway_bot_token(account_id: str) -> str:
        """Read bot token from OpenClaw gateway config as last-resort fallback."""
        try:
            config_path = Path.home() / ".openclaw" / "openclaw.json"
            if not config_path.exists():
                return ""
            data = json.loads(config_path.read_text(encoding="utf-8"))
            accounts = (data.get("channels") or {}).get("telegram", {}).get("accounts", {})
            acct = accounts.get(account_id, {})
            return str(acct.get("botToken") or "")
        except Exception:
            return ""

    async def send(
        self,
        *,
        text: str,
        target: str,
        bot_id: str,
        account_id: str,
        session: aiohttp.ClientSession,
    ) -> tuple[bool, str]:
        token = self._resolve_token(bot_id, account_id)
        if not token:
            msg = f"No Telegram bot token for bot={bot_id} account={account_id}"
            logger.warning(msg)
            return False, msg

        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {"chat_id": target, "text": text}
        try:
            async with session.post(url, json=payload) as resp:
                data = await resp.json()
                if resp.status == 200 and data.get("ok"):
                    logger.info(f"mirror: telegram send ok (bot={bot_id}, target={target})")
                    return True, ""
                err = str(data.get("description") or f"HTTP {resp.status}")
                logger.error(f"mirror: telegram send failed (bot={bot_id}): {err}")
                return False, err
        except Exception as e:
            err = str(e)
            logger.error(f"mirror: telegram send error: {err}")
            return False, err
