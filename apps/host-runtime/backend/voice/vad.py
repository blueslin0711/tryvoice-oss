"""Server-side Voice Activity Detection (Silero VAD).

**Default: OFF.**  Enable via ``TRYVOICE_VAD_ENABLED=1``.

When enabled, audio is checked for speech before sending to STT.
This reduces unnecessary STT calls in noisy environments.

Environment variables:
    TRYVOICE_VAD_ENABLED       — "1", "true", or "yes" to enable (default: 0)
    TRYVOICE_VAD_THRESHOLD     — Confidence threshold 0.0-1.0 (default: 0.5)
    TRYVOICE_VAD_MIN_SPEECH_SECS — Min speech duration to accept (default: 0.3)
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from loguru import logger

VAD_ENABLED = os.getenv("TRYVOICE_VAD_ENABLED", "0").strip().lower() in ("1", "true", "yes")
VAD_THRESHOLD = float(os.getenv("TRYVOICE_VAD_THRESHOLD", "0.5"))
VAD_MIN_SPEECH_SECS = float(os.getenv("TRYVOICE_VAD_MIN_SPEECH_SECS", "0.3"))

_SAMPLE_RATE = 16000
_WINDOW_SIZE_SAMPLES = 512  # 32ms at 16kHz (Silero expects 256/512/768)

# Lazy-loaded ONNX session
_onnx_session = None
_vad_available = None


def _get_onnx_session():
    """Lazy-load the Silero VAD ONNX model."""
    global _onnx_session, _vad_available
    if _vad_available is False:
        return None
    if _onnx_session is not None:
        return _onnx_session

    try:
        import onnxruntime
    except ImportError:
        logger.warning("onnxruntime not installed — VAD disabled. Install with: pip install tryvoice[vad]")
        _vad_available = False
        return None

    model_path = Path(__file__).resolve().parent.parent / "wakeword" / "oww" / "silero_vad.onnx"
    if not model_path.exists():
        logger.warning(f"Silero VAD model not found at {model_path} — VAD disabled.")
        _vad_available = False
        return None

    try:
        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        _onnx_session = onnxruntime.InferenceSession(
            str(model_path),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        _vad_available = True
        logger.info(f"Silero VAD loaded from {model_path}")
        return _onnx_session
    except Exception as exc:
        logger.warning(f"Failed to load Silero VAD: {exc} — VAD disabled.")
        _vad_available = False
        return None


def _webm_to_pcm_16k(audio_bytes: bytes) -> bytes | None:
    """Convert WebM/audio bytes to raw PCM 16kHz mono 16-bit."""
    try:
        from pydub import AudioSegment

        seg = AudioSegment.from_file(
            __import__("io").BytesIO(audio_bytes),
            format="webm",
        )
        seg = seg.set_frame_rate(_SAMPLE_RATE).set_channels(1).set_sample_width(2)
        return seg.raw_data
    except Exception as exc:
        logger.warning(f"VAD: audio decode failed: {exc}")
        return None


def _run_vad_sync(pcm_data: bytes) -> bool:
    """Run Silero VAD on PCM data. Returns True if speech detected."""
    import numpy as np

    session = _get_onnx_session()
    if session is None:
        return True  # Fallback: assume speech present

    samples = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32) / 32768.0
    total_samples = len(samples)
    if total_samples < _WINDOW_SIZE_SAMPLES:
        return False  # Too short

    # Silero VAD v4/v5 state: h and c are LSTM hidden states
    h = np.zeros((2, 1, 64), dtype=np.float32)
    c = np.zeros((2, 1, 64), dtype=np.float32)

    speech_frames = 0
    total_frames = 0
    min_speech_frames = int(VAD_MIN_SPEECH_SECS * _SAMPLE_RATE / _WINDOW_SIZE_SAMPLES)

    for start in range(0, total_samples - _WINDOW_SIZE_SAMPLES + 1, _WINDOW_SIZE_SAMPLES):
        chunk = samples[start : start + _WINDOW_SIZE_SAMPLES]
        input_data = chunk.reshape(1, -1)
        sr = np.array([_SAMPLE_RATE], dtype=np.int64)

        ort_inputs = {
            "input": input_data,
            "h": h,
            "c": c,
            "sr": sr,
        }
        try:
            output, h_out, c_out = session.run(None, ort_inputs)
            h = h_out
            c = c_out
        except Exception:
            return True  # On error, assume speech

        prob = float(output[0])
        total_frames += 1
        if prob >= VAD_THRESHOLD:
            speech_frames += 1
            if speech_frames >= min_speech_frames:
                return True  # Early exit: enough speech detected

    return speech_frames >= min_speech_frames


async def filter_audio_for_stt(audio_bytes: bytes) -> bytes | None:
    """Filter audio through VAD before STT.

    Returns:
        audio_bytes if VAD is disabled or speech is detected.
        None if VAD is enabled and no speech is detected.
    """
    if not VAD_ENABLED:
        return audio_bytes

    loop = asyncio.get_running_loop()

    # Decode audio to PCM
    pcm_data = await loop.run_in_executor(None, _webm_to_pcm_16k, audio_bytes)
    if pcm_data is None:
        return audio_bytes  # Decode failed, pass through

    # Run VAD inference
    has_speech = await loop.run_in_executor(None, _run_vad_sync, pcm_data)
    if has_speech:
        return audio_bytes
    else:
        logger.debug("VAD: no speech detected, skipping STT")
        return None
