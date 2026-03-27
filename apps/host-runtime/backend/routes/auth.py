"""Authentication endpoints for optional single-user access protection."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.auth import (
    clear_auth_cookie,
    is_auth_enabled,
    is_request_authenticated,
    issue_auth_token,
    set_auth_cookie,
)
from backend.config import ACCESS_PASSWORD

router = APIRouter()


class LoginPayload(BaseModel):
    password: str = ""


@router.get("/auth/status")
async def auth_status(request: Request):
    enabled = is_auth_enabled()
    authenticated = is_request_authenticated(request)
    return JSONResponse(
        {
            "enabled": enabled,
            "authenticated": bool(authenticated),
        }
    )


@router.post("/auth/login")
async def auth_login(payload: LoginPayload, request: Request):
    if not is_auth_enabled():
        return JSONResponse(
            {
                "ok": True,
                "enabled": False,
                "authenticated": True,
            }
        )
    incoming = (payload.password or "").strip()
    expected = (ACCESS_PASSWORD or "").strip()
    if not incoming or incoming != expected:
        return JSONResponse({"ok": False, "error": "invalid password"}, status_code=401)
    token = issue_auth_token()
    resp = JSONResponse({"ok": True, "enabled": True, "authenticated": True})
    set_auth_cookie(resp, token, secure=(request.url.scheme == "https"))
    return resp


@router.post("/auth/logout")
async def auth_logout(request: Request):
    resp = JSONResponse({"ok": True})
    clear_auth_cookie(resp, secure=(request.url.scheme == "https"))
    return resp
