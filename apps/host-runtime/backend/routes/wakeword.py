"""
Wake-word model management endpoints.

- GET    /wakeword/models             -- list OWW models
- DELETE /wakeword/models/{filename}  -- delete custom model
- GET    /wakeword/{filename}         -- serve wakeword files
"""

import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from loguru import logger

from backend.paths import PERSONALIZED_DIR, WAKEWORD_DIR

router = APIRouter()

BUILTIN_OWW_MODELS = {
    "hey_jarvis_v0.1.onnx",
    "alexa_v0.1.onnx",
    "hey_mycroft_v0.1.onnx",
    "hey_rhasspy_v0.1.onnx",
    "timer_v0.1.onnx",
    "weather_v0.1.onnx",
}
INFRASTRUCTURE_OWW_MODELS = {
    "melspectrogram.onnx",
    "embedding_model.onnx",
    "silero_vad.onnx",
    "speaker_verification.onnx",
    "whisper_encoder.onnx",
    "whisper_encoder_tiny.onnx",
    "whisper_encoder_base.onnx",
}


def _asset_cache_headers(request: Request) -> dict[str, str]:
    """Versioned URLs can be immutable; non-versioned URLs must revalidate."""
    if request.query_params.get("v"):
        return {"Cache-Control": "public, max-age=31536000, immutable"}
    return {"Cache-Control": "no-cache, max-age=0, must-revalidate"}


@router.get("/wakeword/models")
async def wakeword_models_list():
    """List all OWW wake-word models."""
    oww_dir = WAKEWORD_DIR / "oww"
    models = []

    if not oww_dir.is_dir():
        return JSONResponse({"models": models})

    for f in sorted(oww_dir.iterdir()):
        if not f.suffix == ".onnx":
            continue
        # Skip infrastructure models
        if f.name in INFRASTRUCTURE_OWW_MODELS:
            continue

        is_builtin = f.name in BUILTIN_OWW_MODELS
        entry = {
            "filename": f.name,
            "builtin": is_builtin,
            "size": f.stat().st_size,
            "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(f.stat().st_ctime)),
        }

        # For custom models, try to read metadata JSON
        if not is_builtin:
            meta_path = f.with_suffix(".json")
            if meta_path.exists():
                try:
                    with open(meta_path, "r", encoding="utf-8") as mf:
                        meta = json.load(mf)
                    entry["keyword"] = meta.get("keyword", "")
                    entry["version"] = meta.get("version")
                    entry["method"] = meta.get("method", "oww")  # oww, mel_direct, whisper_transfer
                    if meta.get("created_at"):
                        entry["created"] = meta["created_at"]
                    # Whisper-specific metadata
                    if meta.get("method") == "whisper_transfer":
                        entry["whisper_model"] = meta.get("whisper_model", "tiny")
                        entry["d_model"] = meta.get("d_model", 384)
                except Exception:
                    pass
        else:
            # Derive keyword from built-in filename pattern: name_vX.Y.onnx
            stem = f.stem  # e.g. "hey_jarvis_v0.1"
            # Remove version suffix
            kw = re.sub(r"_v[\d.]+$", "", stem)
            entry["keyword"] = kw.replace("_", " ").title()

        models.append(entry)

    return JSONResponse({"models": models})


@router.delete("/wakeword/models/{filename}")
async def wakeword_model_delete(filename: str):
    """Delete a custom OWW model (built-in models cannot be deleted)."""
    if filename in BUILTIN_OWW_MODELS:
        return JSONResponse({"error": "cannot delete built-in model"}, status_code=403)
    if filename in INFRASTRUCTURE_OWW_MODELS:
        return JSONResponse({"error": "cannot delete infrastructure model"}, status_code=403)

    oww_dir = WAKEWORD_DIR / "oww"
    model_path = oww_dir / filename

    if not model_path.exists() or not model_path.suffix == ".onnx":
        return JSONResponse({"error": "model not found"}, status_code=404)

    # Delete ONNX file
    model_path.unlink()

    # Delete metadata JSON if it exists
    meta_path = model_path.with_suffix(".json")
    if meta_path.exists():
        meta_path.unlink()

    return JSONResponse({"deleted": filename})


@router.get("/wakeword/personalized")
async def list_personalized():
    """List all personalized wakeword models."""
    keywords = {}
    if PERSONALIZED_DIR.is_dir():
        for f in sorted(PERSONALIZED_DIR.iterdir()):
            if f.suffix == ".data" and f.stem.endswith(".onnx"):
                keyword = f.stem.replace(".onnx", "")
                stat = f.stat()
                keywords[keyword] = {
                    "url": f"/wakeword/personalized/{keyword}.onnx.data",
                    "updated_at": stat.st_mtime,
                }
    return JSONResponse({"keywords": keywords})


@router.post("/wakeword/personalized")
async def save_personalized(keyword: str = Form(...), weights: UploadFile = File(...)):
    """Save personalized weights for a keyword."""
    PERSONALIZED_DIR.mkdir(parents=True, exist_ok=True)
    dest = PERSONALIZED_DIR / f"{keyword}.onnx.data"
    content = await weights.read()
    dest.write_bytes(content)
    logger.bind(component="wakeword").info("Saved personalized weights for {}", keyword)
    return JSONResponse({"status": "saved", "keyword": keyword})


@router.get("/wakeword/personalized/{filename}")
async def serve_personalized(filename: str):
    """Serve a personalized weight file."""
    path = PERSONALIZED_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Personalized model not found")
    return FileResponse(path, media_type="application/octet-stream")


@router.delete("/wakeword/personalized/{keyword}")
async def delete_personalized(keyword: str):
    """Delete personalized weights for a keyword, reverting to default."""
    path = PERSONALIZED_DIR / f"{keyword}.onnx.data"
    if path.is_file():
        path.unlink()
        logger.bind(component="wakeword").info("Deleted personalized weights for {}", keyword)
    return JSONResponse({"status": "deleted", "keyword": keyword})


@router.delete("/wakeword/personalized")
async def reset_all_personalized():
    """Delete all personalized weights."""
    if PERSONALIZED_DIR.is_dir():
        for f in PERSONALIZED_DIR.iterdir():
            if f.suffix == ".data":
                f.unlink()
        logger.bind(component="wakeword").info("Reset all personalized weights")
    return JSONResponse({"status": "reset"})


@router.get("/wakeword/sherpa-kws/{filename}")
async def sherpa_kws_file(filename: str, request: Request):
    """Serve sherpa-onnx KWS model files from wakeword/sherpa-kws/."""
    safe_name = Path(filename).name  # strip path traversal
    file_path = WAKEWORD_DIR / "sherpa-kws" / safe_name
    if not file_path.exists() or not file_path.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(file_path, headers=_asset_cache_headers(request))


@router.get("/wakeword/{filename}")
async def wakeword_file(filename: str, request: Request):
    """Serve wake word model files (including oww/ subdirectory)."""
    search_dirs = [WAKEWORD_DIR]
    oww_dir = WAKEWORD_DIR / "oww"
    if oww_dir.is_dir():
        search_dirs.append(oww_dir)

    # Exact name match first, then stem match (skip .data files to avoid
    # stem collision: "foo.onnx.data".stem == "foo.onnx")
    for d in search_dirs:
        for f in d.iterdir():
            if f.name == filename:
                return FileResponse(f, headers=_asset_cache_headers(request))
    for d in search_dirs:
        for f in d.iterdir():
            if f.suffix != ".data" and f.stem == filename:
                return FileResponse(f, headers=_asset_cache_headers(request))
    return JSONResponse({"error": "not found"}, status_code=404)
