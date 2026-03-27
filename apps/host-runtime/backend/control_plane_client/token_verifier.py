"""Verify connection tickets issued by the Control Plane.

When a client connects via WebSocket with a ticket_token query parameter,
this module validates it against the Control Plane's /pairing/verify endpoint.
"""

from __future__ import annotations

from typing import Optional

import httpx
from loguru import logger

from backend.control_plane_client.config import CONTROL_PLANE_URL, is_cp_enabled


async def verify_connection_ticket(ticket_token: str) -> Optional[dict]:
    """Verify a connection ticket with the Control Plane.

    Returns {"user_id": str, "host_id": str} on success, or None on failure.
    """
    if not is_cp_enabled():
        return None

    url = f"{CONTROL_PLANE_URL}/pairing/verify"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json={"ticket_token": ticket_token})
            resp.raise_for_status()
            data = resp.json()
            if data.get("valid"):
                logger.info(f"CP ticket verified: user={data.get('user_id')}")
                return {
                    "user_id": data["user_id"],
                    "host_id": data["host_id"],
                }
            else:
                logger.warning("CP ticket verification failed: invalid ticket")
                return None
    except Exception as e:
        logger.warning(f"CP ticket verification error: {e}")
        return None
