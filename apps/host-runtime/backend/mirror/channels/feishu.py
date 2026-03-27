"""Feishu mirror channel — sends messages via Feishu Bot API (open.feishu.cn)."""

from __future__ import annotations

import json
import time
from pathlib import Path

import aiohttp
from loguru import logger

from backend.config.feishu_mirror import (
    FEISHU_APP_ID,
    FEISHU_APP_SECRET,
    FEISHU_CHAT_ID,
    FEISHU_MIRROR_ENABLED,
)
from backend.runtime.slot_registry import find_slot_by_account_id, get_slot

_BASE_URL = "https://open.feishu.cn"

# Simple in-process token cache: app_id -> (token, expire_at)
_token_cache: dict[str, tuple[str, float]] = {}


class FeishuMirrorChannel:
    """Mirror channel that delivers messages to Feishu group chats via Bot API.

    Authentication uses App ID + App Secret to obtain a tenant_access_token
    (valid ~2 hours). Tokens are cached in-process and refreshed automatically.
    """

    @property
    def channel_id(self) -> str:
        return "feishu"

    def env_defaults(self) -> dict:
        return {
            "enabled": FEISHU_MIRROR_ENABLED,
            "target": FEISHU_CHAT_ID,
            "app_id": FEISHU_APP_ID,
            "app_secret": FEISHU_APP_SECRET,
        }

    def _resolve_credentials(self, bot_id: str, account_id: str) -> tuple[str, str]:
        """Resolve (app_id, app_secret) with layered fallback.

        Order:
          1. slot.mirror.feishu.app_id / app_secret
          2. openclaw.json channels.feishu.accounts.{account_id}
          3. env FEISHU_APP_ID / FEISHU_APP_SECRET
        """
        slot = get_slot(bot_id) or find_slot_by_account_id(account_id) or {}
        mirror_cfg = slot.get("mirror", {}).get("feishu", {})
        app_id = mirror_cfg.get("app_id", "")
        app_secret = mirror_cfg.get("app_secret", "")
        if app_id and app_secret:
            return app_id, app_secret

        # Layer 2: openclaw.json
        gw_id, gw_secret = self._read_gateway_credentials(account_id)
        if gw_id and gw_secret:
            return gw_id, gw_secret

        # Layer 3: env vars
        return FEISHU_APP_ID, FEISHU_APP_SECRET

    @staticmethod
    def _read_gateway_credentials(account_id: str) -> tuple[str, str]:
        try:
            config_path = Path.home() / ".openclaw" / "openclaw.json"
            if not config_path.exists():
                return "", ""
            data = json.loads(config_path.read_text(encoding="utf-8"))
            accounts = (data.get("channels") or {}).get("feishu", {}).get("accounts", {})
            acct = accounts.get(account_id, {})
            return str(acct.get("appId") or ""), str(acct.get("appSecret") or "")
        except Exception:
            return "", ""

    async def _get_token(self, app_id: str, app_secret: str, session: aiohttp.ClientSession) -> tuple[str, str]:
        """Return a valid tenant_access_token, refreshing from API if expired."""
        cached = _token_cache.get(app_id)
        if cached:
            token, expire_at = cached
            if time.time() < expire_at - 60:  # 1-minute safety margin
                return token, ""

        url = f"{_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal"
        payload = {"app_id": app_id, "app_secret": app_secret}
        try:
            async with session.post(url, json=payload) as resp:
                data = await resp.json()
                if data.get("code") != 0:
                    err = f"feishu token error: code={data.get('code')} msg={data.get('msg')}"
                    logger.error(f"mirror: {err}")
                    return "", err
                token = data["tenant_access_token"]
                expire_in = int(data.get("expire", 7200))
                _token_cache[app_id] = (token, time.time() + expire_in)
                return token, ""
        except Exception as e:
            return "", str(e)

    async def send(
        self,
        *,
        text: str,
        target: str,
        bot_id: str,
        account_id: str,
        session: aiohttp.ClientSession,
    ) -> tuple[bool, str]:
        app_id, app_secret = self._resolve_credentials(bot_id, account_id)
        if not app_id or not app_secret:
            msg = f"No Feishu credentials for bot={bot_id} account={account_id}"
            logger.warning(msg)
            return False, msg

        token, err = await self._get_token(app_id, app_secret, session)
        if not token:
            return False, err

        url = f"{_BASE_URL}/open-apis/im/v1/messages"
        headers = {"Authorization": f"Bearer {token}"}
        params = {"receive_id_type": "chat_id"}
        payload = {
            "receive_id": target,
            "msg_type": "text",
            "content": json.dumps({"text": text}),
        }
        try:
            async with session.post(url, json=payload, headers=headers, params=params) as resp:
                data = await resp.json()
                if data.get("code") == 0:
                    logger.info(f"mirror: feishu send ok (bot={bot_id}, target={target})")
                    return True, ""
                err = f"code={data.get('code')} msg={data.get('msg')}"
                logger.error(f"mirror: feishu send failed (bot={bot_id}): {err}")
                return False, err
        except Exception as e:
            err = str(e)
            logger.error(f"mirror: feishu send error: {err}")
            return False, err
