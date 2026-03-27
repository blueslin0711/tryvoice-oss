"""HTTP client for communicating with the Control Plane service.

Handles host registration and periodic heartbeats.
"""

from __future__ import annotations

import asyncio
from typing import Optional

import httpx
from loguru import logger

from backend.control_plane_client.config import (
    CONTROL_PLANE_HEARTBEAT_INTERVAL,
    CONTROL_PLANE_HOST_NAME,
    CONTROL_PLANE_HOST_PUBLIC_URL,
    CONTROL_PLANE_HOST_TOKEN,
    CONTROL_PLANE_URL,
    is_cp_enabled,
)

# Module-level state
_host_id: Optional[str] = None
_heartbeat_task: Optional[asyncio.Task] = None
_heartbeat_stop: Optional[asyncio.Event] = None


def _auth_headers() -> dict:
    return {"Authorization": f"Bearer {CONTROL_PLANE_HOST_TOKEN}"}


async def register_host(capabilities: Optional[dict] = None) -> Optional[str]:
    """Register this Host Runtime with the Control Plane.

    Returns the assigned host_id, or None on failure.
    """
    global _host_id

    if not is_cp_enabled():
        return None

    url = f"{CONTROL_PLANE_URL}/hosts/register"
    payload = {"name": CONTROL_PLANE_HOST_NAME}
    if CONTROL_PLANE_HOST_PUBLIC_URL:
        payload["public_url"] = CONTROL_PLANE_HOST_PUBLIC_URL
    if capabilities:
        payload["capabilities"] = capabilities

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json=payload, headers=_auth_headers())
            resp.raise_for_status()
            data = resp.json()
            _host_id = data["host_id"]
            logger.info(f"Registered with Control Plane: host_id={_host_id}")
            return _host_id
    except Exception as e:
        logger.warning(f"Failed to register with Control Plane: {e}")
        return None


async def _heartbeat_loop(stop_evt: asyncio.Event) -> None:
    """Send periodic heartbeats to the Control Plane."""
    while not stop_evt.is_set():
        try:
            await asyncio.sleep(CONTROL_PLANE_HEARTBEAT_INTERVAL)
            if _host_id:
                async with httpx.AsyncClient(timeout=10) as client:
                    resp = await client.post(
                        f"{CONTROL_PLANE_URL}/hosts/heartbeat",
                        json={"host_id": _host_id},
                        headers=_auth_headers(),
                    )
                    if resp.status_code != 200:
                        logger.warning(f"CP heartbeat failed: {resp.status_code} {resp.text}")
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"CP heartbeat error: {e}")


async def start_heartbeat() -> None:
    """Start the background heartbeat task."""
    global _heartbeat_task, _heartbeat_stop

    if not is_cp_enabled() or not _host_id:
        return

    _heartbeat_stop = asyncio.Event()
    _heartbeat_task = asyncio.create_task(_heartbeat_loop(_heartbeat_stop))
    logger.info(f"CP heartbeat started (every {CONTROL_PLANE_HEARTBEAT_INTERVAL}s)")


async def stop_heartbeat() -> None:
    """Stop the background heartbeat task."""
    global _heartbeat_task, _heartbeat_stop

    if _heartbeat_stop:
        _heartbeat_stop.set()
    if _heartbeat_task:
        _heartbeat_task.cancel()
        try:
            await _heartbeat_task
        except asyncio.CancelledError:
            pass
    _heartbeat_task = None
    _heartbeat_stop = None


def get_host_id() -> Optional[str]:
    """Return the registered host_id, or None if not registered."""
    return _host_id
