"""Lark (international Feishu) mirror channel configuration."""

import os


def _env(key: str, default: str) -> str:
    return os.getenv(key, "") or default


LARK_MIRROR_ENABLED = _env("LARK_MIRROR_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
LARK_APP_ID = os.getenv("LARK_APP_ID", "")
LARK_APP_SECRET = os.getenv("LARK_APP_SECRET", "")
LARK_CHAT_ID = os.getenv("LARK_CHAT_ID", "")  # default target: oc_xxx group chat id
LARK_OUTBOX_POLL_SECONDS = float(_env("LARK_OUTBOX_POLL_SECONDS", "2"))
LARK_OUTBOX_BATCH_SIZE = int(_env("LARK_OUTBOX_BATCH_SIZE", "20"))
LARK_OUTBOX_RETRY_SECONDS = int(_env("LARK_OUTBOX_RETRY_SECONDS", "5"))
LARK_OUTBOX_MAX_RETRIES = int(_env("LARK_OUTBOX_MAX_RETRIES", "8"))
