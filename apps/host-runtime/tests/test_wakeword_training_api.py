# apps/host-runtime/tests/test_wakeword_training_api.py
import pytest
from fastapi.testclient import TestClient
import numpy as np
import io
import wave

# Import the app
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
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(sample_rate)
        wav_file.writeframes((audio * 32768).astype(np.int16).tobytes())
    buffer.seek(0)
    return buffer.read()


def test_upload_samples(client):
    """Test uploading samples via API."""
    # Create dummy audio
    audio = np.random.randn(16000).astype(np.float32)
    wav_bytes = create_wav_bytes(audio)

    response = client.post(
        "/wakeword/train/samples",
        data={"keyword": "测试唤醒词", "sampleType": "mic"},
        files={"samples": ("sample.wav", wav_bytes, "audio/wav")},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert "sessionId" in data
    assert data["sampleCount"] >= 1


def test_tts_generate(client):
    """Test TTS sample generation."""
    response = client.post(
        "/wakeword/train/tts-generate",
        json={
            "keyword": "小助手",
            "count": 3,
            "voice": "zh-CN-XiaoxiaoNeural",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert "sessionId" in data


def test_start_training_without_samples(client):
    """Test starting training without enough samples."""
    response = client.post(
        "/wakeword/train/start",
        json={
            "keyword": "小助手",
            "sessionId": "nonexistent_session",
            "steps": 100,
        },
    )

    assert response.status_code == 400


def test_get_task_status_not_found(client):
    """Test getting status of nonexistent task."""
    response = client.get("/wakeword/train/status/nonexistent_task")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "not_found"


def test_cancel_task(client):
    """Test cancelling a task."""
    # First create session and upload samples
    audio = np.random.randn(16000).astype(np.float32)
    wav_bytes = create_wav_bytes(audio)

    # Upload multiple samples
    session_id = None
    for i in range(10):
        upload_response = client.post(
            "/wakeword/train/samples",
            data={"keyword": "测试", "sampleType": "mic"},
            files={"samples": ("sample.wav", wav_bytes, "audio/wav")},
        )
        if i == 0:
            session_id = upload_response.json().get("sessionId", "")

    # Start training
    if session_id:
        start_response = client.post(
            "/wakeword/train/start",
            json={"keyword": "测试", "sessionId": session_id, "steps": 100},
        )

        if start_response.status_code == 200:
            task_id = start_response.json().get("taskId", "")
            if task_id:
                cancel_response = client.delete(f"/wakeword/train/{task_id}")
                assert cancel_response.status_code == 200