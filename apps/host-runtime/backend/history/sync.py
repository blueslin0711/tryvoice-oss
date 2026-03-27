"""History synchronisation — periodic fetch via adapter, canonical
conversion, and push notifications to connected WebSocket clients."""

from __future__ import annotations

import asyncio

from loguru import logger

from backend.config import (
    HISTORY_SYNC_FETCH_LIMIT,
)
from backend.history.canonicalize import (
    _history_tail_preview,
    _slice_history_after_last_reset,
    _to_canonical_history,
)
from backend.runtime.slot_registry import require_slot

# ---------------------------------------------------------------------------
# Module-level mutable state
# ---------------------------------------------------------------------------

_history_sync_locks: dict[str, asyncio.Lock] = {}
_bot_reset_cutoff_ts_ms: dict[str, int] = {}
MAX_GATEWAY_HISTORY_LIMIT = 1000

# ---------------------------------------------------------------------------
# Late-bound dependencies (set by app.py during lifespan via init())
# ---------------------------------------------------------------------------

_history_store = None
_broadcast_fn = None
_adapter = None


def init(store, broadcast_fn, adapter=None):
    """Bind runtime dependencies injected by the application lifespan."""
    global _history_store, _broadcast_fn, _adapter
    _history_store = store
    _broadcast_fn = broadcast_fn
    if adapter is not None:
        _adapter = adapter


def set_adapter(adapter):
    """Update the adapter used for history sync (e.g. after hot-swap)."""
    global _adapter
    _adapter = adapter


def set_bot_reset_cutoff_ts_ms(bot_id: str, ts_ms: int):
    """Set per-bot cutoff timestamp (called by WS handler on session reset)."""
    _bot_reset_cutoff_ts_ms[bot_id] = ts_ms


# ---------------------------------------------------------------------------
# Core sync
# ---------------------------------------------------------------------------


async def sync_bot_history(
    bot_id: str,
    http=None,
    wait_if_locked: bool = False,
) -> dict | None:
    # http parameter kept for caller compatibility (ignored; adapter manages its own transport).
    _ = http
    try:
        slot_cfg = require_slot(bot_id)
    except KeyError:
        return None
    session_key = str(slot_cfg.get("sessionKey") or "")
    lock = _history_sync_locks.get(bot_id)
    if lock is None:
        lock = asyncio.Lock()
        _history_sync_locks[bot_id] = lock
    if lock.locked() and not wait_if_locked:
        return None

    adapter = _adapter
    if adapter is None:
        from backend.adapter.registry import get_default_adapter

        adapter = get_default_adapter()

    try:
        async with lock:
            fetch_limit = max(1, min(HISTORY_SYNC_FETCH_LIMIT, MAX_GATEWAY_HISTORY_LIMIT))
            raw_msgs = await adapter.fetch_history(
                session_key=session_key,
                limit=fetch_limit,
            )
            reset_cutoff_ts_ms = _bot_reset_cutoff_ts_ms.get(bot_id)
            window_msgs, reset_meta = _slice_history_after_last_reset(
                raw_msgs,
                reset_cutoff_ts_ms=reset_cutoff_ts_ms,
            )
            # Keep full canonical history across resets. `window_msgs` is now
            # used only as reset propagation diagnostics.
            canonical = _to_canonical_history(raw_msgs)
            # Resolve adapter config ID for history grouping.
            # Only tag events when the adapter actually returned data;
            # otherwise we'd overwrite existing (correct) adapter_config_id
            # with the currently-active adapter's ID on unrelated bots.
            adapter_config_id = ""
            if canonical:
                try:
                    from backend.app import get_config_store

                    active_cfg = get_config_store().get_active_adapter_config()
                    if active_cfg:
                        adapter_config_id = active_cfg.get("id", "")
                except Exception:
                    pass
            meta = _history_store.replace_bot_snapshot(
                bot_id,
                session_key,
                canonical,
                adapter_config_id=adapter_config_id,
            )
            meta["rawRemoteCount"] = len(raw_msgs)
            meta["windowRemoteCount"] = len(window_msgs)
            meta["resetBoundarySeen"] = bool(reset_meta.get("resetBoundarySeen"))
            meta["resetBoundaryKind"] = str(reset_meta.get("resetBoundaryKind") or "")
            meta["resetCutoffTsMs"] = int(reset_meta.get("resetCutoffTsMs") or 0)
            meta["resetCutoffMatched"] = bool(reset_meta.get("resetCutoffMatched"))
            meta["resetBoundaryIndex"] = int(reset_meta.get("resetBoundaryIndex") or -1)
            meta["resetCutoffIndex"] = int(reset_meta.get("resetCutoffIndex") or -1)
            if meta["changed"]:
                logger.info(
                    f"[{bot_id}] history changed: sessionKey={session_key} "
                    f"remoteRaw={len(raw_msgs)} remoteWindow={len(window_msgs)} canonical={meta['count']} "
                    f"(rev={meta['revision']}) "
                    f"reset(boundarySeen={meta['resetBoundarySeen']}, "
                    f"boundaryKind={meta['resetBoundaryKind'] or '-'}, "
                    f"cutoffTs={meta['resetCutoffTsMs'] or 0}, "
                    f"cutoffMatched={meta['resetCutoffMatched']}) "
                    f"tail={_history_tail_preview(raw_msgs, limit=3)}"
                )
            return meta
    except Exception as e:
        _history_store.record_sync_error(bot_id, session_key, str(e))
        logger.error(f"[{bot_id}] history sync error: {e}")
        return None


# ---------------------------------------------------------------------------
# Broadcast helper
# ---------------------------------------------------------------------------


async def _broadcast_history_revision(bot_id: str, meta: dict) -> None:
    """Push history revision notification to all connected WS clients."""
    if _broadcast_fn is None:
        return
    await _broadcast_fn(bot_id, meta)


# ---------------------------------------------------------------------------
# Background loops
# ---------------------------------------------------------------------------


async def _wal_checkpoint_loop(stop_evt: asyncio.Event):
    """Periodically checkpoint WAL to keep it small and reduce corruption risk."""
    while not stop_evt.is_set():
        try:
            await asyncio.sleep(300)  # every 5 minutes
            _history_store._conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            logger.debug("WAL checkpoint (passive) completed")
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"WAL checkpoint error: {e}")
