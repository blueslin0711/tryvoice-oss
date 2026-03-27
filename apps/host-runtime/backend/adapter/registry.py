"""Adapter registry and capability manifest.

Built-in adapters are loaded via direct imports. Third-party adapters are
discovered via ``tryvoice.adapters`` entry_points, allowing anyone to publish
an adapter package that is automatically picked up at runtime.

An AdapterRouter is always created so that session keys with recognised
prefixes (``claude:``, ``claw:``, ``agent:``, ``codex:``, ``gemini:``)
are routed to the correct sub-adapter, while unrecognised keys go to a
configurable fallback.
"""

from __future__ import annotations

import importlib
import os
import threading

from loguru import logger

from backend.adapter.contract import AdapterCapabilities
from backend.utils.entrypoints import get_entry_points

DEFAULT_ADAPTER_ID = os.getenv("TRYVOICE_DEFAULT_ADAPTER", "claude-code").strip() or "claude-code"

# ── Direct-import adapter tables ────────────────────────────────────────

# Built-in adapters (always available, shipped with tryvoice)
_BUILTIN_ADAPTERS: dict[str, str] = {
    "claude-code": "backend.adapter.claude_code.adapter:ClaudeCodeAdapter",
    "openclaw": "backend.adapter.openclaw.adapter:OpenClawAdapter",
}


def _load_class(dotted_path: str):
    """Load a class from a 'module.path:ClassName' string."""
    module_path, cls_name = dotted_path.rsplit(":", 1)
    mod = importlib.import_module(module_path)
    return getattr(mod, cls_name)


# ── Registry ────────────────────────────────────────────────────────────

_registry: dict[str, object] = {}

# Load built-in adapters
for _name, _path in _BUILTIN_ADAPTERS.items():
    try:
        _cls = _load_class(_path)
        _registry[_name] = _cls()
        logger.info(f"Adapter loaded (built-in): {_name} -> {_path}")
    except Exception as _exc:
        logger.warning(f"Failed to load built-in adapter '{_name}': {_exc}")

# Discover third-party adapters via entry_points
for _ep in get_entry_points("tryvoice.adapters"):
    if _ep.name in _registry:
        continue  # built-in takes precedence
    try:
        _cls = _ep.load()
        _registry[_ep.name] = _cls()
        logger.info(f"Adapter loaded (plugin): {_ep.name} -> {_ep.value}")
    except Exception as _exc:
        logger.warning(f"Failed to load plugin adapter '{_ep.name}': {_exc}")

# ---- Always create AdapterRouter ----
from backend.adapter.hybrid_adapter import AdapterRouter  # noqa: E402

# Build prefix map from discovered adapters
_prefix_map: dict[str, str] = {}
if "claude-code" in _registry:
    _prefix_map["claude:"] = "claude-code"
elif "anthropic" in _registry:
    _prefix_map["claude:"] = "anthropic"
if "openclaw" in _registry:
    _prefix_map["claw:"] = "openclaw"
    _prefix_map["agent:"] = "openclaw"
if "codex-cli" in _registry:
    _prefix_map["codex:"] = "codex-cli"
if "gemini-cli" in _registry:
    _prefix_map["gemini:"] = "gemini-cli"

# Fallback adapter for session keys with no recognised prefix
_fallback_adapter_id = (
    os.getenv("TRYVOICE_ACTIVE_ADAPTER") or os.getenv("TRYVOICE_DEFAULT_ADAPTER", "claude-code")
).strip() or "claude-code"
if _fallback_adapter_id not in _registry:
    _first_available = next(iter(_registry), "claude-code")
    logger.warning(
        f"Requested fallback adapter '{_fallback_adapter_id}' not found in registry "
        f"(available: {sorted(_registry.keys())}). Falling back to '{_first_available}'."
    )
    _fallback_adapter_id = _first_available

_router = AdapterRouter(
    adapters=dict(_registry),
    prefix_map=_prefix_map,
    fallback_id=_fallback_adapter_id,
)

_lock = threading.RLock()


def _caps_dict(caps: AdapterCapabilities) -> dict:
    hints: list[str] = []
    if not caps.supports_stream:
        hints.append("non_streaming_reply")
    if not caps.supports_cancel:
        hints.append("tts_only_stop")
    if not caps.supports_tool_events:
        hints.append("no_tool_events")
    sync_hints: dict = {}
    if caps.reconnect_burst_sync_ms > 0:
        sync_hints["reconnectBurstMs"] = caps.reconnect_burst_sync_ms
        sync_hints["reconnectBurstDurationMs"] = caps.reconnect_burst_duration_ms
    timeout_hints: dict = {}
    if getattr(caps, "processing_timeout_hint_ms", 0) > 0:
        timeout_hints["processingTimeoutMs"] = caps.processing_timeout_hint_ms
    return {
        "supportsStream": bool(caps.supports_stream),
        "supportsCancel": bool(caps.supports_cancel),
        "supportsSessionResume": bool(caps.supports_session_resume),
        "supportsMultiSlot": bool(caps.supports_multi_slot),
        "supportsToolEvents": bool(caps.supports_tool_events),
        "degradeHints": hints,
        "syncHints": sync_hints,
        "turnTimeoutHints": timeout_hints,
    }


def list_adapters() -> list[str]:
    return sorted(_registry.keys())


def get_adapter(adapter_id: str = DEFAULT_ADAPTER_ID):
    if adapter_id not in _registry:
        raise KeyError(f"unknown adapter: {adapter_id}")
    return _registry[adapter_id]


def get_active_adapter_id() -> str:
    with _lock:
        return "router"


def set_active_adapter(adapter_id: str) -> str:
    """Change the router's fallback adapter."""
    key = str(adapter_id or "").strip()
    if key not in _registry:
        raise KeyError(f"unknown adapter: {key}")
    with _lock:
        _router.fallback_id = key
        return key


def get_default_adapter():
    """Return the AdapterRouter (always)."""
    return _router


def get_active_adapter_info() -> dict:
    return {
        "adapterId": "router",
        "fallbackAdapter": _router.fallback_id,
        "adapters": sorted(_registry.keys()),
        **_caps_dict(_router.report_capabilities()),
    }


def get_capability_manifest() -> dict:
    manifest = {}
    for adapter_id, adapter in _registry.items():
        caps: AdapterCapabilities = adapter.report_capabilities()
        manifest[adapter_id] = _caps_dict(caps)
    return {
        "defaultAdapter": DEFAULT_ADAPTER_ID,
        "activeAdapter": "router",
        "fallbackAdapter": _router.fallback_id,
        "adapters": manifest,
    }
