"""Startup configuration validator.

Checks critical configuration values at boot and logs clear
warnings/errors with actionable fix suggestions.
"""

from __future__ import annotations

import os


def _issue(level: str, key: str, message: str, fix: str = "") -> dict:
    return {"level": level, "key": key, "message": message, "fix": fix}


def validate_config() -> list[dict]:
    """Return a list of configuration issues found at startup.

    Each issue is a dict with keys:
        level   – "error", "warning", or "info"
        key     – the environment variable name
        message – human-readable description
        fix     – actionable suggestion (empty string for info-level)
    """
    issues: list[dict] = []

    # 1. PORT must be a valid integer 1-65535
    raw_port = os.getenv("PORT")
    if raw_port is not None:
        try:
            port_val = int(raw_port)
            if not (1 <= port_val <= 65535):
                raise ValueError
        except (ValueError, TypeError):
            issues.append(
                _issue(
                    "error",
                    "PORT",
                    f"Invalid port value '{raw_port}' — must be an integer between 1 and 65535.",
                    "Set PORT to a valid port number, e.g. PORT=7860",
                )
            )

    # Determine which adapter is active
    active_adapter = os.getenv("TRYVOICE_ACTIVE_ADAPTER", "").strip()

    # 2. openai-compat adapter checks
    if active_adapter == "openai-compat":
        llm_base = os.getenv("LLM_API_BASE_URL")
        llm_model = os.getenv("LLM_MODEL")

        if not llm_base:
            issues.append(
                _issue(
                    "warning",
                    "LLM_API_BASE_URL",
                    "Not set — will default to http://localhost:11434/v1",
                    "Set LLM_API_BASE_URL to your OpenAI-compatible endpoint URL",
                )
            )

        if not llm_model:
            issues.append(
                _issue(
                    "warning",
                    "LLM_MODEL",
                    "Not set — will default to gpt-3.5-turbo",
                    "Set LLM_MODEL to the model name you want to use, e.g. LLM_MODEL=gpt-4",
                )
            )

        effective_model = llm_model or "gpt-3.5-turbo"
        effective_base = llm_base or "http://localhost:11434/v1"
        issues.append(
            _issue(
                "info",
                "TRYVOICE_ACTIVE_ADAPTER",
                f"openai-compat adapter will use model={effective_model} at {effective_base}",
            )
        )

    # 3. openclaw adapter checks
    elif active_adapter == "openclaw":
        if not os.getenv("AGENT_GATEWAY_URL"):
            issues.append(
                _issue(
                    "error",
                    "AGENT_GATEWAY_URL",
                    "Required for the openclaw adapter but not set.",
                    "Set AGENT_GATEWAY_URL to the gateway endpoint, e.g. AGENT_GATEWAY_URL=https://gateway.example.com",
                )
            )

        if not os.getenv("AGENT_GATEWAY_TOKEN"):
            issues.append(
                _issue(
                    "warning",
                    "AGENT_GATEWAY_TOKEN",
                    "Not set — gateway requests may fail without authentication.",
                    "Set AGENT_GATEWAY_TOKEN to your gateway auth token",
                )
            )

    # 4. SERVER_LOG_LEVEL must be valid
    valid_log_levels = {"DEBUG", "INFO", "WARNING", "ERROR"}
    raw_log_level = os.getenv("SERVER_LOG_LEVEL")
    if raw_log_level is not None:
        normalised = raw_log_level.strip().upper()
        if normalised not in valid_log_levels:
            issues.append(
                _issue(
                    "error",
                    "SERVER_LOG_LEVEL",
                    f"Invalid log level '{raw_log_level}' — must be one of {', '.join(sorted(valid_log_levels))}.",
                    "Set SERVER_LOG_LEVEL to DEBUG, INFO, WARNING, or ERROR",
                )
            )

    # 5. HISTORY_SYNC_INTERVAL_SECONDS must be numeric if set
    raw_sync_interval = os.getenv("HISTORY_SYNC_INTERVAL_SECONDS")
    if raw_sync_interval is not None:
        try:
            float(raw_sync_interval)
        except (ValueError, TypeError):
            issues.append(
                _issue(
                    "error",
                    "HISTORY_SYNC_INTERVAL_SECONDS",
                    f"Invalid value '{raw_sync_interval}' — must be a number.",
                    "Set HISTORY_SYNC_INTERVAL_SECONDS to a numeric value, e.g. 1.5",
                )
            )

    # 6. LLM_TEMPERATURE must be 0.0-2.0 if set
    raw_temperature = os.getenv("LLM_TEMPERATURE")
    if raw_temperature is not None:
        try:
            temp_val = float(raw_temperature)
            if not (0.0 <= temp_val <= 2.0):
                raise ValueError
        except (ValueError, TypeError):
            issues.append(
                _issue(
                    "error",
                    "LLM_TEMPERATURE",
                    f"Invalid value '{raw_temperature}' — must be a number between 0.0 and 2.0.",
                    "Set LLM_TEMPERATURE to a value between 0.0 and 2.0, e.g. LLM_TEMPERATURE=0.7",
                )
            )

    # 7. LLM_MAX_TOKENS must be positive integer if set
    raw_max_tokens = os.getenv("LLM_MAX_TOKENS")
    if raw_max_tokens is not None:
        try:
            max_tokens_val = int(raw_max_tokens)
            if max_tokens_val <= 0:
                raise ValueError
        except (ValueError, TypeError):
            issues.append(
                _issue(
                    "error",
                    "LLM_MAX_TOKENS",
                    f"Invalid value '{raw_max_tokens}' — must be a positive integer.",
                    "Set LLM_MAX_TOKENS to a positive integer, e.g. LLM_MAX_TOKENS=4096",
                )
            )

    # 8. LLM_TIMEOUT must be positive integer if set
    raw_timeout = os.getenv("LLM_TIMEOUT")
    if raw_timeout is not None:
        try:
            timeout_val = int(raw_timeout)
            if timeout_val <= 0:
                raise ValueError
        except (ValueError, TypeError):
            issues.append(
                _issue(
                    "error",
                    "LLM_TIMEOUT",
                    f"Invalid value '{raw_timeout}' — must be a positive integer (seconds).",
                    "Set LLM_TIMEOUT to a positive integer, e.g. LLM_TIMEOUT=30",
                )
            )

    return issues
