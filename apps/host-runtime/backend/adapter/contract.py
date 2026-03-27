"""Re-export adapter SDK types for backward compatibility."""

from backend.adapter_sdk.config_types import BotInfo, ConfigField, CreateBotField  # noqa: F401
from backend.adapter_sdk.contract import (  # noqa: F401
    DELIVERY_MIRROR_PROVIDERS,
    AdapterCapabilities,
    AdapterEvent,
    AdapterEventType,
    AgentAdapter,
)
