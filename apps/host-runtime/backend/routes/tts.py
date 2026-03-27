"""
TTS-related HTTP endpoints.

- POST /tts          -- on-demand TTS
- GET  /voices       -- Edge TTS voice list (cached)
- GET  /preview_voice -- voice preview audio
- GET  /speech-token -- Azure Speech token
- GET  /speech-config -- TTS config flags
"""

import base64
import time as _time

import aiohttp
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response
from loguru import logger

from backend.config import EDGE_VOICE
from backend.voice.tts_registry import get_tts_provider
from backend.voice.tts_utils import clean_for_tts

router = APIRouter()

# ---- Edge TTS voice list cache ----
_edge_voices_cache: dict = {"data": None, "ts": 0}


@router.get("/voices")
async def voices_endpoint():
    now = _time.time()
    if _edge_voices_cache["data"] and now - _edge_voices_cache["ts"] < 3600:
        return JSONResponse(_edge_voices_cache["data"])
    import edge_tts

    all_voices = await edge_tts.list_voices()
    # Return Chinese + English voices for selection
    filtered = [v for v in all_voices if v["Locale"].startswith("zh") or v["Locale"].startswith("en")]
    result = [
        {
            "id": v["ShortName"],
            "name": v["ShortName"].split("-")[-1].replace("Neural", ""),
            "locale": v["Locale"],
            "gender": v["Gender"],
        }
        for v in filtered
    ]
    _edge_voices_cache["data"] = {"voices": result, "current": EDGE_VOICE}
    _edge_voices_cache["ts"] = now
    return JSONResponse(_edge_voices_cache["data"])


@router.get("/preview_voice")
async def preview_voice(voice_id: str = Query(...)):
    try:
        audio = await get_tts_provider().synthesize("你好，这是语音预览。Hello, voice preview.", voice=voice_id)
        if audio:
            return Response(content=audio, media_type="audio/mpeg")
    except Exception as e:
        logger.error(f"Preview voice error: {e}")
    return Response(content=b"", status_code=500)


@router.post("/tts")
async def tts_endpoint(request: Request):
    """On-demand TTS for play button clicks."""
    data = await request.json()
    text = data.get("text", "").strip()
    _bot_id = data.get("botId", "main")
    if not text:
        return JSONResponse({"error": "no text"}, status_code=400)
    cleaned = clean_for_tts(text)
    if not cleaned:
        return JSONResponse({"audio": None})
    # Voice/rate must be provided by the client (no global shared state)
    voice = data.get("voice") or None
    rate = data.get("rate") or "1.0"
    try:
        audio = await get_tts_provider().synthesize(cleaned, voice=voice, rate=rate)
        if audio:
            return JSONResponse({"audio": base64.b64encode(audio).decode()})
        return JSONResponse({"audio": None})
    except Exception as e:
        logger.error(f"TTS endpoint error: {e}")
        return JSONResponse({"audio": None})


@router.get("/speech-token")
async def speech_token_endpoint():
    """Return Azure Speech token for browser-direct TTS.
    The browser uses this short-lived token (10 min) to connect directly
    to Azure Speech without exposing the subscription key."""
    import backend.config.voice as voice_cfg

    key = voice_cfg.AZURE_SPEECH_KEY
    region = voice_cfg.AZURE_SPEECH_REGION
    if not key:
        return JSONResponse({"error": "Azure Speech not configured"}, status_code=404)
    token_url = f"https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken"
    try:
        async with aiohttp.ClientSession() as http:
            async with http.post(
                token_url,
                headers={"Ocp-Apim-Subscription-Key": key},
            ) as resp:
                if resp.status == 200:
                    token = await resp.text()
                    return JSONResponse(
                        {
                            "token": token,
                            "region": region,
                        }
                    )
                else:
                    err = await resp.text()
                    logger.error(f"Azure token error {resp.status}: {err}")
                    return JSONResponse({"error": "token fetch failed"}, status_code=502)
    except Exception as e:
        logger.error(f"Azure token endpoint error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/speech-config")
async def speech_config_endpoint():
    """Return TTS configuration so the browser knows which mode to use."""
    import backend.config.voice as voice_cfg

    key = voice_cfg.AZURE_SPEECH_KEY
    region = voice_cfg.AZURE_SPEECH_REGION
    key_masked = ""
    if key and len(key) > 8:
        key_masked = key[:4] + "****" + key[-4:]
    elif key:
        key_masked = "****"
    return JSONResponse(
        {
            "azureEnabled": bool(key),
            "defaultVoice": EDGE_VOICE,
            "region": region if key else None,
            "keyMasked": key_masked,
            "regionValue": region,
        }
    )
