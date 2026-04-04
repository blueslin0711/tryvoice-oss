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


# 预定义的中文短语用于生成负向样本
# 这些是常见的日常用语，与唤醒词不同，用于训练模型区分唤醒词和其他语音
NEGATIVE_PHRASES = [
    # 日常对话
    "你好",
    "今天天气不错",
    "请问几点了",
    "谢谢",
    "再见",
    "明天的安排是什么",
    "帮我查一下",
    "打开音乐",
    "关闭灯光",
    "播放下一首",
    "暂停一下",
    "继续播放",
    "调大音量",
    "现在几点",
    "设置闹钟",
    "明天见",
    "晚上好",
    "早上好",
    "下午好",
    "晚安",
    "好的",
    "没问题",
    "我知道了",
    "稍等一下",
    "马上来",
    "在的",
    "可以",
    "明白了",
    "好的好的",
    "收到",
    # 更多日常用语
    "你好世界",
    "请问有什么可以帮助你",
    "我想了解一下",
    "麻烦帮我查一下",
    "接下来我要说的是",
    "让我们开始吧",
    "你可以重复一遍吗",
    "我听不太清楚",
    "请再说一遍",
    "好的我知道了",
    "这个很有意思",
    "我需要确认一下",
    "稍等片刻",
    "马上为你处理",
    "非常感谢你的帮助",
    "没问题我来处理",
    "这个事情很重要",
    "让我们一起来看看",
    "这是我的想法",
    "请问一下",
    "我想问个问题",
    "能帮我吗",
    "清楚了吗",
    "还有什么",
    "继续说",
    "停一下",
    "等一下",
    "正在处理",
    "已经完成",
    "还没开始",
    "正在进行",
    "马上就好",
    "很快完成",
    "需要时间",
    "请耐心等待",
    # 易混淆短语
    "大橘",
    "橘子",
    "大橘子",
    "小橘子",
    "橘橘",
    "橘子皮",
    "橙子",
    "小橙",
    "苹果",
    "香蕉",
    "西瓜",
    "草莓",
    "葡萄",
    "梨子",
    # 更多混淆词
    "你好吗",
    "在吗",
    "听到了",
    "听到了吗",
    "在不在",
    "有人吗",
    "谁呀",
    "什么事",
    "干嘛",
    "做什么",
]

# 多种语音选项增加多样性
TTS_VOICES = [
    "zh-CN-XiaoxiaoNeural",  # 女声，活泼
    "zh-CN-YunxiNeural",     # 男声，年轻
    "zh-CN-YunyangNeural",   # 男声，新闻播报
    "zh-CN-XiaoyiNeural",    # 女声，温柔
    "zh-CN-YunjianNeural",   # 男声，激情
]

# 语速和音调变化
TTS_RATES = ["-0%", "-15%", "-30%", "+0%", "+15%", "+30%"]
TTS_PITCHES = ["-0Hz", "-15Hz", "-30Hz", "+0Hz", "+15Hz", "+30Hz"]


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

    async def generate_with_variation(
        self,
        text: str,
        *,
        voice: str | None = None,
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> np.ndarray:
        """Generate a single audio sample with rate/pitch variations.

        Args:
            text: Text to synthesize
            voice: Voice name (falls back to default)
            rate: Speech rate (e.g., "-20%", "+10%")
            pitch: Pitch adjustment (e.g., "-20Hz", "+10Hz")

        Returns:
            Audio as float32 numpy array (16kHz, mono)
        """
        # 尝试 edge-tts
        if edge_tts is not None:
            try:
                return await self._generate_edge_tts(text, voice, rate=rate, pitch=pitch)
            except Exception as e:
                logger.warning(f"Edge TTS failed: {e}")
                if self._enable_fallback:
                    if not self._local_tts:
                        self._init_local_tts()
                    if self._local_tts:
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
        rate: str = "+0%",
        pitch: str = "+0Hz",
    ) -> np.ndarray:
        """Generate using edge-tts."""
        v = voice or self._default_voice

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            # Generate with edge-tts (outputs mp3) with timeout
            try:
                communicate = edge_tts.Communicate(text, v, rate=rate, pitch=pitch)
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
                communicate = edge_tts.Communicate(text, self._default_voice, rate=rate, pitch=pitch)
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
            data = data.astype(np.float32)

            # Normalize to target RMS for consistent volume
            rms = np.sqrt(np.mean(data ** 2))
            if rms > 1e-8:
                target_rms = 0.1
                data = data * (target_rms / rms)

            return data

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
        data = self._local_tts.generate(text)

        # Normalize to target RMS for consistent volume
        rms = np.sqrt(np.mean(data ** 2))
        if rms > 1e-8:
            target_rms = 0.1
            data = data * (target_rms / rms)

        return data

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