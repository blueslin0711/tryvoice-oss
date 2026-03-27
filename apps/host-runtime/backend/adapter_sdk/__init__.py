"""TryVoice Adapter SDK — protocol and types for building custom adapters."""

from .base import BaseAdapter
from .cli_base import CliAdapterBase, find_cli
from .config_types import BotInfo, ConfigField, CreateBotField
from .contract import (
    DELIVERY_MIRROR_PROVIDERS,
    AdapterCapabilities,
    AdapterError,
    AdapterEvent,
    AdapterEventType,
    AgentAdapter,
    ContentKind,
)
from .utils import MessageBuilder, chunk_text

__all__ = [
    # Base class (recommended for new adapters)
    "BaseAdapter",
    # CLI base class (for adapters that shell out to a CLI binary)
    "CliAdapterBase",
    "find_cli",
    # Protocol (structural typing contract)
    "AgentAdapter",
    # Types
    "AdapterCapabilities",
    "AdapterError",
    "AdapterEvent",
    "AdapterEventType",
    "ContentKind",
    # Config
    "ConfigField",
    "BotInfo",
    "CreateBotField",
    # Utilities
    "MessageBuilder",
    "chunk_text",
    # Internal
    "DELIVERY_MIRROR_PROVIDERS",
]
