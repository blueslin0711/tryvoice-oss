"""Edge TTS provider implementation."""

from __future__ import annotations

import os


class EdgeTTSProvider:
    """Text-to-speech using Microsoft Edge TTS (free, async)."""

    def __init__(self, *, default_voice: str | None = None):
        self._default_voice = default_voice or os.getenv("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")

    def provider_name(self) -> str:
        return f"edge ({self._default_voice})"

    async def synthesize(
        self,
        text: str,
        *,
        voice: str | None = None,
        rate: str = "1.0",
    ) -> bytes:
        """Synthesize text to audio bytes via Edge TTS."""
        import edge_tts

        v = voice or self._default_voice
        rate_f = float(rate) if rate else 1.0
        rate_pct = f"{int((rate_f - 1) * 100):+d}%"
        communicate = edge_tts.Communicate(text, v, rate=rate_pct, volume="+0%")
        audio_data = b""
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_data += chunk["data"]
        return audio_data
