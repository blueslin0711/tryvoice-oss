"""Recommended base class for new TryVoice adapters.

Subclass ``BaseAdapter`` and override only the methods you need.  At minimum,
implement the two abstract methods — ``send_user_turn`` and
``report_capabilities`` — and you have a working adapter.  All other protocol
methods have sensible defaults (return True, empty lists, or no-ops).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, AsyncIterator

from .config_types import BotInfo, ConfigField, CreateBotField
from .contract import AdapterCapabilities, AdapterEvent
from .utils import chunk_text


class BaseAdapter(ABC):
    """Abstract base class that implements the ``AgentAdapter`` protocol.

    Provides default no-op / passthrough implementations for every method so
    that concrete adapters only need to override the 3–5 methods relevant to
    their backend.  The two abstract methods that **must** be implemented are:

    * ``send_user_turn`` — execute a single user turn and return the reply.
    * ``report_capabilities`` — declare what features the adapter supports.
    """

    # ------------------------------------------------------------------
    # Abstract — must override
    # ------------------------------------------------------------------

    @abstractmethod
    async def send_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
    ) -> str:
        """Send a user message and return the complete assistant reply."""
        ...

    @abstractmethod
    def report_capabilities(self) -> AdapterCapabilities:
        """Return the capability flags for this adapter."""
        ...

    # ------------------------------------------------------------------
    # Defaults — override as needed
    # ------------------------------------------------------------------

    async def connect(self) -> bool:
        return True

    async def authenticate(self) -> bool:
        return True

    async def stream_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
    ) -> AsyncIterator[AdapterEvent]:
        reply = await self.send_user_turn(
            bot_id=bot_id,
            session_key=session_key,
            text=text,
            timeout_seconds=timeout_seconds,
        )
        yield AdapterEvent(type="assistant_final", bot_id=bot_id, text=reply)

    async def stream_assistant_output(
        self,
        *,
        bot_id: str,
        text: str,
    ) -> AsyncIterator[AdapterEvent]:
        chunks = chunk_text(text)
        if not chunks:
            yield AdapterEvent(type="assistant_final", bot_id=bot_id, text=text)
            return
        for i, chunk in enumerate(chunks):
            if i < len(chunks) - 1:
                yield AdapterEvent(type="assistant_delta", bot_id=bot_id, text=chunk)
            else:
                yield AdapterEvent(type="assistant_final", bot_id=bot_id, text=chunk)

    async def cancel(self, *, bot_id: str, turn_id: str | None = None) -> bool:
        return False

    async def switch_slot(self, *, slot_id: str) -> bool:
        return True

    async def fetch_history(self, *, session_key: str, limit: int = 100) -> list[dict[str, Any]]:
        return []

    async def resume_session(self, *, session_key: str) -> bool:
        return True

    async def reset_session(self, *, session_key: str) -> bool:
        return True

    async def poll_events(self, *, session_key: str, limit: int = 30) -> list[dict[str, Any]]:
        return []

    @classmethod
    def config_schema(cls) -> list[ConfigField]:
        return []

    @classmethod
    def create_bot_schema(cls) -> list[CreateBotField]:
        return []

    def apply_config(self, config: dict[str, Any]) -> None:
        pass

    async def discover_bots(self) -> list[BotInfo]:
        return []

    async def create_bot(self, *, params: dict[str, Any]) -> BotInfo:
        raise NotImplementedError

    async def pre_warm(self, *, session_key: str) -> None:
        pass

    async def on_slot_removed(self, *, session_key: str) -> None:
        pass

    async def get_session_status(self, *, session_key: str) -> str:
        return "connected"
