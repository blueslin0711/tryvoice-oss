"""TTS Provider registry.

Built-in providers (edge, proxy) are always available. Third-party providers
are discovered via ``tryvoice.tts`` entry_points.

Selection: ``TRYVOICE_TTS_PROVIDER`` env var chooses the active provider.
"""

from __future__ import annotations

import importlib
import os

from loguru import logger

from backend.utils.entrypoints import get_entry_points
from backend.voice.tts_provider import TTSProvider

# ── Direct-import provider tables ───────────────────────────────────────

_BUILTIN_TTS: dict[str, str] = {
    "edge": "backend.voice.tts_edge:EdgeTTSProvider",
    "proxy": "backend.voice.tts_proxy:ProxyTTSProvider",
}


def _load_class(dotted_path: str):
    """Load a class from a 'module.path:ClassName' string."""
    module_path, cls_name = dotted_path.rsplit(":", 1)
    mod = importlib.import_module(module_path)
    return getattr(mod, cls_name)


# ── Built-in provider factories ──────────────────────────────────────────


def _make_edge() -> TTSProvider:
    cls = _load_class(_BUILTIN_TTS["edge"])
    return cls()


def _make_proxy() -> TTSProvider:
    cp_url = os.getenv("VS_CONTROL_PLANE_URL", "").strip()
    cp_token = os.getenv("VS_CONTROL_PLANE_HOST_TOKEN", "").strip()
    cls = _load_class(_BUILTIN_TTS["proxy"])
    return cls(cp_url, cp_token)


_BUILTIN_FACTORIES: dict[str, callable] = {
    "edge": _make_edge,
    "proxy": _make_proxy,
}

DEFAULT_TTS = "edge"

# ── Discovery via entry_points ───────────────────────────────────────────

_discovered_extra: dict[str, str] = {}

for _ep in get_entry_points("tryvoice.tts"):
    if _ep.name in _BUILTIN_FACTORIES:
        continue  # built-in takes precedence
    try:
        _ep.load()  # probe import
        _discovered_extra[_ep.name] = _ep.value
        logger.info(f"TTS provider available (plugin): {_ep.name} -> {_ep.value}")
    except Exception as _exc:
        logger.warning(f"Failed to load TTS plugin '{_ep.name}': {_exc}")


def _make_provider(name: str) -> TTSProvider:
    """Instantiate a TTS provider by name."""
    if name in _BUILTIN_FACTORIES:
        return _BUILTIN_FACTORIES[name]()
    path = _discovered_extra.get(name)
    if path is None:
        raise KeyError(f"Unknown TTS provider: {name}")
    cls = _load_class(path)
    return cls()


# ── Active provider ──────────────────────────────────────────────────────


def _resolve_active() -> TTSProvider:
    name = os.getenv("TRYVOICE_TTS_PROVIDER", DEFAULT_TTS).strip() or DEFAULT_TTS
    try:
        provider = _make_provider(name)
        logger.info(f"TTS provider: {name} ({provider.provider_name()})")
        return provider
    except Exception as exc:
        logger.warning(f"TTS provider '{name}' failed to load: {exc}. Falling back to '{DEFAULT_TTS}'.")
        return _BUILTIN_FACTORIES[DEFAULT_TTS]()


_provider: TTSProvider = _resolve_active()


def get_tts_provider() -> TTSProvider:
    """Return the currently active TTS provider."""
    return _provider


def set_tts_provider(provider: TTSProvider) -> None:
    """Replace the active TTS provider (for testing or plugin swap)."""
    global _provider
    _provider = provider


# ── Introspection (for --check and startup logs) ─────────────────────────


def list_tts_providers() -> list[str]:
    """Return names of all available TTS providers (built-in + discovered)."""
    return sorted(set(list(_BUILTIN_FACTORIES.keys()) + list(_discovered_extra.keys())))


def get_active_tts_info() -> dict:
    """Return info about the active TTS provider for diagnostics."""
    name = os.getenv("TRYVOICE_TTS_PROVIDER", DEFAULT_TTS).strip() or DEFAULT_TTS
    return {
        "active": name,
        "providerName": _provider.provider_name(),
        "discovered": list_tts_providers(),
    }
