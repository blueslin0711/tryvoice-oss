# apps/host-runtime/tests/test_training_service.py
import pytest
import tempfile
from pathlib import Path
import numpy as np

from backend.voice.training_service import TrainingService, TrainingTask


@pytest.fixture
def temp_storage():
    """Create a temporary storage directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def service(temp_storage):
    """Create a training service with temp storage."""
    return TrainingService(storage_dir=temp_storage)


def test_create_session(service):
    """Test creating a training session."""
    session_id = service.create_session("测试唤醒词")
    assert session_id.startswith("train_")
    assert "测试唤醒词" in session_id or service.get_session(session_id).keyword == "测试唤醒词"


def test_upload_samples(service):
    """Test uploading samples to a session."""
    session_id = service.create_session("小助手")

    # Create dummy audio samples (16kHz, 1 second)
    samples = [np.zeros(16000, dtype=np.float32) for _ in range(5)]

    service.add_samples(session_id, samples, source="mic")

    session = service.get_session(session_id)
    assert session.sample_count == 5


def test_add_tts_samples(service):
    """Test adding TTS-generated samples."""
    session_id = service.create_session("小助手")
    samples = [np.zeros(16000, dtype=np.float32) for _ in range(3)]

    service.add_samples(session_id, samples, source="tts")

    session = service.get_session(session_id)
    assert session.sample_count == 3
    assert session.tts_count == 3


def test_get_nonexistent_session(service):
    """Test getting a session that doesn't exist."""
    assert service.get_session("nonexistent") is None


def test_start_training(service):
    """Test starting a training task."""
    session_id = service.create_session("小助手")
    samples = [np.random.randn(16000).astype(np.float32) for _ in range(10)]
    service.add_samples(session_id, samples, source="mic")

    task_id = service.start_training(session_id, steps=100)

    assert task_id.startswith("task_")
    task = service.get_task(task_id)
    assert task is not None
    assert task.status in ("pending", "running")


def test_get_task_status(service):
    """Test querying task status."""
    session_id = service.create_session("小助手")
    samples = [np.random.randn(16000).astype(np.float32) for _ in range(10)]
    service.add_samples(session_id, samples, source="mic")

    task_id = service.start_training(session_id, steps=100)
    status = service.get_task_status(task_id)

    assert "status" in status
    assert "progress" in status


def test_cancel_task(service):
    """Test cancelling a training task."""
    session_id = service.create_session("小助手")
    samples = [np.random.randn(16000).astype(np.float32) for _ in range(10)]
    service.add_samples(session_id, samples, source="mic")

    task_id = service.start_training(session_id, steps=100)
    result = service.cancel_task(task_id)

    assert result is True
    task = service.get_task(task_id)
    assert task.status == "cancelled"


def test_cleanup_session(service):
    """Test cleaning up session resources."""
    session_id = service.create_session("小助手")
    service.cleanup_session(session_id)

    assert service.get_session(session_id) is None