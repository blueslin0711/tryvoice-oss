"""OpenClaw-specific configuration — gateway, session keys, bot config."""

import os
import re

from dotenv import load_dotenv

from backend.paths import ENV_PATH

load_dotenv(ENV_PATH, override=True)

# ---- Gateway ----
GATEWAY_URL = os.getenv("AGENT_GATEWAY_URL") or os.getenv("OPENCLAW_GATEWAY_URL") or "http://localhost:18789"
GATEWAY_TOKEN = os.getenv("AGENT_GATEWAY_TOKEN") or os.getenv("OPENCLAW_GATEWAY_TOKEN") or ""


def _csv_tokens(raw: str) -> list[str]:
    out: list[str] = []
    for part in str(raw or "").split(","):
        token = part.strip()
        if token:
            out.append(token)
    return out


def _dedupe_keep_order(items: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


# Gateway session tool mapping.
SESSION_SEND_TOOL = os.getenv("OPENCLAW_TOOL_SESSIONS_SEND", "sessions_send").strip() or "sessions_send"
SESSION_HISTORY_TOOL = os.getenv("OPENCLAW_TOOL_SESSIONS_HISTORY", "sessions_history").strip() or "sessions_history"
SESSION_SEND_TOOL_CANDIDATES = _dedupe_keep_order(
    [SESSION_SEND_TOOL]
    + _csv_tokens(os.getenv("OPENCLAW_TOOL_SESSIONS_SEND_ALIASES", ""))
    + [
        "sessions_send",
        "sessions.send",
        "session_send",
        "session.send",
        "sessions/send",
    ]
)
SESSION_HISTORY_TOOL_CANDIDATES = _dedupe_keep_order(
    [SESSION_HISTORY_TOOL]
    + _csv_tokens(os.getenv("OPENCLAW_TOOL_SESSIONS_HISTORY_ALIASES", ""))
    + [
        "sessions_history",
        "sessions.history",
        "session_history",
        "session.history",
        "sessions/history",
    ]
)


def _safe_session_segment(value: str, default: str) -> str:
    raw = (value or "").strip().lower() or default
    cleaned = re.sub(r"[^a-z0-9._-]+", "-", raw).strip("-")
    return cleaned or default


SESSION_AGENT_ID = _safe_session_segment(os.getenv("OPENCLAW_SESSION_AGENT_ID", "main"), "main")
SESSION_NAMESPACE = _safe_session_segment(os.getenv("OPENCLAW_SESSION_NAMESPACE", "voice-chat"), "voice-chat")
SESSION_SCOPE = _safe_session_segment(os.getenv("OPENCLAW_SESSION_SCOPE", "shared"), "shared")

# ---- Bot configurations ----
BOT_CONFIG = {
    "main": {"accountId": "main", "name": "Alexa"},
    "coder": {"accountId": "coder", "name": "Blueberry"},
    "visual": {"accountId": "visual", "name": "Jarvis"},
    "tester": {"accountId": "tester", "name": "Grasshopper"},
}
_TELEGRAM_BOT_TOKEN_FALLBACK = os.getenv("TELEGRAM_BOT_TOKEN", "")
for _bot_id, _bot in BOT_CONFIG.items():
    _fallback = f"agent:{SESSION_AGENT_ID}:{SESSION_NAMESPACE}:{_bot['accountId']}:ctx:{SESSION_SCOPE}"
    _override = os.getenv(f"OPENCLAW_SESSION_KEY_{_bot_id.upper()}", "").strip()
    _bot["sessionKey"] = _override or _fallback
    _bot["telegramBotToken"] = (
        os.getenv(f"TELEGRAM_BOT_TOKEN_{_bot_id.upper()}", "").strip() or _TELEGRAM_BOT_TOKEN_FALLBACK
    )
