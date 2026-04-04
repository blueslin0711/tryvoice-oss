"""
Settings and frontend config endpoints.

- GET  /api/settings  -- read shared settings
- PUT  /api/settings  -- merge-update shared settings
- GET  /config        -- frontend config (Picovoice key, OWW keywords)
"""

import asyncio
import json
import os
import re

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from loguru import logger

from backend.config import EXPOSE_PICOVOICE_KEY
from backend.paths import PERSONALIZED_DIR, SETTINGS_PATH, WAKEWORD_DIR
from backend.routes.wakeword import INFRASTRUCTURE_OWW_MODELS

# Cache auto-detected ONNX input shapes: filename -> "2d" | "3d:N" etc.
_onnx_input_shape_cache: dict[str, str] = {}


def _detect_onnx_input_shape(path) -> str:
    """Auto-detect ONNX model input shape: '2d' for [N, 1536], '3d' for [1, 16, 96], etc."""
    name = str(path.name) if hasattr(path, "name") else str(path)
    if name in _onnx_input_shape_cache:
        return _onnx_input_shape_cache[name]
    shape = "3d"  # default
    try:
        import onnx

        m = onnx.load(str(path))
        dims = [d.dim_value for d in m.graph.input[0].type.tensor_type.shape.dim]
        if len(dims) == 2:
            shape = "2d"
        elif len(dims) == 3 and dims[1] != 16:
            # Non-standard 3d (e.g. timer=34, weather=22 frames)
            shape = f"3d:{dims[1]}"
    except Exception as e:
        logger.debug(f"Could not detect input shape for {name}: {e}")
    _onnx_input_shape_cache[name] = shape
    return shape


router = APIRouter()

NO_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}

_SETTINGS_FILE = SETTINGS_PATH
_settings_lock = asyncio.Lock()


def _load_settings() -> dict:
    """Load shared settings from disk."""
    if _SETTINGS_FILE.exists():
        try:
            return json.loads(_SETTINGS_FILE.read_text("utf-8"))
        except Exception:
            logger.warning(f"Failed to read {_SETTINGS_FILE}, returning empty")
    return {}


def _save_settings(data: dict):
    """Persist shared settings to disk."""
    _SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")


@router.get("/api/settings")
async def get_settings():
    """Return shared settings JSON."""
    return JSONResponse(_load_settings())


@router.put("/api/settings")
async def put_settings(request: Request):
    """Merge incoming JSON into shared settings and persist."""
    body = await request.json()
    async with _settings_lock:
        current = _load_settings()
        current.update(body)
        _save_settings(current)
    logger.info(f"Settings updated: {list(body.keys())}")

    # Debug: log source of sessionMode changes
    if "sessionMode" in body:
        import traceback

        ua = request.headers.get("user-agent", "unknown")[:80]
        referer = request.headers.get("referer", "unknown")
        stack = "".join(traceback.format_stack()[-4:-1])
        logger.warning(f"sessionMode SET to '{body['sessionMode']}' | UA={ua} | referer={referer} | stack={stack}")

    # Apply session_mode change to the live adapter
    if "sessionMode" in body:
        try:
            from backend.adapter.registry import get_adapter

            adapter = get_adapter("claude-code")
            if hasattr(adapter, "apply_config"):
                mode = "observer" if body["sessionMode"] == "observer" else "controller"
                adapter.apply_config({"session_mode": mode})
                logger.info(f"Session mode applied: {mode}")
        except Exception as exc:
            logger.warning(f"Failed to apply session_mode: {exc}")

    return JSONResponse({"ok": True})


@router.get("/config")
async def config_endpoint(request: Request):
    """Return non-secret frontend config, with device-aware Picovoice key."""
    ua = (request.headers.get("user-agent") or "").lower()
    is_mobile = any(k in ua for k in ("iphone", "ipad", "android", "mobile"))
    if is_mobile:
        key = os.getenv("PICOVOICE_ACCESS_KEY_MOBILE", "") or os.getenv("PICOVOICE_ACCESS_KEY", "")
    else:
        key = os.getenv("PICOVOICE_ACCESS_KEY", "")
    ppn = "jarvis_wasm.ppn"
    if not EXPOSE_PICOVOICE_KEY:
        key = ""

    available_wake_words = [
        "Jarvis",
        "Alexa",
        "Computer",
        "Terminator",
        "Blueberry",
        "Bumblebee",
        "Grapefruit",
        "Americano",
        "Grasshopper",
        "Picovoice",
        "Porcupine",
    ]

    # Dynamic OWW keyword scanning — unified pool (all models in one list)
    oww_keywords = []
    oww_keyword_to_model = {}
    oww_model_meta: dict[str, dict] = {}
    # Pipeline debug: group pipeline-variant models separately
    oww_pipelines: list[str] = []
    oww_pipeline_models: dict[str, dict[str, str]] = {}  # pipeline -> {keyword -> model_file}
    oww_pipeline_meta: dict[str, dict[str, dict]] = {}  # pipeline -> {keyword -> meta}
    oww_dir = WAKEWORD_DIR / "oww"
    if oww_dir.is_dir():
        for f in sorted(oww_dir.iterdir()):
            if not f.suffix == ".onnx":
                continue
            if f.name in INFRASTRUCTURE_OWW_MODELS:
                continue
            # Derive keyword from filename or metadata
            meta_path = f.with_suffix(".json")
            meta = {}
            if meta_path.exists():
                try:
                    with open(meta_path, "r", encoding="utf-8") as mf:
                        meta = json.load(mf)
                    kw = meta.get("keyword", "")
                except Exception:
                    kw = ""
            else:
                # Built-in: derive from filename, e.g. hey_jarvis_v0.1.onnx -> Hey Jarvis
                stem = f.stem
                kw = re.sub(r"_v[\d.]+$", "", stem).replace("_", " ").title()

            if not kw:
                continue

            # Pipeline-variant model: group separately
            pipeline = meta.get("pipeline", "")
            if pipeline:
                if pipeline not in oww_pipeline_models:
                    oww_pipelines.append(pipeline)
                    oww_pipeline_models[pipeline] = {}
                    oww_pipeline_meta[pipeline] = {}
                oww_pipeline_models[pipeline][kw] = f.name
                entry_p: dict[str, str] = {}
                input_shape_p = meta.get("inputShape", "") or _detect_onnx_input_shape(f)
                if input_shape_p and input_shape_p != "3d":
                    entry_p["inputShape"] = input_shape_p
                if entry_p:
                    oww_pipeline_meta[pipeline][kw] = entry_p
                continue

            oww_keywords.append(kw)
            oww_keyword_to_model[kw] = f.name
            # Store meta for models with non-default inputShape, role hint, or Whisper models
            entry: dict[str, str | int] = {}
            input_shape = meta.get("inputShape", "") or _detect_onnx_input_shape(f)
            role = meta.get("role", "")
            version = meta.get("version")
            method = meta.get("method", "")
            if input_shape and input_shape != "3d":
                entry["inputShape"] = input_shape
            if role in ("endword", "cancelword"):
                entry["role"] = role
            # Include version and method for Whisper models (version >= 3)
            if version is not None:
                entry["version"] = version
            if method:
                entry["method"] = method
            if entry:
                oww_model_meta[kw] = entry

    oww_threshold_raw = os.getenv("OWW_THRESHOLD", "").strip()
    oww_threshold = 0.3  # default
    if oww_threshold_raw:
        try:
            oww_threshold = max(0.0, min(1.0, float(oww_threshold_raw)))
        except ValueError:
            pass

    # Personalized model availability
    oww_personalized = {}
    if PERSONALIZED_DIR.is_dir():
        for f in sorted(PERSONALIZED_DIR.iterdir()):
            if f.suffix == ".data" and f.stem.endswith(".onnx"):
                keyword = f.stem.replace(".onnx", "")
                oww_personalized[keyword] = f"/wakeword/personalized/{keyword}.onnx.data"

    # sherpa-onnx KWS availability
    sherpa_kws_dir = WAKEWORD_DIR / "sherpa-kws"
    sherpa_kws_available = sherpa_kws_dir.is_dir() and any(sherpa_kws_dir.glob("encoder*.onnx"))

    return JSONResponse(
        {
            "picovoiceAccessKey": key,
            "picovoicePpn": ppn,
            "picovoiceKeyExposed": bool(EXPOSE_PICOVOICE_KEY),
            "availableWakeWords": available_wake_words,
            "owwKeywords": oww_keywords,
            "owwKeywordToModel": oww_keyword_to_model,
            "owwThreshold": oww_threshold,
            "owwModelMeta": oww_model_meta,
            "speakerVerificationAvailable": (WAKEWORD_DIR / "oww" / "speaker_verification.onnx").exists(),
            "owwPersonalized": oww_personalized,
            "owwPipelines": oww_pipelines,
            "owwPipelineModels": oww_pipeline_models,
            "owwPipelineMeta": oww_pipeline_meta,
            "sherpaKwsKeywords": [
                "americano",
                "snowboy",
                "terminator",
                "bumblebee",
                "jarvis",
                "grasshopper",
                "transmit",
                "dispatch",
                "discontinue",
                "suspend",
            ],
            "sherpaKwsAvailable": sherpa_kws_available,
        },
        headers=NO_CACHE_HEADERS,
    )


@router.get("/settings/summary-llm")
async def get_summary_llm():
    from backend.app import get_config_store

    config_store = get_config_store()
    cfg = config_store.get_summary_llm_config()
    if cfg is None:
        return JSONResponse({"configured": False, "api_url": "", "api_key_set": False, "model": ""})
    return JSONResponse(
        {
            "configured": True,
            "api_url": cfg["api_url"],
            "api_key_set": bool(cfg["api_key"]),
            "model": cfg["model"],
        }
    )


@router.put("/settings/summary-llm")
async def set_summary_llm(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "invalid json"}, status_code=400)
    api_url = str(body.get("api_url", "")).strip()
    api_key = str(body.get("api_key", "")).strip()
    model = str(body.get("model", "")).strip()
    from backend.app import get_config_store

    config_store = get_config_store()
    # Preserve existing API key if not provided (avoid accidental wipe)
    if not api_key:
        existing = config_store.get_summary_llm_config()
        if existing:
            api_key = existing["api_key"]
    config_store.set_summary_llm_config(api_url, api_key, model)
    return JSONResponse({"ok": True})
