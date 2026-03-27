"""Configuration and bot discovery types for the unified adapter config framework."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ConfigField:
    """A single configuration parameter an adapter needs."""

    name: str
    label: str
    field_type: str  # "string" | "password" | "url" | "number" | "select" | "boolean"
    required: bool = True
    default: str | None = None
    description: str = ""
    options: list[str] | None = None
    group: str = "connection"  # "connection" | "model" | "advanced"


@dataclass(frozen=True)
class BotInfo:
    """A discovered or created bot instance."""

    bot_id: str
    name: str
    session_key: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CreateBotField:
    """A parameter needed to create a new bot."""

    name: str
    label: str
    field_type: str
    required: bool = True
    default: str | None = None
    description: str = ""
    options: list[str] | None = None
