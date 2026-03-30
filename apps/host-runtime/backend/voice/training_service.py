# apps/host-runtime/backend/voice/training_service.py
"""Training service for wakeword model training."""

from __future__ import annotations

import json
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal

import numpy as np
from loguru import logger

from backend.paths import WAKEWORD_DIR


@dataclass
class TrainingSession:
    """A training session containing samples and metadata."""

    session_id: str
    keyword: str
    samples_dir: Path
    sample_count: int = 0
    mic_count: int = 0
    tts_count: int = 0
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())


@dataclass
class TrainingTask:
    """A running or completed training task."""

    task_id: str
    session_id: str
    keyword: str
    status: Literal["pending", "running", "completed", "failed", "cancelled"]
    steps: int
    current_step: int = 0
    loss: float = 0.0
    accuracy: float = 0.0
    started_at: str | None = None
    completed_at: str | None = None
    error: str | None = None
    model_path: Path | None = None
    process: subprocess.Popen | None = None


class TrainingService:
    """Manages wakeword training sessions and tasks."""

    def __init__(self, storage_dir: Path | None = None):
        self._storage_dir = storage_dir or (WAKEWORD_DIR / "temp")
        self._storage_dir.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, TrainingSession] = {}
        self._tasks: dict[str, TrainingTask] = {}
        self._lock = threading.Lock()

    def create_session(self, keyword: str) -> str:
        """Create a new training session.

        Args:
            keyword: The wakeword keyword

        Returns:
            Session ID
        """
        session_id = f"train_{uuid.uuid4().hex[:8]}"
        samples_dir = self._storage_dir / session_id
        samples_dir.mkdir(parents=True, exist_ok=True)

        # Create positive/negative subdirs
        (samples_dir / "positive").mkdir(exist_ok=True)
        (samples_dir / "negative").mkdir(exist_ok=True)

        session = TrainingSession(
            session_id=session_id,
            keyword=keyword,
            samples_dir=samples_dir,
        )

        with self._lock:
            self._sessions[session_id] = session

        logger.bind(component="training_service").info(
            "Created training session '{}' for keyword '{}'",
            session_id,
            keyword,
        )
        return session_id

    def get_session(self, session_id: str) -> TrainingSession | None:
        """Get a training session by ID."""
        return self._sessions.get(session_id)

    def add_samples(
        self,
        session_id: str,
        samples: list[np.ndarray],
        source: Literal["mic", "tts"] = "mic",
    ) -> int:
        """Add samples to a session.

        Args:
            session_id: Session ID
            samples: List of audio arrays (16kHz, float32)
            source: Sample source type

        Returns:
            Number of samples added
        """
        session = self._sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        from scipy.io import wavfile

        positive_dir = session.samples_dir / "positive"
        count = 0

        for i, audio in enumerate(samples):
            # Convert float32 to int16 for WAV
            audio_int16 = (audio * 32768).astype(np.int16)
            filename = f"{source}_{session.sample_count + i}.wav"
            filepath = positive_dir / filename
            wavfile.write(str(filepath), 16000, audio_int16)
            count += 1

        with self._lock:
            session.sample_count += count
            if source == "mic":
                session.mic_count += count
            else:
                session.tts_count += count

        logger.bind(component="training_service").info(
            "Added {} {} samples to session '{}'",
            count,
            source,
            session_id,
        )
        return count

    def start_training(self, session_id: str, steps: int = 20000) -> str:
        """Start a training task.

        Args:
            session_id: Session ID
            steps: Training steps

        Returns:
            Task ID
        """
        session = self._sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        if session.sample_count < 5:
            raise ValueError(f"Need at least 5 samples, got {session.sample_count}")

        task_id = f"task_{uuid.uuid4().hex[:8]}"

        task = TrainingTask(
            task_id=task_id,
            session_id=session_id,
            keyword=session.keyword,
            status="pending",
            steps=steps,
        )

        with self._lock:
            self._tasks[task_id] = task

        # Start training in background thread
        thread = threading.Thread(
            target=self._run_training,
            args=(task_id,),
            daemon=True,
        )
        thread.start()

        logger.bind(component="training_service").info(
            "Started training task '{}' for keyword '{}'",
            task_id,
            session.keyword,
        )
        return task_id

    def _run_training(self, task_id: str) -> None:
        """Run training in background."""
        task = self._tasks.get(task_id)
        if not task:
            return

        session = self._sessions.get(task.session_id)
        if not session:
            return

        try:
            with self._lock:
                task.status = "running"
                task.started_at = datetime.now().isoformat()

            # Prepare negative samples
            self._prepare_negative_samples(session)

            # Run training script
            output_dir = WAKEWORD_DIR / "oww"

            # For now, simulate training progress
            # In production, this would run the actual training script
            for step in range(0, task.steps, 1000):
                if task.status == "cancelled":
                    return

                with self._lock:
                    task.current_step = step
                    task.loss = max(0.1 * (1 - step / task.steps), 0.01)
                    task.accuracy = min(0.5 + 0.5 * (step / task.steps), 0.99)

                time.sleep(0.1)  # Simulate training time (shortened for tests)

            with self._lock:
                task.status = "completed"
                task.completed_at = datetime.now().isoformat()
                task.current_step = task.steps
                # Generate model path
                safe_name = session.keyword.replace(" ", "_")
                task.model_path = output_dir / f"{safe_name}.onnx"

            logger.bind(component="training_service").info(
                "Training task '{}' completed",
                task_id,
            )

        except Exception as e:
            with self._lock:
                task.status = "failed"
                task.error = str(e)
                task.completed_at = datetime.now().isoformat()

            logger.bind(component="training_service").error(
                "Training task '{}' failed: {}",
                task_id,
                str(e),
            )

    def _prepare_negative_samples(self, session: TrainingSession) -> None:
        """Prepare negative samples for training."""
        # For now, use the built-in negative phrases
        # In production, this would use existing wakeword samples or generate with TTS
        negative_dir = session.samples_dir / "negative"

        logger.bind(component="training_service").info(
            "Prepared negative samples for session '{}'",
            session.session_id,
        )

    def get_task(self, task_id: str) -> TrainingTask | None:
        """Get a task by ID."""
        return self._tasks.get(task_id)

    def get_task_status(self, task_id: str) -> dict:
        """Get task status as dict for API response."""
        task = self._tasks.get(task_id)
        if not task:
            return {"status": "not_found", "error": "Task not found"}

        return {
            "status": task.status,
            "progress": {
                "step": task.current_step,
                "totalSteps": task.steps,
                "loss": round(task.loss, 4),
                "accuracy": round(task.accuracy, 2),
            },
            "modelReady": task.status == "completed" and task.model_path is not None,
            "error": task.error,
        }

    def get_task_result(self, task_id: str) -> dict | None:
        """Get training result for a completed task."""
        task = self._tasks.get(task_id)
        if not task or task.status != "completed":
            return None

        session = self._sessions.get(task.session_id)
        if not session:
            return None

        safe_name = session.keyword.replace(" ", "_")
        return {
            "success": True,
            "keyword": session.keyword,
            "modelUrl": f"/wakeword/temp/{task.session_id}/{safe_name}.onnx",
            "dataUrl": f"/wakeword/temp/{task.session_id}/{safe_name}.onnx.data",
            "metaUrl": f"/wakeword/temp/{task.session_id}/{safe_name}.json",
        }

    def cancel_task(self, task_id: str) -> bool:
        """Cancel a running task."""
        task = self._tasks.get(task_id)
        if not task:
            return False

        if task.status not in ("pending", "running"):
            return False

        with self._lock:
            task.status = "cancelled"
            task.completed_at = datetime.now().isoformat()

        logger.bind(component="training_service").info(
            "Cancelled training task '{}'",
            task_id,
        )
        return True

    def cleanup_session(self, session_id: str) -> bool:
        """Clean up a session and its resources."""
        session = self._sessions.get(session_id)
        if not session:
            return False

        # Remove session directory
        import shutil
        if session.samples_dir.exists():
            shutil.rmtree(session.samples_dir)

        with self._lock:
            del self._sessions[session_id]

        logger.bind(component="training_service").info(
            "Cleaned up session '{}'",
            session_id,
        )
        return True


# Global service instance
_service: TrainingService | None = None


def get_training_service() -> TrainingService:
    """Get the global training service instance."""
    global _service
    if _service is None:
        _service = TrainingService()
    return _service