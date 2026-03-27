"""TTS Provider Protocol — pluggable text-to-speech interface."""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class TTSProvider(Protocol):
    """Interface for text-to-speech providers."""

    async def synthesize(self, text: str, *, voice: str | None = None, rate: str = "1.0") -> bytes:
        """Synthesize text to audio bytes (MP3/WebM/etc)."""
        ...

    def provider_name(self) -> str:
        """Return a human-readable provider name."""
        ...
