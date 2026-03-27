# apps/host-runtime/backend/config_migration.py
"""Migrate legacy .env adapter config to SQLite ConfigStore."""

from __future__ import annotations

from typing import Any

from backend.config_store import ConfigStore

# Map legacy env keys to config_schema field names per adapter type
_ENV_KEY_MAP: dict[str, dict[str, str]] = {
    "openai-compat": {
        "LLM_API_BASE_URL": "api_base_url",
        "LLM_API_KEY": "api_key",
        "LLM_MODEL": "model",
        "LLM_SYSTEM_PROMPT": "system_prompt",
        "LLM_MAX_HISTORY": "max_history",
        "LLM_TEMPERATURE": "temperature",
        "LLM_MAX_TOKENS": "max_tokens",
        "LLM_PRESET": "preset",
    },
    "openclaw": {
        "AGENT_GATEWAY_URL": "gateway_url",
        "AGENT_GATEWAY_TOKEN": "gateway_token",
    },
    "anthropic": {
        "ANTHROPIC_MODEL": "anthropic_model",
        "CLAUDE_CLI_PATH": "claude_cli_path",
        "LLM_SYSTEM_PROMPT": "system_prompt",
        "LLM_MAX_HISTORY": "max_history",
    },
}


def migrate_env_to_store(env: dict[str, str], store: ConfigStore) -> None:
    """One-time migration: if store is empty and .env has adapter config, migrate it."""
    existing = store.list_adapter_configs()
    if existing:
        return  # already has data, skip

    adapter_type = env.get("TRYVOICE_ACTIVE_ADAPTER", "").strip()
    if not adapter_type:
        return

    key_map = _ENV_KEY_MAP.get(adapter_type, {})
    config: dict[str, Any] = {}
    for env_key, field_name in key_map.items():
        value = env.get(env_key, "").strip()
        if value:
            config[field_name] = value

    if config or adapter_type:
        config_id = store.save_adapter_config(
            adapter_type=adapter_type,
            display_name=adapter_type,
            config=config,
        )
        store.set_active_adapter(config_id)
