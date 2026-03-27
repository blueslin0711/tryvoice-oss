"""Groq Whisper STT provider implementation."""

from __future__ import annotations

import logging
import os

import aiohttp

logger = logging.getLogger(__name__)


class GroqWhisperSTT:
    """Speech-to-text using Groq's Whisper API."""

    def __init__(self, *, api_key: str | None = None, default_model: str | None = None):
        # Store explicit key; if None, read from env on each call so .env
        # hot-reloads take effect without re-creating the provider instance.
        self._explicit_api_key = api_key
        self._default_model = default_model or os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo")

    @property
    def _api_key(self) -> str:
        return self._explicit_api_key or os.getenv("GROQ_API_KEY", "")

    def provider_name(self) -> str:
        return f"groq-whisper ({self._default_model})"

    async def transcribe(
        self,
        audio_bytes: bytes,
        *,
        language: str = "auto",
        model: str | None = None,
    ) -> str:
        """Transcribe audio bytes via Groq Whisper cloud API."""
        api_key = self._api_key
        if not api_key:
            raise RuntimeError("GROQ_API_KEY not configured")
        url = "https://api.groq.com/openai/v1/audio/transcriptions"
        headers = {"Authorization": f"Bearer {api_key}"}
        form = aiohttp.FormData()
        form.add_field("file", audio_bytes, filename="audio.webm", content_type="audio/webm")
        form.add_field("model", model or self._default_model)
        if language and language != "auto":
            form.add_field("language", language)
        form.add_field("response_format", "json")

        async with aiohttp.ClientSession() as session:
            async with session.post(url, headers=headers, data=form) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("text", "").strip()
                body = await resp.text()
                logger.error(
                    "Groq STT API error: status=%d body=%s",
                    resp.status,
                    body[:500],
                )
                raise RuntimeError(f"Groq STT error {resp.status}: {body[:200]}")
