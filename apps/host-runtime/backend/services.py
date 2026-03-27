"""Deprecated: use backend.voice.stt_registry and tts_registry."""

from backend.voice.stt_registry import get_stt_provider
from backend.voice.tts_registry import get_tts_provider


async def transcribe_audio(audio_bytes, session=None, language="en", model=None):
    return await get_stt_provider().transcribe(audio_bytes, language=language)


async def text_to_speech(text, session=None, voice=None, rate="1.0"):
    return await get_tts_provider().synthesize(text, voice=voice, rate=rate)
