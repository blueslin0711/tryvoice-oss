"""Adapter contract for integrating external Agent backends."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Literal, Protocol

from .config_types import BotInfo, ConfigField, CreateBotField

AdapterEventType = Literal[
    "assistant_delta",
    "assistant_final",
    "needs_user_input",  # Agent is blocked waiting for user input
    "tool_start",
    "tool_end",
    "state_changed",
    "slot_switched",
    "error",
    "needs_auth",
    "session_closed",
]

ContentKind = Literal[
    "result",  # Final answer — always displayed and TTS'd
    "thinking",  # Model reasoning / chain-of-thought
    "tool_call",  # Tool invocation
    "intermediate",  # Intermediate step text (catch-all)
]


# Provider names used in delivery-mirror detection (gateway-specific data values).
# Populated by adapter-specific modules (e.g. openclaw_adapter) at import time.
DELIVERY_MIRROR_PROVIDERS: set[str] = set()


@dataclass(frozen=True)
class AdapterCapabilities:
    supports_stream: bool = True
    supports_cancel: bool = False
    supports_session_resume: bool = True
    supports_multi_slot: bool = False
    supports_tool_events: bool = False
    supports_remote_history: bool = True
    supports_streaming_turn: bool = False
    supports_discovery: bool = False
    supports_creation: bool = False
    ephemeral_sessions: bool = False
    has_watcher: bool = False  # adapter has its own JSONL/file watcher for history sync
    # Sync hints — adapter-driven sync policy
    reconnect_burst_sync_ms: int = 0  # 0 = no burst; >0 = burst interval on reconnect
    reconnect_burst_duration_ms: int = 0  # how long to burst after reconnect
    # Turn lifecycle hints — per-adapter timing profile
    turn_initial_grace_seconds: int = 30  # grace period before idle check
    turn_idle_timeout_seconds: int = 120  # no-output = stuck
    turn_max_timeout_seconds: int = 0  # hard limit (0 = no limit)
    processing_timeout_hint_ms: int = 180_000  # frontend processing timeout


@dataclass(frozen=True)
class AdapterError:
    """Structured error returned by adapter methods.

    Preferred over embedding error strings in normal responses.
    Callers can inspect *code* and *retryable* for programmatic handling.
    """

    code: str  # e.g. "auth_failed", "rate_limited", "timeout", "connection_error"
    message: str
    retryable: bool = False
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class AdapterEvent:
    type: AdapterEventType
    bot_id: str
    text: str = ""
    content_kind: ContentKind = "result"
    payload: dict[str, Any] = field(default_factory=dict)


class AgentAdapter(Protocol):
    """Minimal contract for all Agent adapters."""

    async def connect(self) -> bool: ...

    async def authenticate(self) -> bool: ...

    async def send_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
    ) -> str: ...

    async def stream_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
    ) -> AsyncIterator[AdapterEvent]:
        """Stream the LLM response in real-time as it is generated.

        Yields ``assistant_delta`` events at sentence/chunk boundaries and
        a final ``assistant_final`` event when the response is complete.

        Adapters that set ``supports_streaming_turn=True`` in their
        capabilities SHOULD implement this method.  The default
        implementation (in BaseAdapter) falls back to ``send_user_turn``
        wrapped in a single ``assistant_final`` event.
        """
        ...

    async def stream_assistant_output(
        self,
        *,
        bot_id: str,
        text: str,
    ) -> AsyncIterator[AdapterEvent]: ...

    async def cancel(self, *, bot_id: str, turn_id: str | None = None) -> bool: ...

    async def switch_slot(self, *, slot_id: str) -> bool: ...

    async def fetch_history(self, *, session_key: str, limit: int = 100) -> list[dict[str, Any]]: ...

    async def resume_session(self, *, session_key: str) -> bool: ...

    async def reset_session(self, *, session_key: str) -> bool:
        """Reset (clear) the current session so the next turn starts fresh."""
        ...

    async def poll_events(self, *, session_key: str, limit: int = 30) -> list[dict[str, Any]]:
        """Poll for intermediate events (e.g. toolUse steps) during an active turn."""
        ...

    def report_capabilities(self) -> AdapterCapabilities: ...

    def slash_commands(self, session_key: str = "") -> list[dict[str, Any]]:
        """Return slash commands available for this adapter/session."""
        return []

    @classmethod
    def config_schema(cls) -> list[ConfigField]:
        """Declare configuration parameters this adapter needs."""
        ...

    @classmethod
    def create_bot_schema(cls) -> list[CreateBotField]:
        """Declare parameters needed to create a new bot."""
        ...

    def apply_config(self, config: dict[str, Any]) -> None:
        """Apply configuration from ConfigStore at runtime."""
        ...

    async def discover_bots(self) -> list[BotInfo]:
        """Discover existing bots/sessions. Returns [] if not supported."""
        ...

    async def create_bot(self, *, params: dict[str, Any]) -> BotInfo:
        """Create a new bot. Raises NotImplementedError if not supported."""
        ...

    async def pre_warm(self, *, session_key: str) -> None:
        """Pre-initialize resources when a slot becomes active.

        Called on browser connect (GET /slots) and after wizard bot creation.
        Must be idempotent — may be called multiple times for the same session_key.
        Default: no-op.
        """
        ...

    async def on_slot_removed(self, *, session_key: str) -> None:
        """Release resources when a slot is deleted by the user.

        Called before the slot is removed from the registry.
        Default: no-op.
        """
        ...

    async def get_session_status(self, *, session_key: str) -> str:
        """Return the current connection status for a session.

        Called periodically by the frontend status polling endpoint.
        Each adapter defines what "connected" means for its own protocol:
          - Claude Code: tmux alive + Claude TUI prompt ready
          - OpenClaw:    agent process reachable / WebSocket open
          - API-based:   API endpoint reachable (or stateless → always connected)

        Return values:
          "connected"    — session is alive and ready to receive messages
          "warming"      — session is starting up / loading state
          "disconnected" — session is not running or unreachable

        Default: "connected" — stateless / API-based adapters need not override.
        """
        ...
