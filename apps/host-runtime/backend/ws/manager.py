"""
WebSocket connection pool, broadcast, and global bot processing state.

All state and logic has been moved to ``backend.runtime.state``
and ``backend.ws.connection_registry``.
This module re-exports everything for backward compatibility.
"""

from backend.runtime.state import (  # noqa: F401
    _BOT_PROCESSING_STALE_SEC,
    _bot_processing_lock,
    _bot_processing_state,
    broadcast_bot_event,
    broadcast_history_revision,
    get_bot_processing_states,
    set_bot_processing,
)
from backend.ws.connection_registry import registry  # noqa: F401
