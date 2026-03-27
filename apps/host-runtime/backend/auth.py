"""Lightweight access protection for single-user deployments."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

from fastapi import Request, WebSocket
from fastapi.responses import JSONResponse, Response

from backend.config import (
    ACCESS_COOKIE_NAME,
    ACCESS_PASSWORD,
    ACCESS_SESSION_SECRET,
    ACCESS_SESSION_TTL_SECONDS,
)

_SESSION_SECRET = (ACCESS_SESSION_SECRET or secrets.token_hex(32)).encode("utf-8")
_PUBLIC_EXACT_PATHS = {
    "/",
    "/health",
    "/auth/status",
    "/auth/login",
    "/auth/logout",
}
_PUBLIC_PREFIXES = (
    "/static/",
    "/avatars/",
    "/wakeword/",
)


def is_auth_enabled() -> bool:
    return bool((ACCESS_PASSWORD or "").strip())


def is_public_http_path(path: str) -> bool:
    p = str(path or "")
    return p in _PUBLIC_EXACT_PATHS or any(p.startswith(prefix) for prefix in _PUBLIC_PREFIXES)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(raw: str) -> bytes | None:
    s = str(raw or "").strip()
    if not s:
        return None
    padding = "=" * ((4 - (len(s) % 4)) % 4)
    try:
        return base64.urlsafe_b64decode((s + padding).encode("ascii"))
    except Exception:
        return None


def _sign(payload_b64: str) -> str:
    sig = hmac.new(_SESSION_SECRET, payload_b64.encode("utf-8"), hashlib.sha256).digest()
    return _b64url_encode(sig)


def issue_auth_token() -> str:
    now = int(time.time())
    payload = {
        "iat": now,
        "exp": now + max(60, int(ACCESS_SESSION_TTL_SECONDS)),
    }
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig_b64 = _sign(payload_b64)
    return f"{payload_b64}.{sig_b64}"


def verify_auth_token(token: str) -> bool:
    token_raw = str(token or "").strip()
    if not token_raw:
        return False
    try:
        payload_b64, sig_b64 = token_raw.split(".", 1)
    except ValueError:
        return False
    expected = _sign(payload_b64)
    if not hmac.compare_digest(sig_b64, expected):
        return False
    payload_raw = _b64url_decode(payload_b64)
    if payload_raw is None:
        return False
    try:
        payload = json.loads(payload_raw.decode("utf-8"))
    except Exception:
        return False
    exp = int(payload.get("exp", 0) or 0)
    now = int(time.time())
    return exp > now


def is_request_authenticated(request: Request) -> bool:
    if not is_auth_enabled():
        return True
    token = request.cookies.get(ACCESS_COOKIE_NAME, "")
    return verify_auth_token(token)


def is_websocket_authenticated(ws: WebSocket) -> bool:
    if not is_auth_enabled():
        return True
    token = ws.cookies.get(ACCESS_COOKIE_NAME, "")
    return verify_auth_token(token)


def unauthorized_json_response() -> JSONResponse:
    return JSONResponse(
        {"error": "unauthorized", "authRequired": True},
        status_code=401,
    )


def set_auth_cookie(response: Response, token: str, *, secure: bool) -> None:
    response.set_cookie(
        key=ACCESS_COOKIE_NAME,
        value=token,
        max_age=max(60, int(ACCESS_SESSION_TTL_SECONDS)),
        httponly=True,
        samesite="lax",
        secure=bool(secure),
        path="/",
    )


def clear_auth_cookie(response: Response, *, secure: bool) -> None:
    response.delete_cookie(
        key=ACCESS_COOKIE_NAME,
        path="/",
        secure=bool(secure),
        samesite="lax",
    )
