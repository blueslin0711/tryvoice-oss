"""Claude Code session management REST API.

Endpoints for managing Claude Code instances (both tmux-based via Claw Manager
and standalone via session files).

- GET  /api/claude/instances              -- list all tmux sessions + status
- GET  /api/claude/instances/{id}/snapshot -- terminal snapshot for an instance
- POST /api/claude/instances/{id}/send     -- send message directly to tmux
- GET  /api/claude/sessions               -- list discovered session files
- PUT  /api/slots/{slot_id}/instance       -- assign tmux instance to bot slot
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from loguru import logger

router = APIRouter(prefix="/api/claude", tags=["claude-sessions"])


def _get_claw_adapter():
    """Try to get the ClawManagerAdapter from the registry."""
    try:
        from backend.adapter.registry import get_adapter

        adapter = get_adapter("claw-manager")
        return adapter
    except (KeyError, ImportError):
        return None


def _get_anthropic_adapter():
    """Try to get the AnthropicAdapter from the registry."""
    try:
        from backend.adapter.registry import get_adapter

        adapter = get_adapter("anthropic")
        return adapter
    except (KeyError, ImportError):
        return None


@router.get("/instances")
async def list_instances():
    """List all Claude Code tmux sessions with their status."""
    adapter = _get_claw_adapter()
    if adapter is None:
        # Fallback: try direct tmux query
        try:
            from tryvoice_adapter_claw.tmux_bridge import TmuxBridge

            bridge = TmuxBridge()
            sessions = await bridge.list_sessions()
            return {"instances": sessions, "source": "tmux-direct"}
        except ImportError:
            return JSONResponse(
                status_code=404,
                content={"error": "Claw Manager adapter not available"},
            )

    sessions = await adapter._bridge.list_sessions()
    return {
        "instances": sessions,
        "slot_map": adapter._slot_map,
        "source": "claw-adapter",
    }


@router.get("/instances/{instance_id}/snapshot")
async def get_instance_snapshot(instance_id: int, lines: int = 50):
    """Capture current terminal content for a Claude Code instance."""
    adapter = _get_claw_adapter()
    if adapter is not None:
        bridge = adapter._bridge
    else:
        try:
            from tryvoice_adapter_claw.tmux_bridge import TmuxBridge

            bridge = TmuxBridge()
        except ImportError:
            return JSONResponse(
                status_code=404,
                content={"error": "Claw Manager adapter not available"},
            )

    alive = await bridge.is_alive(instance_id)
    if not alive:
        return JSONResponse(
            status_code=404,
            content={"error": f"Instance {instance_id} not found or not alive"},
        )

    snapshot = await bridge.capture_snapshot(instance_id, lines=lines)
    return {
        "instance_id": instance_id,
        "lines": lines,
        "content": snapshot,
    }


@router.post("/instances/{instance_id}/send")
async def send_to_instance(instance_id: int, body: dict):
    """Send a message directly to a Claude Code tmux session.

    Body: {"text": "your message here"}
    """
    text = body.get("text", "").strip()
    if not text:
        return JSONResponse(
            status_code=400,
            content={"error": "text is required"},
        )

    adapter = _get_claw_adapter()
    if adapter is not None:
        bridge = adapter._bridge
    else:
        try:
            from tryvoice_adapter_claw.tmux_bridge import TmuxBridge

            bridge = TmuxBridge()
        except ImportError:
            return JSONResponse(
                status_code=404,
                content={"error": "Claw Manager adapter not available"},
            )

    alive = await bridge.is_alive(instance_id)
    if not alive:
        return JSONResponse(
            status_code=404,
            content={"error": f"Instance {instance_id} not found or not alive"},
        )

    await bridge.send_input(instance_id, text)
    return {"status": "sent", "instance_id": instance_id}


@router.get("/sessions")
async def list_sessions():
    """List discovered Claude Code session files (JSONL)."""
    adapter = _get_anthropic_adapter()
    if adapter is not None and hasattr(adapter, "discover_sessions"):
        sessions = adapter.discover_sessions(adapter._project_dir)
        return {"sessions": sessions}

    # Fallback: manual scan
    try:
        from backend.adapter.anthropic.adapter import AnthropicAdapter

        sessions = AnthropicAdapter.discover_sessions()
        return {"sessions": sessions}
    except ImportError:
        return JSONResponse(
            status_code=404,
            content={"error": "Anthropic adapter not available for session discovery"},
        )


# Slot assignment endpoint uses a different prefix
_slot_router = APIRouter(prefix="/api/slots", tags=["claude-sessions"])


@_slot_router.put("/{slot_id}/instance")
async def assign_instance_to_slot(slot_id: str, body: dict):
    """Assign a tmux instance to a bot slot.

    Body: {"instance_id": 1}
    """
    instance_id = body.get("instance_id")
    if instance_id is None:
        return JSONResponse(
            status_code=400,
            content={"error": "instance_id is required"},
        )

    adapter = _get_claw_adapter()
    if adapter is None:
        return JSONResponse(
            status_code=404,
            content={"error": "Claw Manager adapter not available"},
        )

    adapter._slot_map[slot_id] = int(instance_id)
    logger.info(f"Assigned instance {instance_id} to slot {slot_id}")
    return {
        "status": "assigned",
        "slot_id": slot_id,
        "instance_id": instance_id,
        "slot_map": adapter._slot_map,
    }
