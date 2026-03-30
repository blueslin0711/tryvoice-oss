# apps/host-runtime/backend/voice/tts_generator.py
"""TTS sample generation for wakeword training using edge-tts."""

from __future__ import annotations

import asyncio
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from loguru import logger

try:
    import edge_tts
except ImportError:
    edge_tts = None


class TTSGenerator:
    """Generate speech samples using edge-tts."""

    def __init__(
        self,
        default_voice: str = "zh-CN-XiaoxiaoNeural",
        sample_rate: int = 16000,
    ):
        self._default_voice = default_voice
        self._sample_rate = sample_rate

        if edge_tts is None:
            raise RuntimeError("edge-tts not installed. Run: pip install edge-tts")

    async def generate(
        self,
        text: str,
        *,
        voice: str | None = None,
    ) -> np.ndarray:
        """Generate a single audio sample.

        Args:
            text: Text to synthesize
            voice: Voice name (falls back to default)

        Returns:
            Audio as float32 numpy array (16kHz, mono)
        """
        v = voice or self._default_voice

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            # Generate with edge-tts (outputs mp3)
            try:
                communicate = edge_tts.Communicate(text, v)
            except ValueError:
                # Invalid voice, fallback to default
                logger.warning(f"Invalid voice '{v}', falling back to default")
                communicate = edge_tts.Communicate(text, self._default_voice)
            await communicate.save(str(tmp_path))

            # Convert to wav using ffmpeg
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp2:
                tmp2_path = Path(tmp2.name)

            subprocess.run(
                [
                    "ffmpeg", "-y", "-i", str(tmp_path),
                    "-ar", str(self._sample_rate),
                    "-ac", "1",
                    "-f", "wav",
                    str(tmp2_path)
                ],
                check=True,
                capture_output=True,
            )

            # Read as numpy array using soundfile
            data, sr = sf.read(str(tmp2_path))
            # soundfile returns float32 normalized to [-1, 1] by default
            return data.astype(np.float32)

        finally:
            # Cleanup temp files
            if tmp_path.exists():
                tmp_path.unlink()
            if 'tmp2_path' in locals() and tmp2_path.exists():
                tmp2_path.unlink()

    async def generate_batch(
        self,
        texts: list[str],
        *,
        voice: str | None = None,
    ) -> list[np.ndarray]:
        """Generate multiple audio samples.

        Args:
            texts: List of texts to synthesize
            voice: Voice name (falls back to default)

        Returns:
            List of audio arrays
        """
        results = []
        for text in texts:
            audio = await self.generate(text, voice=voice)
            results.append(audio)
        return results