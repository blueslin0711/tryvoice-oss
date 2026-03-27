"""Core configuration — logging, canonical history store, history sync."""

import os

from backend.paths import USER_DATA_DIR


def _env(new_key: str, old_key: str, default: str) -> str:
    """Read env var with fallback from old OPENCLAW_ prefixed name."""
    return os.getenv(new_key, "") or os.getenv(old_key, "") or default


# ---- Canonical history store ----
CANONICAL_DB_PATH = os.getenv(
    "CANONICAL_DB_PATH",
    str((USER_DATA_DIR / "canonical_history.db").resolve()),
)
HISTORY_SYNC_FETCH_LIMIT = int(_env("HISTORY_SYNC_FETCH_LIMIT", "OPENCLAW_HISTORY_SYNC_FETCH_LIMIT", "1000"))
HISTORY_SYNC_INTERVAL_SECONDS = float(
    _env("HISTORY_SYNC_INTERVAL_SECONDS", "OPENCLAW_HISTORY_SYNC_INTERVAL_SECONDS", "1.5"),
)
CANONICAL_EVENT_V2_DUAL_WRITE = _env(
    "CANONICAL_EVENT_V2_DUAL_WRITE",
    "OPENCLAW_CANONICAL_EVENT_V2_DUAL_WRITE",
    "1",
).strip().lower() in {"1", "true", "yes", "on"}
CANONICAL_EVENT_V2_READ_ENABLED = _env(
    "CANONICAL_EVENT_V2_READ_ENABLED",
    "OPENCLAW_CANONICAL_EVENT_V2_READ_ENABLED",
    "0",
).strip().lower() in {"1", "true", "yes", "on"}

# ---- History retention ----
# Auto-prune messages older than N days (0 = disabled, keep forever)
HISTORY_RETENTION_DAYS = int(os.getenv("HISTORY_RETENTION_DAYS", "0"))
# Max messages per bot to keep (0 = unlimited)
HISTORY_MAX_MESSAGES_PER_BOT = int(os.getenv("HISTORY_MAX_MESSAGES_PER_BOT", "0"))

# ---- Server logging ----
SERVER_LOG_FILE = os.getenv(
    "SERVER_LOG_FILE",
    str((USER_DATA_DIR / "logs" / "server.log").resolve()),
)
SERVER_LOG_LEVEL = os.getenv("SERVER_LOG_LEVEL", "DEBUG").strip().upper() or "DEBUG"
SERVER_LOG_ROTATION = os.getenv("SERVER_LOG_ROTATION", "20 MB")
SERVER_LOG_RETENTION = os.getenv("SERVER_LOG_RETENTION", "1 day")
# Log format: "text" (default human-readable) or "json" (structured, for log aggregation)
SERVER_LOG_FORMAT = os.getenv("SERVER_LOG_FORMAT", "json").strip().lower()
