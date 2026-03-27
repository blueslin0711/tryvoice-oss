"""
Chat history HTTP endpoint.

- GET /history/{bot_id} -- fetch chat history from canonical store
- GET /history/search   -- full-text search over canonical history
- GET /history/export   -- full export from canonical history (JSON file)
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response
from loguru import logger

from backend.config import HISTORY_SYNC_FETCH_LIMIT
from backend.history.canonicalize import _history_tail_preview
from backend.history.sync import sync_bot_history
from backend.runtime.slot_registry import (
    get_legacy_bot_id,
    legacy_bot_map,
    resolve_slot_id,
    slot_ids,
)

router = APIRouter()

MAX_GATEWAY_HISTORY_LIMIT = 1000
MAX_SEARCH_LIMIT = 200

# Injected at startup via init()
_history_store = None


def init(store):
    global _history_store
    _history_store = store


def _resolve_target_bots(*, bot_id: Optional[str], slot_id: Optional[str]) -> list[str]:
    target = str(slot_id or bot_id or "").strip()
    if target:
        resolved = resolve_slot_id(target)
        if not resolved:
            raise ValueError("unknown slot")
        return [resolved]
    return list(slot_ids())


@router.get("/history/by-adapter")
async def history_by_adapter():
    """Return all bots grouped by adapter TYPE, with ephemeral classification.

    Multiple adapter_config_ids of the same type are merged into one group.
    Bots with unknown/empty adapter_config_id default to ephemeral.
    """
    rows = _history_store.history_by_adapter()
    active_slot_ids = set(slot_ids())

    # Build adapter_config_id -> adapter_type mapping + per-type metadata
    config_to_type: dict[str, str] = {}  # config_id -> adapter_type
    type_meta: dict[str, dict] = {}  # adapter_type -> {name, ephemeral}
    try:
        from backend.adapter.registry import get_adapter
        from backend.app import get_config_store

        config_store = get_config_store()
        for cfg in config_store.list_adapter_configs():
            cfg_id = cfg["id"]
            adapter_type = cfg["adapter_type"]
            config_to_type[cfg_id] = adapter_type
            if adapter_type not in type_meta:
                display_name = cfg.get("display_name") or adapter_type or cfg_id
                ephemeral = True  # default for unknown adapters
                try:
                    adapter = get_adapter(adapter_type)
                    ephemeral = adapter.report_capabilities().ephemeral_sessions
                except (KeyError, Exception):
                    pass
                type_meta[adapter_type] = {
                    "name": display_name,
                    "ephemeral": ephemeral,
                }
    except Exception:
        pass

    # Collect summaries for archived bots
    all_bot_ids = [r["bot_id"] for r in rows if r["bot_id"] not in active_slot_ids]
    summaries: dict[str, str] = {}
    try:
        from backend.app import get_config_store

        summaries = get_config_store().get_bot_summaries(all_bot_ids)
    except Exception:
        pass

    # Identify native (non-ephemeral) bots from BOT_CONFIG — these belong to
    # the openclaw adapter regardless of what adapter_config_id is stored.
    from backend.config import BOT_CONFIG

    native_bot_ids: set[str] = set(BOT_CONFIG.keys()) if BOT_CONFIG else set()
    native_adapter_type = ""
    for atype, meta in type_meta.items():
        if not meta["ephemeral"]:
            native_adapter_type = atype
            break
    # If BOT_CONFIG exists but no non-ephemeral adapter is registered yet,
    # synthesize an "openclaw" entry so native bots have somewhere to go.
    if native_bot_ids and not native_adapter_type:
        native_adapter_type = "openclaw"
        type_meta["openclaw"] = {"name": "OpenClaw", "ephemeral": False}

    # Group by adapter TYPE (not config ID) — merges multiple configs of same type
    adapters: dict[str, dict] = {}
    for row in rows:
        config_id = row["adapter_config_id"] or ""
        bot_id = row["bot_id"]
        is_active = bot_id in active_slot_ids

        # Resolve adapter_type: native bots override to their true adapter
        if bot_id in native_bot_ids and native_adapter_type:
            adapter_type = native_adapter_type
        else:
            adapter_type = config_to_type.get(config_id, "") or "unknown"
        meta = type_meta.get(adapter_type, {"name": adapter_type, "ephemeral": True})

        if adapter_type not in adapters:
            adapters[adapter_type] = {
                "adapterId": adapter_type,
                "adapterName": meta["name"],
                "ephemeralSessions": meta["ephemeral"],
                "bots": [],
                "archivedBots": [],
            }

        if is_active:
            adapters[adapter_type]["bots"].append(
                {
                    "botId": bot_id,
                    "messageCount": row["msg_count"],
                    "lastActivity": row["last_activity"],
                    "isActive": True,
                }
            )
        elif meta["ephemeral"]:
            adapters[adapter_type]["archivedBots"].append(
                {
                    "botId": bot_id,
                    "messageCount": row["msg_count"],
                    "lastActivity": row["last_activity"],
                    "summary": summaries.get(bot_id, ""),
                }
            )
        else:
            # Non-ephemeral archived bots stay in bots[]
            adapters[adapter_type]["bots"].append(
                {
                    "botId": bot_id,
                    "messageCount": row["msg_count"],
                    "lastActivity": row["last_activity"],
                    "isActive": False,
                }
            )

    # Number archived bots by lastActivity descending; strip archivedBots for non-ephemeral
    for adapter in adapters.values():
        if adapter["ephemeralSessions"]:
            archived = adapter["archivedBots"]
            archived.sort(key=lambda b: b["lastActivity"], reverse=True)
            for i, bot in enumerate(archived, 1):
                bot["index"] = i
        else:
            del adapter["archivedBots"]

    return JSONResponse({"adapters": list(adapters.values())})


@router.get("/history/search")
async def history_search_endpoint(
    q: str = Query(..., min_length=1, max_length=200),
    botId: Optional[str] = Query(default=None),
    slotId: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=MAX_SEARCH_LIMIT),
):
    try:
        target_bots = _resolve_target_bots(bot_id=botId, slot_id=slotId)
    except ValueError:
        return JSONResponse({"error": "unknown slot"}, status_code=400)

    for bid in target_bots:
        await sync_bot_history(bid, wait_if_locked=True)

    requested_target = str(slotId or botId or "").strip()
    target_slot = target_bots[0] if requested_target and target_bots else None
    target_legacy = get_legacy_bot_id(target_slot) if target_slot else ""
    results = _history_store.search_history(
        q,
        limit=max(1, min(int(limit), MAX_SEARCH_LIMIT)),
        bot_id=(target_slot or None),
    )
    return JSONResponse(
        {
            "query": q,
            "botId": target_legacy,
            "slotId": target_slot or "",
            "legacyBotMap": legacy_bot_map(),
            "readModel": _history_store.get_read_model(),
            "count": len(results),
            "results": results,
            "source": "canonical-db",
        }
    )


@router.get("/history/export")
async def history_export_endpoint(
    botId: Optional[str] = Query(default=None),
    slotId: Optional[str] = Query(default=None),
):
    try:
        target_bots = _resolve_target_bots(bot_id=botId, slot_id=slotId)
    except ValueError:
        return JSONResponse({"error": "unknown slot"}, status_code=400)

    for bid in target_bots:
        await sync_bot_history(bid, wait_if_locked=True)

    target_slot = target_bots[0] if len(target_bots) == 1 else None
    target_legacy = get_legacy_bot_id(target_slot) if target_slot else ""
    payload = _history_store.export_history(target_slot or None)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    suffix = f"-{(target_slot or target_legacy)}" if target_slot else "-all"
    filename = f"tryvoice-history{suffix}-{ts}.json"
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    return Response(
        content=body,
        media_type="application/json; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/history/read-model")
async def history_read_model():
    return JSONResponse(
        {
            "active": _history_store.get_read_model(),
            "dualWriteEnabled": bool(_history_store.get_dual_write_enabled()),
        }
    )


@router.put("/history/read-model")
async def history_set_read_model(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    target = str((body or {}).get("active", "")).strip().lower()
    if target not in {"v1", "v2"}:
        return JSONResponse({"ok": False, "error": "active must be v1 or v2"}, status_code=400)
    try:
        active = _history_store.set_read_model(target)
        return JSONResponse(
            {
                "ok": True,
                "active": active,
                "dualWriteEnabled": bool(_history_store.get_dual_write_enabled()),
            }
        )
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/history/consistency")
async def history_consistency(
    botId: Optional[str] = Query(default=None),
    slotId: Optional[str] = Query(default=None),
):
    try:
        target_bots = _resolve_target_bots(bot_id=botId, slot_id=slotId)
    except ValueError:
        return JSONResponse({"error": "unknown slot"}, status_code=400)
    target = target_bots[0] if len(target_bots) == 1 else None
    return JSONResponse(_history_store.compare_event_tables(target))


@router.get("/history/{bot_id}")
async def history_endpoint(
    request: Request,
    bot_id: str,
    limit: int = HISTORY_SYNC_FETCH_LIMIT,
    sinceRevision: Optional[int] = Query(default=None),
    afterSeq: Optional[int] = Query(default=None),
    beforeSeq: Optional[int] = Query(default=None),
    aroundSeq: Optional[int] = Query(default=None),
):
    """Fetch chat history from canonical store.

    Pagination modes (mutually exclusive, priority order):
      - afterSeq=N  — incremental sync: messages with server_seq > N
      - aroundSeq=N — centered window: ~half before and ~half after N
      - beforeSeq=N — reverse pagination: messages with server_seq < N (newest first)
      - (none)      — latest `limit` messages (equivalent to beforeSeq=MAX)
    """
    resolved_slot_id = resolve_slot_id(bot_id)
    if not resolved_slot_id:
        return JSONResponse({"error": "unknown slot"}, status_code=400)
    _client_log = logger.bind(
        client_id=request.headers.get("x-client-id", ""),
        device_type=request.headers.get("x-device-type", "unknown"),
    )
    await sync_bot_history(resolved_slot_id, wait_if_locked=True)
    lim = max(1, min(int(limit), HISTORY_SYNC_FETCH_LIMIT, MAX_GATEWAY_HISTORY_LIMIT))
    compat_bot_id = get_legacy_bot_id(resolved_slot_id)

    # Incremental sync (unchanged)
    if afterSeq is not None:
        history, meta = _history_store.list_history_incremental(resolved_slot_id, after_seq=int(afterSeq), limit=lim)
        _client_log.info(
            f"[history:{resolved_slot_id}] afterSeq={afterSeq} "
            f"returnCount={len(history)} maxServerSeq={meta.get('maxServerSeq', 0)} "
            f"tail={_history_tail_preview(history, limit=3)}"
        )
        return JSONResponse(
            {
                "botId": compat_bot_id,
                "slotId": resolved_slot_id,
                "messages": history,
                "incremental": True,
                "afterSeq": int(afterSeq),
                "source": "canonical-db",
                "sync": meta,
            }
        )

    # Around-seq (search jump)
    if aroundSeq is not None:
        history, meta = _history_store.list_history_around(resolved_slot_id, around_seq=int(aroundSeq), limit=lim)
        _client_log.info(
            f"[history:{resolved_slot_id}] aroundSeq={aroundSeq} "
            f"returnCount={len(history)} "
            f"range=[{meta.get('minServerSeq', '?')}-{meta.get('maxServerSeq', '?')}]"
        )
        return JSONResponse(
            {
                "botId": compat_bot_id,
                "slotId": resolved_slot_id,
                "messages": history,
                "hasMore": meta.get("hasMore", False),
                "minServerSeq": meta.get("minServerSeq"),
                "maxServerSeq": meta.get("maxServerSeq"),
                "source": "canonical-db",
                "sync": meta,
            }
        )

    # Before-seq (reverse pagination) or latest (no cursor)
    if beforeSeq is not None:
        history, meta = _history_store.list_history_before(resolved_slot_id, before_seq=int(beforeSeq), limit=lim)
    else:
        # Default: latest N messages (same as beforeSeq=MAX)
        history, meta = _history_store.list_history_before(resolved_slot_id, before_seq=(2**63 - 1), limit=lim)

    # For backwards compatibility with sinceRevision mode
    if sinceRevision is not None and beforeSeq is None:
        current_revision = int(meta.get("historyRevision", 0))
        not_modified = int(sinceRevision) == current_revision
        if not_modified:
            return JSONResponse(
                {
                    "botId": compat_bot_id,
                    "slotId": resolved_slot_id,
                    "messages": [],
                    "notModified": True,
                    "source": "canonical-db",
                    "sync": meta,
                }
            )

    _client_log.info(
        f"[history:{resolved_slot_id}] beforeSeq={beforeSeq} "
        f"returnCount={len(history)} "
        f"range=[{meta.get('minServerSeq', '?')}-{meta.get('maxServerSeq', '?')}] "
        f"hasMore={meta.get('hasMore', False)}"
    )
    return JSONResponse(
        {
            "botId": compat_bot_id,
            "slotId": resolved_slot_id,
            "messages": history,
            "hasMore": meta.get("hasMore", False),
            "minServerSeq": meta.get("minServerSeq"),
            "maxServerSeq": meta.get("maxServerSeq"),
            "notModified": False,
            "source": "canonical-db",
            "sync": meta,
        }
    )


@router.post("/history/generate-summaries")
async def trigger_summary_generation():
    """Trigger background summary generation for archived bots. Fire-and-forget."""
    import asyncio

    from backend.history.summarize import generate_summaries_background

    asyncio.create_task(generate_summaries_background())
    return JSONResponse({"ok": True}, status_code=202)
