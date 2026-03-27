"""
Shared runtime state: bot processing status, WS client registry,
and broadcast helpers.

Extracted from ws/manager.py so that both session/ and ws/ layers can
import without creating a session/ -> ws/ dependency.
"""

import asyncio

from backend.ws.connection_registry import registry

# --- Global bot processing state (server-authoritative) ---
# Maps bot_id -> {"status": str, "since": float (loop time), "trace_id": str}
_bot_processing_state: dict[str, dict] = {}
_bot_processing_refcount: dict[str, int] = {}
_bot_processing_lock = asyncio.Lock()
_BOT_PROCESSING_STALE_SEC = 120.0


async def set_bot_processing(bot_id: str, status: str, trace_id: str = ""):
    """Set or clear processing state for a bot.

    Reference-counted: multiple concurrent turns for the same bot each call
    set(status) on entry and set("") on exit.  The visible state is only
    cleared when the last turn finishes (refcount reaches 0).
    """
    async with _bot_processing_lock:
        if status:
            _bot_processing_refcount[bot_id] = _bot_processing_refcount.get(bot_id, 0) + 1
            _bot_processing_state[bot_id] = {
                "status": status,
                "since": asyncio.get_running_loop().time(),
                "trace_id": trace_id,
            }
        else:
            rc = _bot_processing_refcount.get(bot_id, 0) - 1
            if rc <= 0:
                _bot_processing_refcount.pop(bot_id, None)
                _bot_processing_state.pop(bot_id, None)
            else:
                _bot_processing_refcount[bot_id] = rc


def get_bot_processing_states() -> dict:
    """Return current processing states for all bots (non-async snapshot)."""
    now = asyncio.get_running_loop().time()
    result = {}
    stale_bot_ids: list[str] = []
    for bot_id, state in _bot_processing_state.items():
        elapsed = now - state.get("since", now)
        # Defensive TTL: prevent stale "processing" states surviving reconnects.
        if elapsed >= _BOT_PROCESSING_STALE_SEC:
            stale_bot_ids.append(bot_id)
            continue
        result[bot_id] = {
            "status": state["status"],
            "elapsedSec": round(elapsed, 1),
        }
    for bot_id in stale_bot_ids:
        _bot_processing_state.pop(bot_id, None)
    return result


async def broadcast_history_revision(
    bot_id: str,
    meta: dict,
    *,
    exclude: "asyncio.Queue | None" = None,
) -> None:
    """Push history revision notification to all connected WS clients."""
    from backend.app import get_history_store

    msg = {
        "type": "history_revision",
        "botId": bot_id,
        "revision": int(meta.get("revision", 0)),
        "remoteCount": int(meta.get("count", 0)),
        "maxServerSeq": int(meta.get("maxServerSeq", 0)),
        "changed": True,
        "lastReadSeq": get_history_store().get_last_read_seq(bot_id),
    }
    await registry.broadcast(msg, exclude=exclude, event_label="history_revision")


async def broadcast_bot_event(msg: dict, *, exclude: "asyncio.Queue | None" = None) -> None:
    """Broadcast a chat event (transcript, response, etc.) to all WS clients."""
    await registry.broadcast(msg, exclude=exclude, event_label=msg.get("type", "bot_event"))
