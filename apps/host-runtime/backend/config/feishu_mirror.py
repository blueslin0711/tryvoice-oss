"""Feishu mirror channel configuration."""

import os


def _env(key: str, default: str) -> str:
    return os.getenv(key, "") or default


FEISHU_MIRROR_ENABLED = _env("FEISHU_MIRROR_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
FEISHU_APP_ID = os.getenv("FEISHU_APP_ID", "")
FEISHU_APP_SECRET = os.getenv("FEISHU_APP_SECRET", "")
FEISHU_CHAT_ID = os.getenv("FEISHU_CHAT_ID", "")  # default target: oc_xxx group chat id
FEISHU_OUTBOX_POLL_SECONDS = float(_env("FEISHU_OUTBOX_POLL_SECONDS", "2"))
FEISHU_OUTBOX_BATCH_SIZE = int(_env("FEISHU_OUTBOX_BATCH_SIZE", "20"))
FEISHU_OUTBOX_RETRY_SECONDS = int(_env("FEISHU_OUTBOX_RETRY_SECONDS", "5"))
FEISHU_OUTBOX_MAX_RETRIES = int(_env("FEISHU_OUTBOX_MAX_RETRIES", "8"))
