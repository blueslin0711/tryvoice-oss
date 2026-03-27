"""Configuration package — backward-compatible barrel re-export.

All existing ``from backend.config import X`` statements continue to work
through these re-exports. New code should import from the specific sub-module.
"""

import os as _os

from dotenv import load_dotenv

from backend.paths import ENV_PATH

load_dotenv(ENV_PATH, override=True)
logger_startup_msg = f"Config: {ENV_PATH}"

# Re-export everything for backward compatibility
from backend.config.access import *  # noqa: E402, F401, F403
from backend.config.core import *  # noqa: E402, F401, F403
from backend.config.telegram import *  # noqa: E402, F401, F403
from backend.config.voice import *  # noqa: E402, F401, F403

# Conditionally load OpenClaw config only when needed
_active_adapter = _os.getenv("TRYVOICE_ACTIVE_ADAPTER", "").strip()
_has_gateway = bool(_os.getenv("AGENT_GATEWAY_URL") or _os.getenv("OPENCLAW_GATEWAY_URL"))

if _active_adapter == "openclaw" or _has_gateway:
    try:
        from backend.config.openclaw import *  # noqa: F401, F403
    except ImportError:
        pass

# Ensure these symbols exist in echo mode (with empty defaults)
if "BOT_CONFIG" not in dir():
    BOT_CONFIG: dict = {}
    GATEWAY_URL: str = ""
    GATEWAY_TOKEN: str = ""
    SESSION_AGENT_ID: str = "main"
    SESSION_NAMESPACE: str = "voice-chat"
    SESSION_SCOPE: str = "shared"
    SESSION_SEND_TOOL_CANDIDATES: list = []
    SESSION_HISTORY_TOOL_CANDIDATES: list = []
