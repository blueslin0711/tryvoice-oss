# apps/host-runtime/tests/test_wakeword_training_e2e.py
"""
End-to-end tests for wakeword training tool.

Tests the complete training flow from sample upload to model installation.
"""

import pytest
from fastapi.testclient import TestClient
import numpy as np
import io
import wave

from backend.app import app


@pytest.fixture
def client():
    """Create a test client."""
    return TestClient(app)


def create_wav_bytes(audio: np.ndarray, sample_rate: int = 16000) -> bytes:
    """Create WAV file bytes from numpy array."""
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes((audio * 32768).astype(np.int16).tobytes())
    buffer.seek(0)
    return buffer.read()


@pytest.mark.e2e
def test_complete_training_flow(client):
    """Test the complete training flow."""
    # 1. Upload samples
    audio = np.random.randn(16000).astype(np.float32) * 0.5
    wav_bytes = create_wav_bytes(audio)

    upload_resp = client.post(
        "/wakeword/train/samples",
        data={"keyword": "测试唤醒词", "sampleType": "mic"},
        files=[("samples", (f"sample_{i}.wav", wav_bytes, "audio/wav")) for i in range(10)],
    )

    assert upload_resp.status_code == 200
    session_id = upload_resp.json()["sessionId"]
    assert session_id.startswith("train_")

    # 2. Start training
    start_resp = client.post(
        "/wakeword/train/start",
        json={
            "keyword": "测试唤醒词",
            "sessionId": session_id,
            "steps": 100,
        },
    )

    assert start_resp.status_code == 200
    task_id = start_resp.json()["taskId"]
    assert task_id.startswith("task_")

    # 3. Check status
    status_resp = client.get(f"/wakeword/train/status/{task_id}")
    assert status_resp.status_code == 200
    assert "status" in status_resp.json()

    # 4. Cancel training (for test cleanup)
    cancel_resp = client.delete(f"/wakeword/train/{task_id}")
    assert cancel_resp.status_code == 200


@pytest.mark.e2e
def test_tts_generation_flow(client):
    """Test TTS sample generation."""
    resp = client.post(
        "/wakeword/train/tts-generate",
        json={
            "keyword": "小助手",
            "count": 3,
            "voice": "zh-CN-XiaoxiaoNeural",
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert "sessionId" in data
    assert data["generatedCount"] == 3


@pytest.mark.e2e
def test_error_handling(client):
    """Test error handling for invalid requests."""
    # Start training without samples
    resp = client.post(
        "/wakeword/train/start",
        json={
            "keyword": "测试",
            "sessionId": "nonexistent",
            "steps": 100,
        },
    )
    assert resp.status_code == 400

    # Get status of nonexistent task
    resp = client.get("/wakeword/train/status/nonexistent")
    assert resp.status_code == 200
    assert resp.json()["status"] == "not_found"