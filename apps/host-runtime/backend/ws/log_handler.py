# apps/host-runtime/backend/ws/log_handler.py
"""Handler for client log:batch messages — validates and writes to client log sink."""

from __future__ import annotations

from loguru import logger

_VALID_LEVELS = {"debug", "info", "warn", "error"}
_REQUIRED_FIELDS = {"ts", "level", "source", "component", "message"}

# Dedicated client logger — configured in app.py
_client_logger = logger.bind(source="client")


def validate_log_entry(entry: dict) -> bool:
    """Return True if entry has all required fields with valid values."""
    if not isinstance(entry, dict):
        return False
    for field in _REQUIRED_FIELDS:
        if field not in entry or not isinstance(entry[field], str) or not entry[field]:
            return False
    if entry["level"] not in _VALID_LEVELS:
        return False
    return True


def sanitize_log_entry(entry: dict) -> dict:
    """Force source to 'client', truncate oversized fields."""
    entry["source"] = "client"
    if len(entry.get("message", "")) > 2000:
        entry["message"] = entry["message"][:2000] + "…"
    return entry


async def handle_log_batch(entries: list) -> int:
    """Process a batch of client log entries. Returns count of entries written."""
    if not isinstance(entries, list):
        return 0
    count = 0
    for raw in entries[:200]:  # Cap at 200 per batch
        if not validate_log_entry(raw):
            continue
        entry = sanitize_log_entry(dict(raw))
        _client_logger.log(
            entry["level"].upper() if entry["level"] != "warn" else "WARNING",
            "{msg}",
            msg=entry["message"],
            **{k: v for k, v in entry.items() if k != "message"},
        )
        count += 1
    return count
