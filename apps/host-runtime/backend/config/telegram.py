"""Telegram integration configuration."""

import os


def _env(new_key: str, old_key: str, default: str) -> str:
    """Read env var with fallback from old OPENCLAW_ prefixed name."""
    return os.getenv(new_key, "") or os.getenv(old_key, "") or default


TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")  # fallback for all bots
TELEGRAM_MIRROR_ENABLED = _env(
    "TELEGRAM_MIRROR_ENABLED",
    "OPENCLAW_TELEGRAM_MIRROR_ENABLED",
    "0",
).strip().lower() in {"1", "true", "yes", "on"}
TELEGRAM_OUTBOX_POLL_SECONDS = float(_env("TELEGRAM_OUTBOX_POLL_SECONDS", "OPENCLAW_TELEGRAM_OUTBOX_POLL_SECONDS", "2"))
TELEGRAM_OUTBOX_BATCH_SIZE = int(_env("TELEGRAM_OUTBOX_BATCH_SIZE", "OPENCLAW_TELEGRAM_OUTBOX_BATCH_SIZE", "20"))
TELEGRAM_OUTBOX_RETRY_SECONDS = int(
    _env("TELEGRAM_OUTBOX_RETRY_SECONDS", "OPENCLAW_TELEGRAM_OUTBOX_RETRY_SECONDS", "5"),
)
TELEGRAM_OUTBOX_MAX_RETRIES = int(_env("TELEGRAM_OUTBOX_MAX_RETRIES", "OPENCLAW_TELEGRAM_OUTBOX_MAX_RETRIES", "8"))
