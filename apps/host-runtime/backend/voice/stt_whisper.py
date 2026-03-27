"""Local Whisper STT provider using faster-whisper (built-in).

Environment variables:
    WHISPER_MODEL_SIZE  -- Model size (default: base)
    WHISPER_DEVICE      -- Device: cpu or cuda (default: cpu)
    WHISPER_COMPUTE_TYPE -- Compute type (default: int8)
"""

from __future__ import annotations

import asyncio
import os
import tempfile


class LocalWhisperSTT:
    """Speech-to-text using faster-whisper (local, offline)."""

    def __init__(self):
        self._model_size = os.getenv("WHISPER_MODEL_SIZE", "base")
        self._device = os.getenv("WHISPER_DEVICE", "cpu")
        self._compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
        self._model = None

    def _get_model(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            self._model = WhisperModel(
                self._model_size,
                device=self._device,
                compute_type=self._compute_type,
            )
        return self._model

    def provider_name(self) -> str:
        return f"whisper-local ({self._model_size}, {self._device})"

    async def transcribe(
        self,
        audio_bytes: bytes,
        *,
        language: str = "auto",
        model: str | None = None,
    ) -> str:
        """Transcribe audio bytes via local faster-whisper model.

        faster-whisper is synchronous, so we run it in a thread executor.
        Input audio (WebM) is written to a temp file for faster-whisper to read.
        """
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._transcribe_sync, audio_bytes, language)

    def _transcribe_sync(self, audio_bytes: bytes, language: str) -> str:
        model = self._get_model()
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
        try:
            kwargs = {}
            if language and language != "auto":
                kwargs["language"] = language
            segments, _info = model.transcribe(tmp_path, **kwargs)
            text = " ".join(seg.text.strip() for seg in segments)
            return text.strip()
        finally:
            os.unlink(tmp_path)
