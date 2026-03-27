"""Shared utilities for TryVoice adapter implementations."""

from __future__ import annotations

import re
import time
import uuid
from typing import Any

_SPLIT_RE = re.compile(
    r"(?<=[。！？!?；;，,\n])"  # split after CJK/EN punctuation
)


def chunk_text(text: str, *, max_chunk: int = 48) -> list[str]:
    """Split *text* into chunks at natural punctuation boundaries.

    Splits after CJK and common English punctuation marks as well as
    newlines.  If no split point is found within *max_chunk* characters
    the current buffer is flushed as-is.

    Parameters
    ----------
    text:
        The input text to split.
    max_chunk:
        Maximum number of characters before forcing a chunk boundary.
        Defaults to ``48``.

    Returns
    -------
    list[str]
        Ordered list of text chunks.
    """
    parts = _SPLIT_RE.split(text)
    chunks: list[str] = []
    buf = ""
    for part in parts:
        if not part:
            continue
        buf += part
        if _SPLIT_RE.search(buf) or len(buf) >= max_chunk:
            chunks.append(buf)
            buf = ""
    if buf:
        chunks.append(buf)
    return chunks


class MessageBuilder:
    """Build history message dicts in the canonical TryVoice format.

    Each instance maintains a monotonically increasing millisecond
    timestamp so that successive messages are guaranteed to sort in
    creation order.

    Parameters
    ----------
    provider:
        Provider identifier (e.g. ``"anthropic"``, ``"openai"``).
    model:
        Model identifier (e.g. ``"claude-sonnet-4-20250514"``).
    """

    def __init__(self, provider: str, model: str) -> None:
        self._provider = provider
        self._model = model
        self._ts = int(time.time() * 1000)

    def next_ts(self) -> str:
        """Return the next synthetic millisecond timestamp as a string."""
        self._ts += 9
        return str(self._ts)

    def build(self, *, role: str, text: str) -> dict[str, Any]:
        """Create a message dict.

        Parameters
        ----------
        role:
            Message role (``"user"`` or ``"assistant"``).
        text:
            Plain-text content of the message.

        Returns
        -------
        dict[str, Any]
            A message dict conforming to the TryVoice history schema.
        """
        return {
            "id": f"{self._provider}-{uuid.uuid4().hex[:10]}",
            "timestamp": self.next_ts(),
            "role": role,
            "text": text,
            "content": text,
            "stopReason": "stop" if role == "assistant" else "",
            "provider": self._provider,
            "model": self._model,
        }
