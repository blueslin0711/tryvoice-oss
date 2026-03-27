"""
Miscellaneous endpoints.

- GET  /health                         -- health check
- POST /debug_log                      -- client-side debug log receiver
- GET  /stt-config                     -- STT config for browser-direct Groq
- POST /pv-device/backup               -- Picovoice IndexedDB backup
- GET  /pv-device/backups              -- List saved Picovoice device backups
- POST /pv-device/adopt                -- Copy an existing backup to current device tag
- GET  /pv-device/restore/{device_tag} -- Picovoice IndexedDB restore
- POST /media/upload                   -- upload user image for multimodal prompt
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import JSONResponse
from loguru import logger

from backend.adapter.registry import (
    get_active_adapter_info,
    get_capability_manifest,
    get_default_adapter,
    list_adapters,
    set_active_adapter,
)
from backend.config import (
    EXPOSE_BROWSER_STT_KEY,
    GROQ_WHISPER_MODEL,
    HISTORY_SYNC_INTERVAL_SECONDS,
)
from backend.ops.metrics import snapshot as ops_metrics_snapshot
from backend.paths import USER_DATA_DIR
from backend.runtime.slot_registry import (
    get_default_slot_id,
    get_slot,
    legacy_bot_map,
    list_slots,
    remove_slot,
    reset_default_slots,
    set_slots,
    update_slot,
)

router = APIRouter()

PV_DEVICE_BACKUP_DIR = USER_DATA_DIR / "pv_device_backups"
IMAGE_UPLOAD_DIR = Path(os.getenv("TRYVOICE_MEDIA_DIR", str(USER_DATA_DIR / "media"))) / "inbound"
MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_IMAGE_MIME: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}

# Injected at startup via init()
_history_store = None


def init(store):
    global _history_store
    _history_store = store


def _sanitize_device_tag(raw: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", str(raw or "default"))[:64]


def _load_backup_data(fp: Path) -> list[Any] | None:
    if not fp.exists():
        return None
    data = json.loads(fp.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    return None


@router.get("/health")
async def health():
    from backend.adapter.registry import _router, get_active_adapter_id
    from backend.app import get_config_store
    from backend.paths import ENV_PATH

    outbox = _history_store.outbox_stats()
    adapter_id = get_active_adapter_id()
    fallback_id = _router.fallback_id
    has_env = Path(ENV_PATH).exists() if ENV_PATH else False
    has_config = get_config_store().get_active_adapter_config() is not None
    setup_needed = not has_env and not has_config
    # Mirror status
    try:
        from backend.mirror import get_mirror_manager

        mirror_status = get_mirror_manager().status()
    except RuntimeError:
        mirror_status = {}
    result = {
        "status": "ok",
        "activeAdapter": adapter_id,
        "fallbackAdapter": fallback_id,
        "setupNeeded": setup_needed,
        "stt": "groq-whisper",
        "tts": "edge",
        "historyStore": "canonical-sqlite",
        "historySyncIntervalSec": HISTORY_SYNC_INTERVAL_SECONDS,
        "mirror": mirror_status,
        "telegramOutbox": outbox,  # backward compat
    }
    if fallback_id == "openclaw" or "openclaw" in _router._adapters:
        try:
            from backend.config import GATEWAY_URL

            result["gateway"] = GATEWAY_URL
        except ImportError:
            pass
    return result


@router.post("/setup")
async def setup(request: Request):
    """Save adapter config to ConfigStore + write minimal .env. Supports reconfiguration."""
    from backend.adapter.registry import get_adapter
    from backend.app import get_config_store
    from backend.paths import ENV_PATH

    config_store = get_config_store()
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Invalid JSON"}, status_code=400)

    adapter_type = body.get("adapterType", "claude-code")
    adapter_config = body.get("adapterConfig") or {}

    # Legacy format: convert gatewayUrl/gatewayToken to adapterConfig fields
    if not adapter_config:
        if body.get("gatewayUrl"):
            adapter_config["gateway_url"] = body["gatewayUrl"]
        if body.get("gatewayToken"):
            adapter_config["gateway_token"] = body["gatewayToken"]

    # Save adapter config to ConfigStore (primary source of truth)
    from backend.adapter.registry import _registry

    display_name = adapter_type
    for aid, inst in _registry.items():
        if aid == adapter_type and hasattr(type(inst), "config_schema"):
            break
    config_id = config_store.save_adapter_config(
        adapter_type=adapter_type,
        display_name=display_name,
        config=adapter_config,
    )
    config_store.set_active_adapter(config_id)

    # Apply config to the live adapter instance
    try:
        adapter = get_adapter(adapter_type)
        if hasattr(adapter, "apply_config"):
            adapter.apply_config(adapter_config)
        # Update fallback adapter on the router
        set_active_adapter(adapter_type)
    except KeyError:
        pass

    # Write .env — merge with existing entries so previously-saved keys
    # (e.g. GROQ_API_KEY, AZURE_SPEECH_KEY) are not wiped out.
    env_path = Path(ENV_PATH)
    existing_lines = env_path.read_text().splitlines() if env_path.exists() else []

    updates: dict[str, str] = {"TRYVOICE_ACTIVE_ADAPTER": adapter_type}
    if body.get("groqApiKey"):
        updates["GROQ_API_KEY"] = body["groqApiKey"]
    if body.get("edgeTtsVoice"):
        updates["EDGE_TTS_VOICE"] = body["edgeTtsVoice"]
    if body.get("accessPassword"):
        updates["TRYVOICE_ACCESS_PASSWORD"] = body["accessPassword"]

    merged: list[str] = []
    seen_keys: set[str] = set()
    for line in existing_lines:
        key_part = line.split("=", 1)[0] if "=" in line else ""
        if key_part in updates:
            merged.append(f"{key_part}={updates[key_part]}")
            seen_keys.add(key_part)
        else:
            merged.append(line)
    for k, v in updates.items():
        if k not in seen_keys:
            merged.append(f"{k}={v}")
    env_path.write_text("\n".join(merged) + "\n")

    # Reload environment
    from dotenv import load_dotenv

    load_dotenv(ENV_PATH, override=True)

    # Discover bots (but do NOT auto-sync to slots — user selects first)
    discovered_bots: list[dict] = []
    discovery_error: str = ""
    try:
        adapter_inst = get_adapter(adapter_type)
        discovered_bots = await run_discover_only(adapter_inst, adapter_type)
    except KeyError:
        pass
    except Exception as e:
        discovery_error = str(e)
        logger.warning(f"Post-setup discover_bots failed: {e}")

    resp_body: dict[str, Any] = {"ok": True, "discoveredBots": discovered_bots}
    if discovery_error:
        resp_body["discoveryError"] = discovery_error
    return JSONResponse(resp_body)


@router.post("/setup/select-bots")
async def setup_select_bots(request: Request):
    """Replace slot registry with user-selected bots (first-run setup)."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Invalid JSON"}, status_code=400)

    bots = body.get("bots") or []
    if not isinstance(bots, list) or not bots:
        return JSONResponse({"ok": False, "error": "bots must be a non-empty list"}, status_code=400)

    from backend.runtime.slot_registry import merge_slots as _ms
    from backend.runtime.slot_registry import set_slots as _ss

    mode = body.get("mode", "replace")

    new_slots = []
    seen_keys: set[str] = set()
    for bot in bots:
        if not isinstance(bot, dict):
            continue
        session_key = bot.get("sessionKey", "")
        if not session_key or session_key in seen_keys:
            continue
        bot_id = bot.get("botId", "")
        new_slots.append(
            {
                "slotId": bot_id,
                "accountId": bot_id,
                "name": bot.get("name", bot_id),
                "sessionKey": session_key,
                "telegramBotToken": "",
                "legacyBotId": bot_id,
            }
        )
        seen_keys.add(session_key)

    try:
        if mode == "append":
            result = _ms(new_slots)
            logger.info(f"select-bots: merged {result['added']} new bot(s) into {result['slotCount']} slots")
        else:
            _ss(new_slots)
            logger.info(f"select-bots: set {len(new_slots)} bot(s) as slots (replaced defaults)")
    except Exception as e:
        logger.warning(f"select-bots: failed to sync: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    # Re-enrich mirror/session config from gateway — select-bots (especially
    # in "replace" mode) may have wiped enriched mirrorChannels/sessionKey.
    try:
        from backend.app import enrich_slots_from_gateway

        enrich_slots_from_gateway()
    except Exception:
        pass

    # Mark as warmed so /slots GET doesn't duplicate pre_warm
    for s in new_slots:
        _pre_warm_done.add(s.get("sessionKey", ""))
    asyncio.create_task(_pre_warm_slots(new_slots))

    from backend.runtime.slot_registry import list_slots

    return JSONResponse({"ok": True, "slots": list_slots()})


@router.get("/setup/adapter-schemas")
async def setup_adapter_schemas():
    """Return config_schema() for each registered adapter — used by the setup wizard."""
    from backend.adapter.registry import _registry

    result = {}
    for adapter_id, adapter_instance in _registry.items():
        if adapter_id in ("hybrid", "router"):
            continue
        schema = []
        if hasattr(type(adapter_instance), "config_schema"):
            try:
                for f in type(adapter_instance).config_schema():
                    schema.append(
                        {
                            "name": f.name,
                            "label": f.label,
                            "fieldType": f.field_type,
                            "required": f.required,
                            "default": f.default,
                            "description": f.description,
                            "options": f.options,
                            "group": f.group,
                        }
                    )
            except Exception:
                pass
        caps = {}
        if hasattr(adapter_instance, "report_capabilities"):
            try:
                c = adapter_instance.report_capabilities()
                caps = {
                    "supportsDiscovery": c.supports_discovery,
                    "supportsCreation": c.supports_creation,
                    "supportsStream": c.supports_stream,
                    "supportsSessionResume": c.supports_session_resume,
                }
            except Exception:
                pass
        create_schema = []
        if hasattr(adapter_instance, "create_bot_schema"):
            try:
                for f in adapter_instance.create_bot_schema():
                    create_schema.append(
                        {
                            "name": f.name,
                            "label": f.label,
                            "fieldType": f.field_type,
                            "required": f.required,
                            "default": f.default,
                            "description": f.description,
                            "options": f.options,
                        }
                    )
            except Exception:
                pass
        entry: dict[str, Any] = {"schema": schema, "capabilities": caps}
        if create_schema:
            entry["createBotSchema"] = create_schema
        result[adapter_id] = entry
    return JSONResponse({"adapters": result})


async def run_discover_only(adapter, adapter_id: str) -> list[dict]:
    """Discover bots from *adapter* without syncing to slots.

    Returns a list of bot dicts (may be empty).
    Sessions that share a project_dir with an existing Claude Code slot are
    marked with metadata.dir_conflict=True so the UI can disable them.
    """
    if not hasattr(adapter, "discover_bots"):
        return []
    try:
        raw_bots = await adapter.discover_bots()
        bots = [
            {"botId": b.bot_id, "name": b.name, "sessionKey": b.session_key, "metadata": dict(b.metadata or {})}
            for b in raw_bots
            if not (b.metadata or {}).get("is_fallback")
        ]
    except Exception as e:
        logger.warning(f"discover_bots failed for {adapter_id}: {e}")
        return []

    # Mark bots whose sessionKey already exists in slot registry
    # or that are already managed by the adapter (tmux sessions it created)
    from backend.runtime.slot_registry import list_slots as _ls

    existing_session_keys = {s["sessionKey"] for s in _ls()}

    for bot in bots:
        if bot["sessionKey"] in existing_session_keys or bot.get("metadata", {}).get("managed"):
            bot["metadata"]["already_added"] = True

    return bots


async def run_discover_and_sync(adapter, adapter_id: str) -> list[dict]:
    """Discover bots from *adapter* and merge into slot registry.

    Returns a list of bot dicts (may be empty).  Safe to call even when the
    adapter does not support discover_bots.
    """
    bots: list[dict] = []
    if not hasattr(adapter, "discover_bots"):
        return bots

    try:
        raw_bots = await adapter.discover_bots()
        bots = [
            {"botId": b.bot_id, "name": b.name, "sessionKey": b.session_key, "metadata": b.metadata} for b in raw_bots
        ]
    except Exception as e:
        logger.warning(f"discover_bots failed for {adapter_id}: {e}")
        return bots

    # Only sync bots with live processes, not fallback (mtime-only) discoveries
    syncable_bots = [b for b in bots if not (b.get("metadata") or {}).get("is_fallback")]
    syncable_keys = {b["sessionKey"] for b in syncable_bots}

    # Bridge discovered bots → slots (merge, don't replace existing)
    from backend.runtime.slot_registry import list_slots as _ls
    from backend.runtime.slot_registry import set_slots as _ss

    existing = _ls()
    existing_keys = {s["sessionKey"] for s in existing}
    # Build lookups: botId → discovered metadata for enriching existing slots.
    # Use *all* discovered bots (not just syncable) so enrichment works even
    # when the bot has no active session (e.g. fallback/mtime-only discovery).
    all_discovered_meta: dict[str, dict] = {bot["botId"]: bot.get("metadata", {}) for bot in bots}
    new_slots = list(existing)
    changed = False
    # Enrich existing slots with discovered tokens/channels (if slot has none)
    for slot in new_slots:
        meta = all_discovered_meta.get(slot.get("slotId", ""), {})
        token = str(meta.get("telegramBotToken") or "")
        if token and not slot.get("telegramBotToken"):
            slot["telegramBotToken"] = token
            changed = True
        channel = str(meta.get("channel") or "")
        if channel and not slot.get("mirrorChannels"):
            slot["mirrorChannels"] = [channel]
            changed = True
    for bot in syncable_bots:
        bid = bot["botId"]
        # Match by sessionKey (bot_id now contains UUID suffix, so each instance is unique)
        existing_slot = None
        for s in new_slots:
            if s.get("sessionKey") == bot["sessionKey"]:
                existing_slot = s
                break
        if existing_slot:
            # Update slotId if it changed (e.g. after session key rotation)
            if existing_slot.get("slotId") != bid:
                existing_slot["slotId"] = bid
                changed = True
            if existing_slot.get("status") != "online":
                existing_slot["status"] = "online"
                changed = True
            continue
        if bot["sessionKey"] in existing_keys:
            continue
        meta = bot.get("metadata", {})
        channel = str(meta.get("channel") or "")
        new_slots.append(
            {
                "slotId": bot["botId"],
                "accountId": bot["botId"],
                "name": bot["name"],
                "sessionKey": bot["sessionKey"],
                "telegramBotToken": str(meta.get("telegramBotToken") or ""),
                "mirrorChannels": [channel] if channel else [],
                "legacyBotId": bot["botId"],
                "status": "online",
            }
        )
        changed = True

    # Mark stale Claude Code slots as offline instead of removing them
    for s in new_slots:
        sk = s.get("sessionKey", "")
        if sk.startswith("claude:") and sk not in syncable_keys:
            if s.get("status") != "offline":
                s["status"] = "offline"
                changed = True

    if changed:
        try:
            _ss(new_slots)
            logger.info(f"Synced slots: {len(new_slots)} total")
        except Exception as e:
            logger.warning(f"Failed to sync discovered bots to slots: {e}")

    return syncable_bots


@router.get("/adapter/discover-bots")
async def adapter_discover_bots():
    """Run discover_bots() on the active adapter and optionally sync to slots."""
    from backend.adapter.registry import get_active_adapter_id, get_default_adapter

    adapter = get_default_adapter()
    adapter_id = get_active_adapter_id()
    bots = await run_discover_and_sync(adapter, adapter_id)
    return JSONResponse({"adapterId": adapter_id, "bots": bots})


@router.post("/adapter/create-bot")
async def adapter_create_bot(request: Request):
    """Create a new bot via the specified adapter's create_bot() protocol.

    Body: { params: {...}, adapterType?: "claude-code" | "openai-compat" | ... }
    When adapterType is provided, the bot is created directly on that adapter
    instead of relying on the router's _find_creator() which may pick the wrong one.
    """
    from backend.adapter.registry import get_adapter, get_default_adapter
    from backend.runtime.slot_registry import merge_slots as _ms

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "Invalid JSON"}, status_code=400)

    # Route to the specific adapter if the frontend tells us which one
    adapter_type = body.get("adapterType")
    if adapter_type:
        try:
            target_adapter = get_adapter(adapter_type)
        except KeyError:
            return JSONResponse(
                {"ok": False, "error": f"Unknown adapter: {adapter_type}"},
                status_code=400,
            )
    else:
        # Fallback: use the router (picks first creator — legacy path)
        target_adapter = get_default_adapter()

    caps = getattr(target_adapter, "report_capabilities", lambda: None)()
    if not caps or not getattr(caps, "supports_creation", False):
        return JSONResponse(
            {"ok": False, "error": "Adapter does not support bot creation"},
            status_code=400,
        )

    params = body.get("params") or {}
    try:
        bot_info = await target_adapter.create_bot(params=params)
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    except Exception as e:
        logger.error("create_bot error: {}", e)
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

    bot_dict = {
        "botId": bot_info.bot_id,
        "name": bot_info.name,
        "sessionKey": bot_info.session_key,
        "metadata": dict(bot_info.metadata or {}),
    }

    # Merge into slot registry
    slot_payload = [
        {
            "slotId": bot_info.bot_id,
            "accountId": bot_info.bot_id,
            "name": bot_info.name,
            "sessionKey": bot_info.session_key,
            "telegramBotToken": "",
            "legacyBotId": bot_info.bot_id,
        }
    ]
    try:
        _ms(slot_payload)
    except Exception as e:
        logger.warning("merge_slots after create_bot failed: {}", e)

    # Do NOT pre_warm here — the tmux window should only open when the
    # user clicks "Continue" in the discover UI (handled by select-bots).
    return JSONResponse({"ok": True, "bot": bot_dict})


@router.get("/adapter/capabilities")
async def adapter_capabilities():
    """Return adapter capability manifest for UI/feature degradation decisions."""
    return JSONResponse(get_capability_manifest())


@router.get("/adapter/active")
async def adapter_active():
    info = get_active_adapter_info()
    return JSONResponse(
        {
            "activeAdapter": info.get("adapterId"),
            "fallbackAdapter": info.get("fallbackAdapter"),
            "availableAdapters": list_adapters(),
            "adapter": info,
        }
    )


@router.put("/adapter/active")
async def adapter_active_update(request: Request):
    try:
        body = await request.json()
        adapter_id = ""
        if isinstance(body, dict):
            adapter_id = str(body.get("adapterId", "")).strip()
        if not adapter_id:
            return JSONResponse({"ok": False, "error": "adapterId is required"}, status_code=400)

        active = set_active_adapter(adapter_id)

        info = get_active_adapter_info()
        return JSONResponse(
            {
                "ok": True,
                "activeAdapter": active,
                "adapter": info,
                "manifest": get_capability_manifest(),
            }
        )
    except KeyError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    except Exception as e:
        logger.error(f"set active adapter error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/ops/metrics")
async def ops_metrics():
    metrics = ops_metrics_snapshot()
    adapter = get_active_adapter_info()
    outbox = _history_store.outbox_stats() if _history_store else {}
    return JSONResponse(
        {
            "ok": True,
            "metrics": metrics,
            "adapter": adapter,
            "slots": {
                "count": len(list_slots()),
                "defaultSlotId": get_default_slot_id(),
            },
            "outbox": outbox,
        }
    )


async def _pre_warm_slots(slots: list[dict]) -> None:
    """Fire-and-forget pre_warm for all slots concurrently.

    Runs all pre_warm calls in parallel so multiple new tmux sessions
    are created simultaneously instead of waiting up to 60s each.
    """
    adapter = get_default_adapter()
    fn = getattr(adapter, "pre_warm", None)
    if fn is None:
        return

    async def _warm_one(slot: dict) -> None:
        session_key = slot.get("sessionKey", "")
        if not session_key:
            return
        try:
            await fn(session_key=session_key)
        except Exception as exc:
            logger.warning("pre_warm failed slot={}: {}", slot.get("slotId", "?"), exc)

    await asyncio.gather(*[_warm_one(s) for s in slots])


@router.get("/slots/status")
async def slots_status_endpoint():
    """Return per-slot connection status for all configured slots.

    Status values per slot:
      "connected"    — session alive and ready
      "warming"      — session starting / loading history
      "disconnected" — session not running
      "processing"   — bot is actively processing a turn
    """
    from backend.runtime.state import get_bot_processing_states

    adapter = get_default_adapter()
    fn = getattr(adapter, "get_session_status", None)
    processing = get_bot_processing_states()
    statuses: dict[str, str] = {}
    for slot in list_slots():
        slot_id = slot["slotId"]
        session_key = slot.get("sessionKey", "")
        # Active turn takes priority over connection status
        if slot_id in processing:
            statuses[slot_id] = "processing"
            continue
        if fn and session_key:
            try:
                statuses[slot_id] = await fn(session_key=session_key)
            except Exception:
                statuses[slot_id] = "disconnected"
        else:
            statuses[slot_id] = "connected"
    return JSONResponse({"statuses": statuses})


_pre_warm_done: set[str] = set()  # session_keys already pre-warmed this process


@router.get("/slots")
async def slots_endpoint():
    slots = list_slots()
    # Only pre_warm slots that haven't been warmed yet (avoid duplicate tmux sessions)
    new_slots = [s for s in slots if s.get("sessionKey", "") not in _pre_warm_done]
    if new_slots:
        for s in new_slots:
            _pre_warm_done.add(s.get("sessionKey", ""))
        asyncio.create_task(_pre_warm_slots(new_slots))
    return JSONResponse(
        {
            "slots": slots,
            "defaultSlotId": get_default_slot_id(),
            "legacyBotMap": legacy_bot_map(),
        }
    )


@router.put("/slots")
async def update_slots_endpoint(request: Request):
    try:
        body = await request.json()
        payload = body if isinstance(body, list) else body.get("slots", [])
        summary = set_slots(payload)
        return JSONResponse({"ok": True, **summary, "slots": list_slots()})
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    except Exception as e:
        logger.error(f"update slots error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.delete("/slots/{slot_id}")
async def delete_slot_endpoint(slot_id: str):
    try:
        slot = get_slot(slot_id)
        if slot:
            session_key = slot.get("sessionKey", "")
            if session_key:
                adapter = get_default_adapter()
                fn = getattr(adapter, "on_slot_removed", None)
                if fn is not None:
                    try:
                        await fn(session_key=session_key)
                    except Exception as exc:
                        logger.warning("on_slot_removed error slot={}: {}", slot_id, exc)
        removed = remove_slot(slot_id)
        if not removed:
            return JSONResponse({"ok": False, "error": "slot not found"}, status_code=404)
        return JSONResponse({"ok": True, "slots": list_slots(), "defaultSlotId": get_default_slot_id()})
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    except Exception as e:
        logger.error(f"delete slot error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.patch("/slots/{slot_id}")
async def patch_slot_endpoint(slot_id: str, request: Request):
    """Partially update a slot (e.g. mirror config)."""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse({"ok": False, "error": "body must be object"}, status_code=400)
        updated = update_slot(slot_id, body)
        if updated is None:
            return JSONResponse({"ok": False, "error": "slot not found"}, status_code=404)
        return JSONResponse({"ok": True, "slot": updated})
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
    except Exception as e:
        logger.error(f"patch slot error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/slots/{slot_id}/attach-terminal")
async def attach_terminal_endpoint(slot_id: str):
    """Open a visible terminal window attached to this bot's tmux session."""
    slot = get_slot(slot_id)
    if not slot:
        return JSONResponse({"ok": False, "error": "slot not found"}, status_code=404)
    session_key = slot.get("sessionKey", "")
    if not session_key:
        return JSONResponse({"ok": False, "error": "no session key"}, status_code=400)
    adapter = get_default_adapter()
    fn = getattr(adapter, "attach_terminal", None)
    if fn is None:
        return JSONResponse({"ok": False, "error": "adapter does not support attach"}, status_code=400)
    try:
        opened = await fn(session_key=session_key)
        return JSONResponse({"ok": opened})
    except Exception as e:
        logger.error(f"attach_terminal error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/slots/reset")
async def reset_slots_endpoint():
    reset_default_slots()
    return JSONResponse(
        {
            "ok": True,
            "slots": list_slots(),
            "defaultSlotId": get_default_slot_id(),
            "legacyBotMap": legacy_bot_map(),
        }
    )


@router.post("/debug_log")
async def debug_log(request: Request):
    """Receive client-side debug logs and write to audio_debug.log"""
    try:
        data = await request.json()
        log_msg = data.get("message", "")
        timestamp = data.get("timestamp", "")

        # Write to audio_debug.log
        log_path = USER_DATA_DIR / "logs" / "audio_debug.log"
        log_path.parent.mkdir(exist_ok=True)

        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"{timestamp} | {log_msg}\n")

        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Debug log error: {e}")
        return {"status": "error", "error": str(e)}


@router.post("/setup/groq-key")
async def setup_groq_key(request: Request):
    """Update Groq API Key in .env and hot-reload STT provider."""
    try:
        from backend.paths import ENV_PATH

        body = await request.json()
        new_key = str(body.get("groqApiKey") or "").strip()
        # Strip env var prefix if user pasted the full line from .env
        if new_key.upper().startswith("GROQ_API_KEY="):
            new_key = new_key[len("GROQ_API_KEY=") :]
        if not new_key:
            return JSONResponse({"ok": False, "error": "groqApiKey is required"}, status_code=400)
        # Guard against concatenated keys (normal Groq key is ~56 chars)
        if len(new_key) > 80:
            return JSONResponse(
                {"ok": False, "error": "API key looks too long — check for duplicate paste"},
                status_code=400,
            )

        # Read existing .env, update or add GROQ_API_KEY
        env_path = Path(ENV_PATH)
        lines = env_path.read_text().splitlines() if env_path.exists() else []
        found = False
        for i, line in enumerate(lines):
            if line.startswith("GROQ_API_KEY="):
                lines[i] = f"GROQ_API_KEY={new_key}"
                found = True
                break
        if not found:
            lines.append(f"GROQ_API_KEY={new_key}")
        env_path.write_text("\n".join(lines) + "\n")

        # Reload environment
        from dotenv import load_dotenv

        load_dotenv(ENV_PATH, override=True)

        # Update in-memory config
        import backend.config.voice as voice_cfg

        voice_cfg.GROQ_API_KEY = new_key

        # Hot-reload STT provider
        from backend.voice.stt_registry import reinit_stt_provider

        reinit_stt_provider()

        return JSONResponse({"ok": True, "enabled": True})
    except Exception as e:
        logger.error(f"setup groq key error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.post("/setup/azure-key")
async def setup_azure_key(request: Request):
    """Update Azure Speech Key and Region in .env and hot-reload config."""
    try:
        from backend.paths import ENV_PATH

        body = await request.json()
        new_key = str(body.get("azureKey") or "").strip()
        new_region = str(body.get("azureRegion") or "").strip() or "westus2"
        # Strip env var prefix if user pasted the full line from .env
        if new_key.upper().startswith("AZURE_SPEECH_KEY="):
            new_key = new_key[len("AZURE_SPEECH_KEY=") :]

        env_path = Path(ENV_PATH)
        lines = env_path.read_text().splitlines() if env_path.exists() else []

        # Update or add AZURE_SPEECH_KEY
        key_found = False
        region_found = False
        for i, line in enumerate(lines):
            if line.startswith("AZURE_SPEECH_KEY="):
                lines[i] = f"AZURE_SPEECH_KEY={new_key}"
                key_found = True
            elif line.startswith("AZURE_SPEECH_REGION="):
                lines[i] = f"AZURE_SPEECH_REGION={new_region}"
                region_found = True
        if not key_found:
            lines.append(f"AZURE_SPEECH_KEY={new_key}")
        if not region_found:
            lines.append(f"AZURE_SPEECH_REGION={new_region}")
        env_path.write_text("\n".join(lines) + "\n")

        # Reload environment
        from dotenv import load_dotenv

        load_dotenv(ENV_PATH, override=True)

        # Update in-memory config
        import backend.config.voice as voice_cfg

        voice_cfg.AZURE_SPEECH_KEY = new_key
        voice_cfg.AZURE_SPEECH_REGION = new_region

        return JSONResponse({"ok": True, "enabled": bool(new_key)})
    except Exception as e:
        logger.error(f"setup azure key error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/stt-config")
async def stt_config_endpoint():
    """Return STT configuration for browser-direct Groq Whisper."""
    import backend.config.voice as voice_cfg

    current_key = voice_cfg.GROQ_API_KEY
    key_masked = ""
    if current_key and len(current_key) > 8:
        key_masked = current_key[:4] + "****" + current_key[-4:]
    elif current_key:
        key_masked = "****"

    if not EXPOSE_BROWSER_STT_KEY:
        return JSONResponse(
            {
                "enabled": bool(current_key),
                "apiKey": None,
                "model": GROQ_WHISPER_MODEL,
                "endpoint": "https://api.groq.com/openai/v1/audio/transcriptions",
                "keyMasked": key_masked,
            }
        )
    return JSONResponse(
        {
            "enabled": bool(current_key),
            "apiKey": current_key if current_key else None,
            "model": GROQ_WHISPER_MODEL,
            "endpoint": "https://api.groq.com/openai/v1/audio/transcriptions",
            "keyMasked": key_masked,
        }
    )


@router.post("/pv-device/backup")
async def pv_device_backup(request: Request):
    """Save a client's pv_db IndexedDB snapshot to the server."""
    try:
        body = await request.json()
        device_tag = _sanitize_device_tag(str(body.get("deviceTag", "default")))
        data = body.get("data")
        if not data:
            return JSONResponse({"error": "no data"}, status_code=400)
        PV_DEVICE_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        fp = PV_DEVICE_BACKUP_DIR / f"{device_tag}.json"
        fp.write_text(json.dumps(data), encoding="utf-8")
        logger.info(f"pv_db backup saved: {fp.name} ({len(json.dumps(data))} bytes)")
        return JSONResponse({"ok": True})
    except Exception as e:
        logger.error(f"pv_db backup error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/pv-device/backups")
async def pv_device_backups():
    """List known backup tags and light metadata (for migration/debug)."""
    try:
        PV_DEVICE_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        items: list[dict[str, Any]] = []
        for fp in PV_DEVICE_BACKUP_DIR.glob("*.json"):
            try:
                stat = fp.stat()
                data = _load_backup_data(fp)
                entries = len(data) if data is not None else 0
                items.append(
                    {
                        "deviceTag": fp.stem,
                        "entries": entries,
                        "sizeBytes": int(stat.st_size),
                        "mtimeMs": int(stat.st_mtime * 1000),
                    }
                )
            except Exception:
                continue
        items.sort(key=lambda it: int(it.get("mtimeMs", 0)), reverse=True)
        return JSONResponse({"items": items})
    except Exception as e:
        logger.error(f"pv_db backups list error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/pv-device/adopt")
async def pv_device_adopt(request: Request):
    """Copy an existing backup to targetTag. If sourceTag omitted, pick newest non-empty backup."""
    try:
        body = await request.json()
        target_tag = _sanitize_device_tag(str(body.get("targetTag", "default")))
        source_tag_raw = body.get("sourceTag")
        source_tag = _sanitize_device_tag(str(source_tag_raw)) if source_tag_raw else ""

        PV_DEVICE_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        target_fp = PV_DEVICE_BACKUP_DIR / f"{target_tag}.json"

        chosen_source_tag = source_tag
        chosen_data: list[Any] | None = None

        if chosen_source_tag:
            source_fp = PV_DEVICE_BACKUP_DIR / f"{chosen_source_tag}.json"
            chosen_data = _load_backup_data(source_fp)
            if not chosen_data:
                return JSONResponse({"ok": False, "error": "source backup not found"}, status_code=404)
        else:
            # Auto-pick newest non-empty backup that is not the target tag.
            candidates: list[tuple[int, str, list[Any]]] = []
            for fp in PV_DEVICE_BACKUP_DIR.glob("*.json"):
                tag = fp.stem
                if tag == target_tag:
                    continue
                data = _load_backup_data(fp)
                if not data:
                    continue
                try:
                    mtime = int(fp.stat().st_mtime * 1000)
                except Exception:
                    mtime = 0
                candidates.append((mtime, tag, data))
            if not candidates:
                return JSONResponse({"ok": False, "error": "no usable source backup"}, status_code=404)
            candidates.sort(key=lambda c: c[0], reverse=True)
            _, chosen_source_tag, chosen_data = candidates[0]

        if not chosen_data:
            return JSONResponse({"ok": False, "error": "empty source backup"}, status_code=400)

        target_fp.write_text(json.dumps(chosen_data), encoding="utf-8")
        logger.info(f"pv_db backup adopted: {chosen_source_tag} -> {target_tag} ({len(chosen_data)} entries)")
        return JSONResponse(
            {
                "ok": True,
                "sourceTag": chosen_source_tag,
                "targetTag": target_tag,
                "entries": len(chosen_data),
            }
        )
    except Exception as e:
        logger.error(f"pv_db adopt error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@router.get("/pv-device/restore/{device_tag}")
async def pv_device_restore(device_tag: str):
    """Return a previously saved pv_db snapshot for a device."""
    device_tag = _sanitize_device_tag(device_tag)
    fp = PV_DEVICE_BACKUP_DIR / f"{device_tag}.json"
    if not fp.exists():
        return JSONResponse({"data": None})
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
        return JSONResponse({"data": data})
    except Exception as e:
        logger.error(f"pv_db restore error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/media/upload")
async def media_upload(file: UploadFile = File(...)):
    """Upload one image and return a local absolute path for gateway media attachment."""
    try:
        if not file:
            return JSONResponse({"ok": False, "error": "missing file"}, status_code=400)

        content_type = str(file.content_type or "").lower().strip()
        ext = ALLOWED_IMAGE_MIME.get(content_type)
        if not ext:
            return JSONResponse({"ok": False, "error": "unsupported image type"}, status_code=400)

        data = await file.read(MAX_IMAGE_UPLOAD_BYTES + 1)
        size = len(data)
        if size <= 0:
            return JSONResponse({"ok": False, "error": "empty image"}, status_code=400)
        if size > MAX_IMAGE_UPLOAD_BYTES:
            return JSONResponse({"ok": False, "error": "image too large"}, status_code=413)

        IMAGE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        image_path = IMAGE_UPLOAD_DIR / f"file_web---{uuid.uuid4().hex}.{ext}"
        image_path.write_bytes(data)
        logger.info(f"media upload saved: {image_path} ({size} bytes)")
        return JSONResponse(
            {
                "ok": True,
                "path": str(image_path),
                "size": size,
                "contentType": content_type,
                "name": file.filename or image_path.name,
            }
        )
    except Exception as e:
        logger.error(f"media upload error: {e}")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ---------------------------------------------------------------------------
# Hook-based interactive forwarding (observer-mode Claude Code sessions)
# ---------------------------------------------------------------------------


@router.post("/api/hooks/session-start")
async def hooks_session_start(request: Request):
    """Receive SessionStart hook from Claude Code TUI sessions.

    Non-blocking — returns immediately after notifying the adapter.
    """
    from backend.ws.handler import get_session_orchestrator

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "invalid_json"}, status_code=400)

    orch = get_session_orchestrator()
    if not orch or not orch.adapter:
        return JSONResponse({"ok": False, "error": "no_adapter"})

    adapter = orch.adapter
    if not hasattr(adapter, "handle_session_start_hook"):
        return JSONResponse({"ok": False, "error": "unsupported"})

    result = await adapter.handle_session_start_hook(body)
    return JSONResponse(result)


@router.post("/api/hooks/interactive")
async def hooks_interactive(request: Request):
    """Receive hook callbacks from Claude Code TUI sessions.

    The hook script POSTs here with the hook event JSON + tmux_name.
    This endpoint blocks until the user responds in the web frontend
    or until timeout (580s).
    """
    from backend.ws.handler import get_session_orchestrator

    _log = logger.bind(component="route.hooks")
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"decision": "allow", "error": "invalid_json"}, status_code=400)

    tmux_name = body.get("tmux_name", "")
    if not tmux_name:
        return JSONResponse({"decision": "allow", "error": "missing_tmux_name"}, status_code=400)

    orch = get_session_orchestrator()
    if not orch or not orch.adapter:
        _log.warning("hooks/interactive: no orchestrator available")
        return JSONResponse({"decision": "allow", "error": "no_adapter"})

    adapter = orch.adapter
    if not hasattr(adapter, "handle_hook_interactive"):
        _log.warning("hooks/interactive: adapter does not support hook forwarding")
        return JSONResponse({"decision": "allow", "error": "unsupported"})

    result = await adapter.handle_hook_interactive(body)
    return JSONResponse(result)
