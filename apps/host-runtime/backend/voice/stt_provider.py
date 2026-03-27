"""STT Provider Protocol — pluggable speech-to-text interface."""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class STTProvider(Protocol):
    """Interface for speech-to-text providers."""

    async def transcribe(self, audio_bytes: bytes, *, language: str = "auto") -> str:
        """Transcribe audio bytes to text."""
        ...

    def provider_name(self) -> str:
        """Return a human-readable provider name."""
        ...
