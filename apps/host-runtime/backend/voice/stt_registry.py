"""STT Provider registry.

Built-in providers (groq, proxy) are always available. Third-party providers
are discovered via ``tryvoice.stt`` entry_points.

Selection: ``TRYVOICE_STT_PROVIDER`` env var chooses the active provider.
"""

from __future__ import annotations

import importlib
import os

from loguru import logger

from backend.utils.entrypoints import get_entry_points
from backend.voice.stt_provider import STTProvider

# ── Direct-import provider tables ───────────────────────────────────────

_BUILTIN_STT: dict[str, str] = {
    "groq": "backend.voice.stt_groq:GroqWhisperSTT",
    "whisper": "backend.voice.stt_whisper:LocalWhisperSTT",
    "proxy": "backend.voice.stt_proxy:ProxySTTProvider",
}


def _load_class(dotted_path: str):
    """Load a class from a 'module.path:ClassName' string."""
    module_path, cls_name = dotted_path.rsplit(":", 1)
    mod = importlib.import_module(module_path)
    return getattr(mod, cls_name)


# ── Built-in provider factories ──────────────────────────────────────────


def _make_groq() -> STTProvider:
    cls = _load_class(_BUILTIN_STT["groq"])
    return cls()


def _make_whisper() -> STTProvider:
    cls = _load_class(_BUILTIN_STT["whisper"])
    return cls()


def _make_proxy() -> STTProvider:
    cp_url = os.getenv("VS_CONTROL_PLANE_URL", "").strip()
    cp_token = os.getenv("VS_CONTROL_PLANE_HOST_TOKEN", "").strip()
    cls = _load_class(_BUILTIN_STT["proxy"])
    return cls(cp_url, cp_token)


def _faster_whisper_available() -> bool:
    """Check if faster-whisper is installed."""
    try:
        import faster_whisper  # noqa: F401

        return True
    except ImportError:
        return False


_BUILTIN_FACTORIES: dict[str, callable] = {
    "groq": _make_groq,
    "whisper": _make_whisper,
    "proxy": _make_proxy,
}

DEFAULT_STT = "groq"

# ── Discovery via entry_points ───────────────────────────────────────────

_discovered_extra: dict[str, str] = {}

for _ep in get_entry_points("tryvoice.stt"):
    if _ep.name in _BUILTIN_FACTORIES:
        continue  # built-in takes precedence
    try:
        _ep.load()  # probe import
        _discovered_extra[_ep.name] = _ep.value
        logger.info(f"STT provider available (plugin): {_ep.name} -> {_ep.value}")
    except Exception as _exc:
        logger.warning(f"Failed to load STT plugin '{_ep.name}': {_exc}")


def _make_provider(name: str) -> STTProvider:
    """Instantiate an STT provider by name."""
    if name in _BUILTIN_FACTORIES:
        return _BUILTIN_FACTORIES[name]()
    path = _discovered_extra.get(name)
    if path is None:
        raise KeyError(f"Unknown STT provider: {name}")
    cls = _load_class(path)
    return cls()


# ── Active provider ──────────────────────────────────────────────────────


def _resolve_active() -> STTProvider:
    env_val = os.getenv("TRYVOICE_STT_PROVIDER", "").strip()

    if env_val:
        name = env_val
    else:
        # Auto-detect: prefer groq if API key is set, else fall back to local whisper
        groq_key = os.getenv("GROQ_API_KEY", "").strip()
        if groq_key:
            name = "groq"
        elif _faster_whisper_available():
            name = "whisper"
        else:
            name = DEFAULT_STT

    try:
        provider = _make_provider(name)
        logger.info(f"STT provider: {name} ({provider.provider_name()})")
        return provider
    except Exception as exc:
        if name == "whisper":
            logger.warning(f"STT provider 'whisper' failed to load: {exc}. Falling back to '{DEFAULT_STT}'.")
            return _BUILTIN_FACTORIES[DEFAULT_STT]()
        logger.warning(f"STT provider '{name}' failed to load: {exc}. Falling back to '{DEFAULT_STT}'.")
        return _BUILTIN_FACTORIES[DEFAULT_STT]()


_provider: STTProvider = _resolve_active()


def get_stt_provider() -> STTProvider:
    """Return the currently active STT provider."""
    return _provider


def set_stt_provider(provider: STTProvider) -> None:
    """Replace the active STT provider (for testing or plugin swap)."""
    global _provider
    _provider = provider


def reinit_stt_provider() -> None:
    """Re-resolve and replace the active STT provider (after env change)."""
    global _provider
    _provider = _resolve_active()


# ── Introspection (for --check and startup logs) ─────────────────────────


def list_stt_providers() -> list[str]:
    """Return names of all available STT providers (built-in + discovered)."""
    return sorted(set(list(_BUILTIN_FACTORIES.keys()) + list(_discovered_extra.keys())))


def get_active_stt_info() -> dict:
    """Return info about the active STT provider for diagnostics."""
    name = os.getenv("TRYVOICE_STT_PROVIDER", DEFAULT_STT).strip() or DEFAULT_STT
    return {
        "active": name,
        "providerName": _provider.provider_name(),
        "discovered": list_stt_providers(),
    }
