# apps/host-runtime/backend/voice/tts_generator.py
"""TTS sample generation for wakeword training using edge-tts with local fallback."""

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


# Edge TTS 连接超时时间（秒）- 5分钟
EDGE_TTS_TIMEOUT = 300


class TTSGenerator:
    """Generate speech samples using edge-tts with local fallback."""

    def __init__(
        self,
        default_voice: str = "zh-CN-XiaoxiaoNeural",
        sample_rate: int = 16000,
        timeout: int = EDGE_TTS_TIMEOUT,
        enable_fallback: bool = True,
    ):
        self._default_voice = default_voice
        self._sample_rate = sample_rate
        self._timeout = timeout
        self._enable_fallback = enable_fallback
        self._local_tts = None

        if edge_tts is None:
            logger.warning("edge-tts not installed, using local TTS only")
            self._init_local_tts()

    def _init_local_tts(self):
        """Initialize local TTS as fallback."""
        try:
            from backend.voice.tts_local import LocalTTSGenerator
            self._local_tts = LocalTTSGenerator(self._sample_rate)
            logger.info("Local TTS fallback initialized")
        except Exception as e:
            logger.warning(f"Failed to initialize local TTS fallback: {e}")
            self._local_tts = None

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
        # 尝试 edge-tts
        if edge_tts is not None:
            try:
                return await self._generate_edge_tts(text, voice)
            except Exception as e:
                logger.warning(f"Edge TTS failed: {e}")
                if self._enable_fallback:
                    # 尝试初始化本地 TTS 作为备选
                    if not self._local_tts:
                        self._init_local_tts()
                    if self._local_tts:
                        logger.info("Falling back to local TTS")
                        return self._generate_local(text)
                raise

        # 使用本地 TTS
        if self._local_tts:
            return self._generate_local(text)

        raise RuntimeError("No TTS engine available")

    async def _generate_edge_tts(
        self,
        text: str,
        voice: str | None = None,
    ) -> np.ndarray:
        """Generate using edge-tts."""
        v = voice or self._default_voice

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            # Generate with edge-tts (outputs mp3) with timeout
            try:
                communicate = edge_tts.Communicate(text, v)
                await asyncio.wait_for(
                    communicate.save(str(tmp_path)),
                    timeout=self._timeout,
                )
            except asyncio.TimeoutError:
                logger.warning(f"Edge TTS timeout after {self._timeout}s for text: {text[:20]}...")
                raise RuntimeError(f"TTS generation timeout after {self._timeout} seconds")
            except ValueError:
                # Invalid voice, fallback to default
                logger.warning(f"Invalid voice '{v}', falling back to default")
                communicate = edge_tts.Communicate(text, self._default_voice)
                await asyncio.wait_for(
                    communicate.save(str(tmp_path)),
                    timeout=self._timeout,
                )

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

            # Read as numpy array
            data, sr = sf.read(str(tmp2_path))
            return data.astype(np.float32)

        finally:
            if tmp_path.exists():
                tmp_path.unlink()
            if 'tmp2_path' in locals() and tmp2_path.exists():
                tmp2_path.unlink()

    def _generate_local(self, text: str) -> np.ndarray:
        """Generate using local TTS."""
        if not self._local_tts:
            self._init_local_tts()
        if not self._local_tts:
            raise RuntimeError("Local TTS not available")

        # pyttsx3 不是异步的，直接调用
        return self._local_tts.generate(text)

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