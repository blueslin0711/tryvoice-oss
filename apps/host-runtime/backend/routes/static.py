"""
Static file serving endpoints.

- GET /                    -- index page
- GET /static/{filename}   -- static JS/CSS
- GET /avatars/{filename}  -- avatar images
"""

import os

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from backend.paths import AVATARS_DIR, INDEX_PATH, STATIC_DIR, WAKEWORD_DIR

router = APIRouter()

NO_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}


def _asset_cache_headers(request: Request) -> dict[str, str]:
    """Versioned URLs can be immutable; non-versioned URLs must revalidate."""
    if request.query_params.get("v"):
        return {"Cache-Control": "public, max-age=31536000, immutable"}
    return {"Cache-Control": "no-cache, max-age=0, must-revalidate"}


def _compute_asset_version() -> str:
    override = os.getenv("FRONTEND_ASSET_VERSION", "").strip()
    if override:
        return override

    tracked_files = (
        INDEX_PATH,
        STATIC_DIR / "app.js",
        STATIC_DIR / "chat-store.js",
        STATIC_DIR / "audio-player.js",
        STATIC_DIR / "sync-manager.js",
        STATIC_DIR / "ws-handler.js",
        STATIC_DIR / "client-outbox.js",
        STATIC_DIR / "styles.css",
        STATIC_DIR / "porcupine-web.js",
        STATIC_DIR / "web-voice-processor.js",
        WAKEWORD_DIR / "porcupine_params_zh.pv",
        WAKEWORD_DIR / "porcupine_params.pv",
        WAKEWORD_DIR / "嗨川川_zh_wasm_v4_0_0.ppn",
        WAKEWORD_DIR / "嗨川川_zh_wasm_v4_0_0_mobile.ppn",
        WAKEWORD_DIR / "jarvis_wasm.ppn",
        WAKEWORD_DIR / "alexa_wasm.ppn",
        WAKEWORD_DIR / "computer_wasm.ppn",
        WAKEWORD_DIR / "terminator_wasm.ppn",
        WAKEWORD_DIR / "blueberry_wasm.ppn",
        WAKEWORD_DIR / "bumblebee_wasm.ppn",
        WAKEWORD_DIR / "grapefruit_wasm.ppn",
        WAKEWORD_DIR / "americano_wasm.ppn",
        WAKEWORD_DIR / "grasshopper_wasm.ppn",
        WAKEWORD_DIR / "picovoice_wasm.ppn",
        WAKEWORD_DIR / "porcupine_wasm.ppn",
    )
    latest_mtime = 1
    for fp in tracked_files:
        if fp.exists():
            latest_mtime = max(latest_mtime, int(fp.stat().st_mtime))
    return str(latest_mtime)


@router.get("/")
async def index():
    html = INDEX_PATH.read_text(encoding="utf-8")
    html = html.replace("__ASSET_VERSION__", _compute_asset_version())
    return HTMLResponse(content=html, headers=NO_CACHE_HEADERS)


@router.get("/static/{filename}")
async def static_file(filename: str, request: Request):
    """Serve static JS/CSS files."""
    fp = STATIC_DIR / filename
    if fp.exists() and fp.is_file():
        mime_types = {
            ".js": "application/javascript",
            ".css": "text/css",
            ".map": "application/json",
            ".wasm": "application/wasm",
            ".html": "text/html",
        }
        ct = mime_types.get(fp.suffix, "application/octet-stream")
        return FileResponse(fp, media_type=ct, headers=_asset_cache_headers(request))
    return JSONResponse({"error": "not found"}, status_code=404)


@router.get("/avatars/{filename}")
async def avatar_file(filename: str):
    """Serve bot avatar images."""
    fp = AVATARS_DIR / filename
    if fp.exists() and fp.is_file():
        return FileResponse(fp)
    return JSONResponse({"error": "not found"}, status_code=404)
