# apps/host-runtime/backend/routes/wakeword_training.py
"""
Wakeword training API endpoints.

- POST   /wakeword/train/samples       -- upload samples
- POST   /wakeword/train/tts-generate  -- generate TTS samples
- POST   /wakeword/train/start         -- start training
- GET    /wakeword/train/status/{id}   -- get training status
- GET    /wakeword/train/result/{id}   -- get training result
- DELETE /wakeword/train/{id}          -- cancel training
- POST   /wakeword/train/install       -- install model
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from loguru import logger

from backend.voice.training_service import get_training_service
from backend.voice.tts_generator import TTSGenerator

router = APIRouter()


@router.post("/wakeword/train/samples")
async def upload_samples(
    keyword: str = Form(...),
    sampleType: str = Form("mic"),
    samples: list[UploadFile] = File(default=[]),
):
    """Upload microphone-recorded samples.

    Args:
        keyword: The wakeword keyword
        sampleType: 'mic' or 'tts'
        samples: List of WAV files (optional, can be empty)

    Returns:
        Session ID and sample count
    """
    import numpy as np
    from scipy.io import wavfile
    import io

    service = get_training_service()

    # Get or create session
    session_id = service.create_session(keyword)

    # Process uploaded files (if any)
    audio_samples = []
    for upload in samples:
        content = await upload.read()
        try:
            # Read WAV file
            buffer = io.BytesIO(content)
            sr, data = wavfile.read(buffer)

            # Convert to float32
            if data.dtype == np.int16:
                data = data.astype(np.float32) / 32768.0
            elif data.dtype == np.int32:
                data = data.astype(np.float32) / 2147483648.0

            # Ensure mono
            if len(data.shape) > 1:
                data = data.mean(axis=1)

            audio_samples.append(data)

        except Exception as e:
            logger.bind(component="wakeword_training").warning(
                "Failed to process sample: {}",
                str(e),
            )

    # Allow empty samples - will use TTS later
    count = 0
    if audio_samples:
        # Add samples to session
        source = "mic" if sampleType == "mic" else "tts"
        count = service.add_samples(session_id, audio_samples, source=source)

    logger.bind(component="wakeword_training").info(
        "Uploaded {} samples for keyword '{}'",
        count,
        keyword,
    )

    return JSONResponse({
        "success": True,
        "sampleCount": count,
        "sessionId": session_id,
    })


@router.post("/wakeword/train/tts-generate")
async def tts_generate(request: dict):
    """Generate TTS samples for a keyword.

    Args:
        keyword: The wakeword keyword
        count: Number of samples to generate
        voice: TTS voice name

    Returns:
        Session ID and generated count
    """
    keyword = request.get("keyword", "")
    count = request.get("count", 5)
    voice = request.get("voice", "zh-CN-XiaoxiaoNeural")

    if not keyword:
        return JSONResponse(
            {"success": False, "error": "keyword is required"},
            status_code=400,
        )

    service = get_training_service()
    generator = TTSGenerator()

    # Create session
    session_id = service.create_session(keyword)

    try:
        # Generate samples (repeat keyword multiple times with variations)
        texts = [keyword] * count
        audio_samples = await generator.generate_batch(texts, voice=voice)

        # Add to session
        added = service.add_samples(session_id, audio_samples, source="tts")

        logger.bind(component="wakeword_training").info(
            "Generated {} TTS samples for keyword '{}'",
            added,
            keyword,
        )

        return JSONResponse({
            "success": True,
            "generatedCount": added,
            "sessionId": session_id,
        })

    except Exception as e:
        logger.bind(component="wakeword_training").error(
            "TTS generation failed: {}",
            str(e),
        )
        return JSONResponse(
            {"success": False, "error": str(e)},
            status_code=500,
        )


@router.post("/wakeword/train/start")
async def start_training(request: dict):
    """Start a training task.

    Args:
        keyword: The wakeword keyword
        sessionId: Session ID with samples
        steps: Training steps (default 20000)

    Returns:
        Task ID for status polling
    """
    keyword = request.get("keyword", "")
    session_id = request.get("sessionId", "")
    steps = request.get("steps", 20000)

    if not session_id:
        return JSONResponse(
            {"success": False, "error": "sessionId is required"},
            status_code=400,
        )

    service = get_training_service()
    session = service.get_session(session_id)

    if not session:
        return JSONResponse(
            {"success": False, "error": "Session not found"},
            status_code=400,
        )

    # 不再强制要求最小样本数，TTS 已生成足够样本
    # 训练服务会处理样本数量验证

    try:
        task_id = service.start_training(session_id, steps=steps)

        logger.bind(component="wakeword_training").info(
            "Started training task '{}' for keyword '{}'",
            task_id,
            keyword,
        )

        return JSONResponse({
            "success": True,
            "taskId": task_id,
        })

    except Exception as e:
        logger.bind(component="wakeword_training").error(
            "Failed to start training: {}",
            str(e),
        )
        return JSONResponse(
            {"success": False, "error": str(e)},
            status_code=500,
        )


@router.get("/wakeword/train/status/{task_id}")
async def get_training_status(task_id: str):
    """Get training task status.

    Args:
        task_id: Task ID

    Returns:
        Status and progress information
    """
    service = get_training_service()
    status = service.get_task_status(task_id)
    return JSONResponse(status)


@router.get("/wakeword/train/result/{task_id}")
async def get_training_result(task_id: str):
    """Get training result (model URLs).

    Args:
        task_id: Task ID

    Returns:
        Model file URLs
    """
    service = get_training_service()
    result = service.get_task_result(task_id)

    if not result:
        return JSONResponse(
            {"success": False, "error": "Result not available"},
            status_code=404,
        )

    return JSONResponse(result)


@router.delete("/wakeword/train/{task_id}")
async def cancel_training(task_id: str):
    """Cancel a training task.

    Args:
        task_id: Task ID

    Returns:
        Success status
    """
    service = get_training_service()
    success = service.cancel_task(task_id)

    if success:
        return JSONResponse({
            "success": True,
            "message": "Training cancelled and resources cleaned up",
        })
    else:
        return JSONResponse(
            {"success": False, "error": "Task not found or already completed"},
            status_code=404,
        )


@router.post("/wakeword/train/install")
async def install_model(request: dict):
    """Install a trained model.

    Args:
        keyword: The wakeword keyword
        taskId: Task ID

    Returns:
        Installed path
    """
    import shutil
    from pathlib import Path

    keyword = request.get("keyword", "")
    task_id = request.get("taskId", "")

    if not task_id:
        return JSONResponse(
            {"success": False, "error": "taskId is required"},
            status_code=400,
        )

    service = get_training_service()
    task = service.get_task(task_id)

    if not task or task.status != "completed":
        return JSONResponse(
            {"success": False, "error": "Task not found or not completed"},
            status_code=400,
        )

    # Copy model files to oww directory
    from backend.paths import WAKEWORD_DIR

    oww_dir = WAKEWORD_DIR / "oww"
    oww_dir.mkdir(parents=True, exist_ok=True)

    safe_name = keyword.replace(" ", "_")
    session = service.get_session(task.session_id)

    if session and session.samples_dir:
        # Copy model files
        temp_model = session.samples_dir / f"{safe_name}.onnx"
        if temp_model.exists():
            shutil.copy(temp_model, oww_dir / f"{safe_name}.onnx")

        temp_data = session.samples_dir / f"{safe_name}.onnx.data"
        if temp_data.exists():
            shutil.copy(temp_data, oww_dir / f"{safe_name}.onnx.data")

    installed_path = str(oww_dir / f"{safe_name}.onnx")

    logger.bind(component="wakeword_training").info(
        "Installed model for keyword '{}' to {}",
        keyword,
        installed_path,
    )

    return JSONResponse({
        "success": True,
        "installedPath": installed_path,
    })


@router.get("/wakeword/models/{filename}")
async def download_model(filename: str):
    """Download a trained model file.

    Args:
        filename: Model filename (e.g., "我的唤醒词.onnx")

    Returns:
        Model file
    """
    from fastapi.responses import FileResponse
    from backend.paths import WAKEWORD_DIR

    # Security: only allow .onnx, .onnx.data, .json files
    if not filename.endswith(('.onnx', '.onnx.data', '.json')):
        return JSONResponse(
            {"success": False, "error": "Invalid file type"},
            status_code=400,
        )

    # Security: prevent path traversal
    if '..' in filename or '/' in filename:
        return JSONResponse(
            {"success": False, "error": "Invalid filename"},
            status_code=400,
        )

    model_path = WAKEWORD_DIR / "oww" / filename

    if not model_path.exists():
        return JSONResponse(
            {"success": False, "error": "Model not found"},
            status_code=404,
        )

    return FileResponse(
        path=str(model_path),
        filename=filename,
        media_type="application/octet-stream",
    )


@router.post("/wakeword/detect")
async def detect_wakeword(request: dict):
    """Detect wakeword in audio samples.

    Args:
        keyword: The wakeword keyword to detect
        audio: Audio samples (16kHz float32 array)

    Returns:
        Detection result with confidence
    """
    import numpy as np

    keyword = request.get("keyword", "")
    audio_data = request.get("audio", [])

    if not keyword or not audio_data:
        return JSONResponse({
            "detected": False,
            "confidence": 0,
            "error": "Missing keyword or audio",
        })

    try:
        # 转换音频数据
        audio = np.array(audio_data, dtype=np.float32)

        # 检查模型是否存在
        safe_name = keyword.replace(" ", "_")
        model_path = WAKEWORD_DIR / "oww" / f"{safe_name}.onnx"

        if not model_path.exists():
            # 模型不存在，使用简单能量检测作为回退
            energy = np.sqrt(np.mean(audio ** 2))
            detected = energy > 0.02
            confidence = min(energy * 5, 1.0)

            logger.bind(component="wakeword_training").debug(
                "Model not found, using energy fallback: energy={:.4f}, detected={}",
                energy,
                detected,
            )

            return JSONResponse({
                "detected": detected,
                "confidence": float(confidence),
                "method": "energy_fallback",
                "modelPath": str(model_path),
            })

        # 使用 ONNX Runtime 运行模型
        import onnxruntime as ort

        # 加载 OWW 基础模型和关键词模型
        mel_path = WAKEWORD_DIR / "oww" / "melspectrogram.onnx"
        emb_path = WAKEWORD_DIR / "oww" / "embedding_model.onnx"

        if not mel_path.exists() or not emb_path.exists():
            logger.bind(component="wakeword_training").warning(
                "OWW base models not found, using energy fallback"
            )
            energy = np.sqrt(np.mean(audio ** 2))
            return JSONResponse({
                "detected": energy > 0.02,
                "confidence": min(energy * 5, 1.0),
                "method": "energy_fallback_no_base",
            })

        mel_session = ort.InferenceSession(str(mel_path))
        emb_session = ort.InferenceSession(str(emb_path))
        kw_session = ort.InferenceSession(str(model_path))

        # 获取输入名称
        mel_input_name = mel_session.get_inputs()[0].name
        emb_input_name = emb_session.get_inputs()[0].name

        # 提取 embedding 序列（与训练时相同的方式）
        chunk_size = 1280  # 80ms
        mel_buffer = []
        embeddings = []

        # 填充音频到足够长度
        min_len = chunk_size * 20
        if len(audio) < min_len:
            audio = np.pad(audio, (0, min_len - len(audio)))

        for i in range(0, len(audio) - chunk_size + 1, chunk_size):
            chunk = audio[i : i + chunk_size].astype(np.float32)

            try:
                # Mel spectrogram
                mel_out = mel_session.run(None, {mel_input_name: chunk.reshape(1, -1)})
                mel_frames = mel_out[0]

                # 处理 mel 输出
                if mel_frames is not None and len(mel_frames) > 0:
                    if len(mel_frames.shape) == 4:
                        n_frames = mel_frames.shape[2]
                        for f in range(n_frames):
                            frame = mel_frames[0, 0, f, :]
                            frame = (frame / 10.0) + 2.0
                            mel_buffer.append(frame)
                    elif len(mel_frames.shape) == 3:
                        n_frames = mel_frames.shape[1]
                        for f in range(n_frames):
                            frame = mel_frames[0, f, :]
                            frame = (frame / 10.0) + 2.0
                            mel_buffer.append(frame)

                # 当 mel buffer 足够时，生成 embedding
                while len(mel_buffer) >= 76:
                    mel_for_emb = np.array(mel_buffer[:76])
                    emb_input = mel_for_emb.reshape(1, 76, 32, 1).astype(np.float32)
                    emb_out = emb_session.run(None, {emb_input_name: emb_input})
                    emb = emb_out[0].flatten()[:96]
                    embeddings.append(emb)
                    mel_buffer = mel_buffer[8:]

            except Exception as e:
                continue

        if len(embeddings) < 16:
            logger.bind(component="wakeword_training").debug(
                "Not enough embeddings: {}",
                len(embeddings),
            )
            return JSONResponse({
                "detected": False,
                "confidence": 0,
                "method": "onnx_model",
                "embeddings": len(embeddings),
            })

        # 构建序列 (16, 96)
        sequences = []
        for i in range(len(embeddings) - 16 + 1):
            seq = np.array(embeddings[i : i + 16], dtype=np.float32)
            sequences.append(seq)

        if not sequences:
            return JSONResponse({
                "detected": False,
                "confidence": 0,
            })

        # 运行关键词模型推理
        input_array = np.array(sequences, dtype=np.float32)
        outputs = kw_session.run(None, {"input": input_array})

        # 获取最大置信度
        predictions = outputs[0].flatten()
        max_confidence = float(np.max(predictions))
        mean_confidence = float(np.mean(predictions))
        detected = max_confidence > 0.5

        logger.bind(component="wakeword_training").info(
            "Detection: keyword='{}', sequences={}, max_conf={:.4f}, mean_conf={:.4f}, detected={}",
            keyword,
            len(sequences),
            max_confidence,
            mean_confidence,
            detected,
        )

        return JSONResponse({
            "detected": detected,
            "confidence": max_confidence,
            "meanConfidence": mean_confidence,
            "method": "onnx_model",
            "sequences": len(sequences),
        })

    except Exception as e:
        logger.bind(component="wakeword_training").error(
            "Detection error: {}",
            str(e),
        )
        return JSONResponse({
            "detected": False,
            "confidence": 0,
            "error": str(e),
        })