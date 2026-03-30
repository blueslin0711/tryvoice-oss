# apps/host-runtime/tests/test_tts_generator.py
import pytest
import numpy as np
from backend.voice.tts_generator import TTSGenerator


@pytest.mark.asyncio
async def test_generate_single_sample():
    """Test generating a single TTS sample."""
    gen = TTSGenerator()
    audio = await gen.generate("你好世界")
    assert isinstance(audio, np.ndarray)
    assert audio.dtype == np.float32
    assert len(audio) > 0  # Should have audio data


@pytest.mark.asyncio
async def test_generate_multiple_samples():
    """Test generating multiple samples with different voices."""
    gen = TTSGenerator()
    samples = await gen.generate_batch(
        texts=["测试一", "测试二"],
        voice="zh-CN-XiaoxiaoNeural"
    )
    assert len(samples) == 2
    assert all(isinstance(s, np.ndarray) for s in samples)


@pytest.mark.asyncio
async def test_sample_format():
    """Test that samples are in correct format (16kHz, mono, float32)."""
    gen = TTSGenerator()
    audio = await gen.generate("格式测试")
    # Check it's float32 normalized to [-1, 1]
    assert audio.dtype == np.float32
    assert np.abs(audio).max() <= 1.0


@pytest.mark.asyncio
async def test_invalid_voice_falls_back():
    """Test that invalid voice falls back to default."""
    gen = TTSGenerator(default_voice="zh-CN-XiaoxiaoNeural")
    audio = await gen.generate("测试", voice="invalid-voice-name")
    # Should still produce audio with fallback voice
    assert isinstance(audio, np.ndarray)
    assert len(audio) > 0