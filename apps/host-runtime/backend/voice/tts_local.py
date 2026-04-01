# apps/host-runtime/backend/voice/tts_local.py
"""Local TTS provider using pyttsx3 as fallback when edge-tts fails."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from loguru import logger

try:
    import pyttsx3
except ImportError:
    pyttsx3 = None


class LocalTTSGenerator:
    """Generate speech samples using local pyttsx3 engine.

    This is a fallback when edge-tts (network-based) fails due to
    connectivity issues. Quality is lower but it works without network.
    """

    def __init__(
        self,
        sample_rate: int = 16000,
    ):
        self._sample_rate = sample_rate

        if pyttsx3 is None:
            raise RuntimeError("pyttsx3 not installed. Run: pip install pyttsx3")

        # 初始化引擎
        self._engine = pyttsx3.init()
        self._engine.setProperty('rate', 150)  # 语速

        # 查找中文语音
        voices = self._engine.getProperty('voices')
        self._chinese_voice = None
        for voice in voices:
            # 查找包含中文的语音
            if 'chinese' in voice.name.lower() or 'zh' in voice.id.lower():
                self._chinese_voice = voice.id
                break

        if self._chinese_voice:
            logger.info(f"Found Chinese voice: {self._chinese_voice}")
            self._engine.setProperty('voice', self._chinese_voice)
        else:
            logger.warning("No Chinese voice found, using default")

    def generate(
        self,
        text: str,
    ) -> np.ndarray:
        """Generate a single audio sample.

        Args:
            text: Text to synthesize

        Returns:
            Audio as float32 numpy array (16kHz, mono)
        """
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            # 使用 pyttsx3 生成语音
            self._engine.save_to_file(text, str(tmp_path))
            self._engine.runAndWait()

            # 如果文件不存在或太小，可能生成失败
            if not tmp_path.exists() or tmp_path.stat().st_size < 1000:
                # 使用 espeak 作为备选
                logger.warning("pyttsx3 generation failed, trying espeak")
                subprocess.run(
                    ["espeak", "-v", "zh", "-w", str(tmp_path), text],
                    check=True,
                    capture_output=True,
                )

            # 转换采样率
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

            # 读取为 numpy 数组
            data, sr = sf.read(str(tmp2_path))
            return data.astype(np.float32)

        finally:
            if tmp_path.exists():
                tmp_path.unlink()
            if 'tmp2_path' in locals() and tmp2_path.exists():
                tmp2_path.unlink()

    def generate_batch(
        self,
        texts: list[str],
    ) -> list[np.ndarray]:
        """Generate multiple audio samples.

        Args:
            texts: List of texts to synthesize

        Returns:
            List of audio arrays
        """
        results = []
        for text in texts:
            audio = self.generate(text)
            results.append(audio)
        return results