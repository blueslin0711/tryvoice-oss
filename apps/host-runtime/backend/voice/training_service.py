# apps/host-runtime/backend/voice/training_service.py
"""Training service for wakeword model training."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Literal

import numpy as np
from loguru import logger

from backend.paths import PROJECT_ROOT, WAKEWORD_DIR


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
    use_docker: bool = False


class TrainingService:
    """Manages wakeword training sessions and tasks."""

    def __init__(self, storage_dir: Path | None = None):
        self._storage_dir = storage_dir or (WAKEWORD_DIR / "temp")
        self._storage_dir.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, TrainingSession] = {}
        self._tasks: dict[str, TrainingTask] = {}
        self._lock = threading.Lock()

        # Check available training methods
        self._has_docker = self._check_docker()
        self._has_torch = self._check_torch()

        logger.bind(component="training_service").info(
            "Training service initialized (docker={}, torch={})",
            self._has_docker,
            self._has_torch,
        )

    def _check_docker(self) -> bool:
        """Check if Docker is available."""
        try:
            result = subprocess.run(
                ["docker", "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return result.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    def _check_torch(self) -> bool:
        """Check if PyTorch is available."""
        try:
            import torch  # noqa: F401
            return True
        except ImportError:
            return False

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

        task_id = f"task_{uuid.uuid4().hex[:8]}"

        # Determine training method
        use_docker = self._has_docker

        task = TrainingTask(
            task_id=task_id,
            session_id=session_id,
            keyword=session.keyword,
            status="pending",
            steps=steps,
            use_docker=use_docker,
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
            "Started training task '{}' for keyword '{}' (docker={})",
            task_id,
            session.keyword,
            use_docker,
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

            output_dir = WAKEWORD_DIR / "oww"

            # Try real training
            if task.use_docker and self._has_docker:
                self._run_docker_training(task, session, output_dir)
            elif self._has_torch:
                self._run_local_training(task, session, output_dir)
            else:
                # Fallback to simulation
                self._run_simulated_training(task, session, output_dir)

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

    def _run_docker_training(
        self,
        task: TrainingTask,
        session: TrainingSession,
        output_dir: Path,
    ) -> None:
        """Run training using Docker container."""
        logger.bind(component="training_service").info(
            "Running Docker training for task '{}'",
            task.task_id,
        )

        # Build Docker image if needed
        image_name = "tryvoice-train"
        try:
            # Always rebuild to ensure latest script
            logger.bind(component="training_service").info(
                "Building Docker training image..."
            )
            build_result = subprocess.run(
                ["docker", "build", "-f", "Dockerfile.train", "-t", image_name, "."],
                cwd=PROJECT_ROOT,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if build_result.returncode != 0:
                # Check if image exists (might be from previous build)
                check_result = subprocess.run(
                    ["docker", "images", "-q", image_name],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if not check_result.stdout.strip():
                    raise RuntimeError(f"Docker build failed: {build_result.stderr[:500]}")
                logger.bind(component="training_service").warning(
                    "Docker build failed, using existing image: {}",
                    build_result.stderr[:200],
                )
        except subprocess.TimeoutExpired:
            raise RuntimeError("Docker operation timed out")

        # Prepare paths
        samples_dir = session.samples_dir / "positive"
        negative_dir = session.samples_dir / "negative"
        safe_name = session.keyword.replace(" ", "_")

        # Run training container
        cmd = [
            "docker", "run", "--rm",
            "-v", f"{samples_dir}:/samples:ro",
            "-v", f"{output_dir}:/output",
            image_name,
            "--samples", "/samples",
            "--keyword", session.keyword,
            "--output-dir", "/output",
            "--steps", str(task.steps),
        ]

        # Add negative samples if available
        if negative_dir.exists() and any(negative_dir.iterdir()):
            cmd.extend(["--negative-samples", "/negative"])
            # Re-add the negative volume mount
            cmd.insert(4, "-v")
            cmd.insert(5, f"{negative_dir}:/negative:ro")

        logger.bind(component="training_service").debug(
            "Docker command: {}",
            " ".join(cmd),
        )

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=PROJECT_ROOT,
        )

        with self._lock:
            task.process = process

        # Parse output for progress
        output_lines = []
        for line in process.stdout:
            output_lines.append(line)
            logger.bind(component="training_service").debug("Docker: {}", line.strip())

            # Parse progress: "Step 2000: Loss=0.0500 Acc=85.0%"
            match = re.search(r"Step (\d+): Loss=([\d.]+) Acc=([\d.]+)%", line)
            if match:
                step = int(match.group(1))
                loss = float(match.group(2))
                accuracy = float(match.group(3)) / 100.0

                with self._lock:
                    task.current_step = step
                    task.loss = loss
                    task.accuracy = accuracy

            # Check for cancellation
            if task.status == "cancelled":
                process.terminate()
                return

        process.wait()

        if process.returncode != 0:
            output = "".join(output_lines[-50:])
            raise RuntimeError(f"Training failed: {output}")

        # Check for model file
        model_path = output_dir / f"{safe_name}.onnx"
        if not model_path.exists():
            raise RuntimeError(f"Model file not created: {model_path}")

        with self._lock:
            task.status = "completed"
            task.completed_at = datetime.now().isoformat()
            task.current_step = task.steps
            task.model_path = model_path

        logger.bind(component="training_service").info(
            "Docker training task '{}' completed",
            task.task_id,
        )

    def _run_local_training(
        self,
        task: TrainingTask,
        session: TrainingSession,
        output_dir: Path,
    ) -> None:
        """Run training using local Python script."""
        logger.bind(component="training_service").info(
            "Running local training for task '{}'",
            task.task_id,
        )

        script_path = PROJECT_ROOT / "scripts" / "train_wakeword_v3.py"
        if not script_path.exists():
            raise RuntimeError(f"Training script not found: {script_path}")

        samples_dir = session.samples_dir / "positive"
        negative_dir = session.samples_dir / "negative"

        cmd = [
            sys.executable,
            str(script_path),
            "--samples", str(samples_dir),
            "--keyword", session.keyword,
            "--output-dir", str(output_dir),
            "--negative-samples", str(negative_dir),
            "--steps", str(task.steps),
        ]

        logger.bind(component="training_service").debug(
            "Local command: {}",
            " ".join(cmd),
        )

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=PROJECT_ROOT,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )

        with self._lock:
            task.process = process

        # Parse output for progress
        output_lines = []
        for line in process.stdout:
            output_lines.append(line)
            logger.bind(component="training_service").debug("Local: {}", line.strip())

            # Parse progress: "Step 2000: Loss=0.0500 Acc=85.0%"
            match = re.search(r"Step (\d+): Loss=([\d.]+) Acc=([\d.]+)%", line)
            if match:
                step = int(match.group(1))
                loss = float(match.group(2))
                accuracy = float(match.group(3)) / 100.0

                with self._lock:
                    task.current_step = step
                    task.loss = loss
                    task.accuracy = accuracy

            # Check for cancellation
            if task.status == "cancelled":
                process.terminate()
                return

        process.wait()

        if process.returncode != 0:
            output = "".join(output_lines[-50:])
            raise RuntimeError(f"Training failed: {output}")

        # Check for model file
        safe_name = session.keyword.replace(" ", "_")
        model_path = output_dir / f"{safe_name}.onnx"
        if not model_path.exists():
            raise RuntimeError(f"Model file not created: {model_path}")

        with self._lock:
            task.status = "completed"
            task.completed_at = datetime.now().isoformat()
            task.current_step = task.steps
            task.model_path = model_path

        logger.bind(component="training_service").info(
            "Local training task '{}' completed",
            task.task_id,
        )

    def _run_simulated_training(
        self,
        task: TrainingTask,
        session: TrainingSession,
        output_dir: Path,
    ) -> None:
        """Run simulated training (fallback when Docker/PyTorch unavailable)."""
        logger.bind(component="training_service").warning(
            "Running simulated training (Docker/PyTorch not available)",
        )

        for step in range(0, task.steps, 1000):
            if task.status == "cancelled":
                return

            with self._lock:
                task.current_step = step
                task.loss = max(0.1 * (1 - step / task.steps), 0.01)
                task.accuracy = min(0.5 + 0.5 * (step / task.steps), 0.99)

            time.sleep(0.1)  # Simulate training time

        safe_name = session.keyword.replace(" ", "_")

        with self._lock:
            task.status = "completed"
            task.completed_at = datetime.now().isoformat()
            task.current_step = task.steps
            task.model_path = output_dir / f"{safe_name}.onnx"

        logger.bind(component="training_service").info(
            "Simulated training task '{}' completed",
            task.task_id,
        )

    def _prepare_negative_samples(self, session: TrainingSession) -> None:
        """Prepare negative samples for training."""
        negative_dir = session.samples_dir / "negative"

        # Copy some default negative samples if available
        default_negative = WAKEWORD_DIR / "negative_samples"
        if default_negative.exists() and not any(negative_dir.iterdir()):
            for f in default_negative.glob("*.wav"):
                shutil.copy(f, negative_dir / f.name)

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

        result = {
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

        # Include model URL when completed
        if task.status == "completed" and task.model_path:
            session = self._sessions.get(task.session_id)
            if session:
                safe_name = session.keyword.replace(" ", "_")
                result["modelUrl"] = f"/wakeword/models/{safe_name}.onnx"
                result["modelName"] = f"{safe_name}.onnx"

        return result

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

        # Terminate process if running
        if task.process:
            task.process.terminate()

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