"""Agent adapter layer (Phase 1 scaffold)."""

from backend.adapter.contract import (
    AdapterCapabilities,
    AdapterEvent,
    AgentAdapter,
)
from backend.adapter.registry import (
    get_active_adapter_id,
    get_active_adapter_info,
    get_adapter,
    get_capability_manifest,
    get_default_adapter,
    list_adapters,
    set_active_adapter,
)

__all__ = [
    "AgentAdapter",
    "AdapterCapabilities",
    "AdapterEvent",
    "get_adapter",
    "get_active_adapter_id",
    "get_active_adapter_info",
    "get_default_adapter",
    "get_capability_manifest",
    "list_adapters",
    "set_active_adapter",
]
