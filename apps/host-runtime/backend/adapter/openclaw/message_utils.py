"""History message extraction and utility helpers (generic, no vendor dependency)."""

from __future__ import annotations

import re
from typing import Any


def extract_history_messages(result: dict) -> list:
    if not result.get("ok"):
        return []
    res = result.get("result", {})
    details = res.get("details", {})
    if isinstance(details, dict) and "messages" in details:
        return details["messages"]
    if isinstance(res, list):
        return res
    return []


def msg_content_text(msg: dict) -> str:
    content = msg.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                parts.append(c["text"])
        return "\n".join(parts)
    return str(content)


def msg_id(msg: dict) -> str:
    return str(msg.get("timestamp", "") or msg.get("id", "") or msg.get("ts", ""))


def _msg_signature(msg: dict) -> str:
    """Best-effort stable signature for dedup across history polling windows."""
    role = str(msg.get("role", ""))
    mid = msg_id(msg)
    text = msg_content_text(msg).strip().replace("\n", " ")[:240]
    return f"{role}|{mid}|{text}"


def _summarize_value(value: Any, max_len: int = 120) -> str:
    if isinstance(value, str):
        one_line = re.sub(r"\s+", " ", value.strip())
        return one_line[:max_len]
    if isinstance(value, (int, float, bool)) or value is None:
        return str(value)
    if isinstance(value, dict):
        return f"dict(keys={list(value.keys())[:8]})"
    if isinstance(value, list):
        return f"list(len={len(value)})"
    one_line = re.sub(r"\s+", " ", str(value).strip())
    return one_line[:max_len]
