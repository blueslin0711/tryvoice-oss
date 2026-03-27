"""Runtime slot registry with legacy bot compatibility mapping."""

from __future__ import annotations

import json
import threading
from collections import OrderedDict
from typing import Any

from backend.config import (
    BOT_CONFIG,
    SESSION_AGENT_ID,
    SESSION_NAMESPACE,
    SESSION_SCOPE,
    TELEGRAM_BOT_TOKEN,
)
from backend.paths import SLOTS_PATH

_SLOT_ID_ALLOWED = set("abcdefghijklmnopqrstuvwxyz0123456789._-")
_REGISTRY_LOCK = threading.RLock()


def _normalize_slot_id(raw: str) -> str:
    value = str(raw or "").strip().lower()
    if not value:
        raise ValueError("slotId is required")
    if any(ch not in _SLOT_ID_ALLOWED for ch in value):
        raise ValueError(f"invalid slotId: {raw}")
    return value


def _fallback_session_key(account_id: str) -> str:
    return f"agent:{SESSION_AGENT_ID}:{SESSION_NAMESPACE}:{account_id}:ctx:{SESSION_SCOPE}"


def _normalize_slot_payload(item: dict[str, Any], *, default_legacy: str = "") -> dict[str, Any]:
    slot_id = _normalize_slot_id(item.get("slotId") or item.get("id") or "")
    account_id = str(item.get("accountId") or slot_id).strip() or slot_id
    name = str(item.get("name") or slot_id).strip() or slot_id
    session_key = str(item.get("sessionKey") or "").strip() or _fallback_session_key(account_id)
    telegram_bot_token = str(item.get("telegramBotToken") or "").strip()
    legacy_bot_id = str(item.get("legacyBotId") or item.get("botId") or default_legacy).strip().lower()
    if legacy_bot_id:
        legacy_bot_id = _normalize_slot_id(legacy_bot_id)
    mirror = dict(item.get("mirror") or {}) if isinstance(item.get("mirror"), dict) else {}
    raw_mc = item.get("mirrorChannels")
    mirror_channels: list[str] = list(raw_mc) if isinstance(raw_mc, list) else []
    status = str(item.get("status") or "online").strip()
    if status not in ("online", "offline"):
        status = "online"
    return {
        "slotId": slot_id,
        "accountId": account_id,
        "name": name,
        "sessionKey": session_key,
        "telegramBotToken": telegram_bot_token,
        "legacyBotId": legacy_bot_id,
        "mirrorChannels": mirror_channels,
        "mirror": mirror,
        "status": status,
    }


def _build_default_slots() -> OrderedDict[str, dict[str, Any]]:
    if not BOT_CONFIG:
        # Echo mode or no OpenClaw configuration: single default slot
        out: OrderedDict[str, dict[str, Any]] = OrderedDict()
        out["main"] = {
            "slotId": "main",
            "accountId": "main",
            "name": "Assistant",
            "sessionKey": "local:main:default",
            "telegramBotToken": "",
            "legacyBotId": "main",
            "mirrorChannels": [],
            "mirror": {},
        }
        return out
    out = OrderedDict()
    for bot_id, cfg in BOT_CONFIG.items():
        normalized = _normalize_slot_payload(
            {
                "slotId": bot_id,
                "accountId": cfg.get("accountId") or bot_id,
                "name": cfg.get("name") or bot_id,
                "sessionKey": cfg.get("sessionKey") or "",
                "telegramBotToken": cfg.get("telegramBotToken") or TELEGRAM_BOT_TOKEN,
                "legacyBotId": bot_id,
            },
            default_legacy=bot_id,
        )
        out[normalized["slotId"]] = normalized
    return out


def _build_legacy_map(slots: OrderedDict[str, dict[str, Any]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for slot_id, cfg in slots.items():
        legacy = str(cfg.get("legacyBotId") or "").strip().lower()
        if legacy:
            out[legacy] = slot_id
    return out


def _save_slots_to_disk(slots: OrderedDict[str, dict[str, Any]]) -> None:
    payload = {
        "version": 1,
        "slots": [dict(item) for item in slots.values()],
    }
    SLOTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SLOTS_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _load_slots_from_disk() -> OrderedDict[str, dict[str, Any]] | None:
    if not SLOTS_PATH.exists():
        return None
    try:
        raw = json.loads(SLOTS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    items = raw.get("slots") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return None
    if not items:
        return OrderedDict()
    out: OrderedDict[str, dict[str, Any]] = OrderedDict()
    legacy_used: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            return None
        normalized = _normalize_slot_payload(item)
        slot_id = normalized["slotId"]
        if slot_id in out:
            return None
        legacy = str(normalized.get("legacyBotId") or "").strip().lower()
        if legacy:
            if legacy in legacy_used:
                return None
            legacy_used.add(legacy)
        out[slot_id] = normalized
    return out


_DEFAULT_SLOTS: OrderedDict[str, dict[str, Any]] = _build_default_slots()
_loaded_slots = _load_slots_from_disk()
_SLOTS: OrderedDict[str, dict[str, Any]] = (
    _loaded_slots if _loaded_slots is not None else OrderedDict((k, dict(v)) for k, v in _DEFAULT_SLOTS.items())
)
_LEGACY_TO_SLOT: dict[str, str] = _build_legacy_map(_SLOTS)


def list_slots() -> list[dict[str, Any]]:
    with _REGISTRY_LOCK:
        return [dict(item) for item in _SLOTS.values()]


def remove_slot(slot_id: str) -> bool:
    """Remove a slot by its ID. Returns True if removed, False if not found."""
    slot_id = slot_id.strip().lower()
    with _REGISTRY_LOCK:
        if slot_id not in _SLOTS:
            return False
        del _SLOTS[slot_id]
        _LEGACY_TO_SLOT.clear()
        _LEGACY_TO_SLOT.update(_build_legacy_map(_SLOTS))
        _save_slots_to_disk(_SLOTS)
    return True


def slot_ids() -> list[str]:
    with _REGISTRY_LOCK:
        return list(_SLOTS.keys())


def legacy_bot_map() -> dict[str, str]:
    with _REGISTRY_LOCK:
        return dict(_LEGACY_TO_SLOT)


def get_default_slot_id() -> str:
    with _REGISTRY_LOCK:
        if _SLOTS:
            return next(iter(_SLOTS.keys()))
    return "main"


def resolve_slot_id(raw_slot_or_bot: str | None) -> str | None:
    candidate = str(raw_slot_or_bot or "").strip().lower()
    if not candidate:
        return None
    with _REGISTRY_LOCK:
        if candidate in _SLOTS:
            return candidate
        mapped = _LEGACY_TO_SLOT.get(candidate)
        if mapped:
            return mapped
    return None


def get_slot(slot_id_or_bot_id: str | None) -> dict[str, Any] | None:
    resolved = resolve_slot_id(slot_id_or_bot_id)
    if not resolved:
        return None
    with _REGISTRY_LOCK:
        item = _SLOTS.get(resolved)
        return dict(item) if item else None


def find_slot_by_account_id(account_id: str | None) -> dict[str, Any] | None:
    needle = str(account_id or "").strip()
    if not needle:
        return None
    with _REGISTRY_LOCK:
        for item in _SLOTS.values():
            if str(item.get("accountId") or "").strip() == needle:
                return dict(item)
    return None


def get_slot_name(slot_id_or_bot_id: str | None) -> str:
    slot = get_slot(slot_id_or_bot_id)
    if slot:
        return str(slot.get("name") or slot.get("slotId") or "")
    return str(slot_id_or_bot_id or "")


def get_legacy_bot_id(slot_id_or_bot_id: str | None) -> str:
    slot = get_slot(slot_id_or_bot_id)
    if not slot:
        return str(slot_id_or_bot_id or "")
    return str(slot.get("legacyBotId") or slot.get("slotId") or "")


def require_slot(slot_id_or_bot_id: str | None) -> dict[str, Any]:
    slot = get_slot(slot_id_or_bot_id)
    if not slot:
        raise KeyError(f"unknown slot: {slot_id_or_bot_id}")
    return slot


def set_slots(new_slots: list[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(new_slots, list):
        raise ValueError("slots must be a list")

    ordered: OrderedDict[str, dict[str, Any]] = OrderedDict()
    legacy_used: set[str] = set()
    for item in new_slots:
        if not isinstance(item, dict):
            raise ValueError("slot item must be object")
        normalized = _normalize_slot_payload(item)
        slot_id = normalized["slotId"]
        if slot_id in ordered:
            raise ValueError(f"duplicate slotId: {slot_id}")
        legacy = str(normalized.get("legacyBotId") or "").strip().lower()
        if legacy:
            if legacy in legacy_used:
                raise ValueError(f"duplicate legacyBotId: {legacy}")
            legacy_used.add(legacy)
        ordered[slot_id] = normalized

    with _REGISTRY_LOCK:
        _SLOTS.clear()
        for key, value in ordered.items():
            _SLOTS[key] = dict(value)
        _LEGACY_TO_SLOT.clear()
        _LEGACY_TO_SLOT.update(_build_legacy_map(_SLOTS))
        _save_slots_to_disk(_SLOTS)

    return {
        "slotCount": len(ordered),
        "defaultSlotId": get_default_slot_id(),
        "legacyBotMap": legacy_bot_map(),
    }


def update_slot(slot_id: str, partial: dict[str, Any]) -> dict[str, Any] | None:
    """Partially update a slot's fields (e.g. mirror config). Returns updated slot or None."""
    slot_id = slot_id.strip().lower()
    with _REGISTRY_LOCK:
        if slot_id not in _SLOTS:
            return None
        current = _SLOTS[slot_id]
        for key, value in partial.items():
            if key in ("slotId",):
                continue  # immutable
            if key == "mirror":
                # Deep-merge mirror config
                existing_mirror = dict(current.get("mirror") or {})
                if isinstance(value, dict):
                    for ch_id, ch_cfg in value.items():
                        if isinstance(ch_cfg, dict):
                            existing_ch = dict(existing_mirror.get(ch_id) or {})
                            existing_ch.update(ch_cfg)
                            existing_mirror[ch_id] = existing_ch
                        else:
                            existing_mirror[ch_id] = ch_cfg
                current["mirror"] = existing_mirror
            elif key in current:
                current[key] = value
        _SLOTS[slot_id] = current
        _LEGACY_TO_SLOT.clear()
        _LEGACY_TO_SLOT.update(_build_legacy_map(_SLOTS))
        _save_slots_to_disk(_SLOTS)
        return dict(current)


def merge_slots(new_slots: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge new bots into existing slots without replacing existing ones."""
    with _REGISTRY_LOCK:
        existing_session_keys = {s["sessionKey"] for s in _SLOTS.values()}
        added = 0
        for item in new_slots:
            if not isinstance(item, dict):
                continue
            slot_id = str(item.get("slotId") or item.get("id") or "").strip()
            if not slot_id:
                continue
            # Normalize slot_id for lookup
            try:
                slot_id = _normalize_slot_id(slot_id)
            except ValueError:
                continue
            if slot_id in _SLOTS:
                continue
            try:
                normalized = _normalize_slot_payload(item)
            except ValueError:
                continue
            if normalized["sessionKey"] in existing_session_keys:
                continue
            _SLOTS[slot_id] = normalized
            existing_session_keys.add(normalized["sessionKey"])
            added += 1
        _LEGACY_TO_SLOT.clear()
        _LEGACY_TO_SLOT.update(_build_legacy_map(_SLOTS))
        _save_slots_to_disk(_SLOTS)
    return {"slotCount": len(_SLOTS), "added": added}


def reset_default_slots() -> None:
    with _REGISTRY_LOCK:
        _SLOTS.clear()
        for key, value in _DEFAULT_SLOTS.items():
            _SLOTS[key] = dict(value)
        _LEGACY_TO_SLOT.clear()
        _LEGACY_TO_SLOT.update(_build_legacy_map(_SLOTS))
        _save_slots_to_disk(_SLOTS)


def enrich_mirror_channels(
    account_channels: dict[str, list[str]],
    mirror_defaults: dict[str, dict[str, dict]] | None = None,
) -> int:
    """Fill empty mirrorChannels and mirror defaults from gateway config.

    Called at startup so the UI can render the correct mirror toggles
    without waiting for discover_and_sync.

    Args:
        account_channels: {accountId: [channel, ...]} e.g. {"alexa": ["telegram"]}
        mirror_defaults: {accountId: {channel: {target, token, ...}}}
            Pre-fills mirror.<channel>.target/token so users only need to
            toggle the checkbox — no manual ID entry required.

    Returns:
        Number of slots enriched.
    """
    if not account_channels and not mirror_defaults:
        return 0
    enriched = 0
    with _REGISTRY_LOCK:
        for slot in _SLOTS.values():
            acct = str(slot.get("accountId") or slot.get("slotId") or "")
            changed = False

            # Fill mirrorChannels (which channels are available for this bot)
            if not slot.get("mirrorChannels"):
                channels = account_channels.get(acct, [])
                if channels:
                    slot["mirrorChannels"] = list(channels)
                    changed = True

            # Fill mirror defaults (target, token) for channels that don't
            # have them yet.  This lets users just flip the toggle without
            # manually entering Telegram chat IDs or bot tokens.
            if mirror_defaults and acct in mirror_defaults:
                existing_mirror = dict(slot.get("mirror") or {})
                for ch_id, defaults in mirror_defaults[acct].items():
                    existing_ch = dict(existing_mirror.get(ch_id) or {})
                    for key, val in defaults.items():
                        if val and not existing_ch.get(key):
                            existing_ch[key] = val
                            changed = True
                    if existing_ch:
                        existing_mirror[ch_id] = existing_ch
                if existing_mirror != (slot.get("mirror") or {}):
                    slot["mirror"] = existing_mirror

            if changed:
                enriched += 1
        if enriched:
            _save_slots_to_disk(_SLOTS)
    return enriched


def enrich_slot_fields(payload: dict[str, Any]) -> dict[str, Any]:
    """Ensure both slotId and botId fields are present for compatibility."""
    slot_or_bot = payload.get("slotId") or payload.get("botId")
    resolved = resolve_slot_id(str(slot_or_bot or ""))
    if not resolved:
        return payload
    payload["slotId"] = resolved
    payload["botId"] = get_legacy_bot_id(resolved) or resolved
    return payload
