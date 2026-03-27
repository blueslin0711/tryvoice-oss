"""Test harness for verifying adapter protocol compliance.

Usage in your adapter's test file::

    import pytest
    from backend.adapter_sdk.testing import AdapterConformanceSuite
    from my_adapter import MyAdapter

    class TestMyAdapter(AdapterConformanceSuite):
        @pytest.fixture
        def adapter(self):
            return MyAdapter()
"""

from __future__ import annotations

from abc import abstractmethod
from typing import Any

import pytest

from .contract import AdapterCapabilities, AdapterEvent


class AdapterConformanceSuite:
    """Mixin with protocol-compliance tests for any AgentAdapter implementation.

    Subclasses MUST provide an ``adapter`` pytest fixture that returns a
    fully-constructed adapter instance.
    """

    @pytest.fixture
    @abstractmethod
    def adapter(self) -> Any:
        raise NotImplementedError

    BOT_ID = "test-bot"
    SESSION_KEY = "test-session"

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def test_connect(self, adapter: Any) -> None:
        result = await adapter.connect()
        assert isinstance(result, bool)

    async def test_authenticate(self, adapter: Any) -> None:
        result = await adapter.authenticate()
        assert isinstance(result, bool)

    # ------------------------------------------------------------------
    # Capabilities
    # ------------------------------------------------------------------

    async def test_report_capabilities(self, adapter: Any) -> None:
        caps = adapter.report_capabilities()
        assert isinstance(caps, AdapterCapabilities)

    # ------------------------------------------------------------------
    # Turn execution
    # ------------------------------------------------------------------

    async def test_send_user_turn(self, adapter: Any) -> None:
        result = await adapter.send_user_turn(
            bot_id=self.BOT_ID,
            session_key=self.SESSION_KEY,
            text="hello",
        )
        assert isinstance(result, str)
        assert len(result) > 0

    async def test_stream_assistant_output(self, adapter: Any) -> None:
        events: list[AdapterEvent] = []
        async for event in adapter.stream_assistant_output(
            bot_id=self.BOT_ID,
            text="hello",
        ):
            assert isinstance(event, AdapterEvent)
            events.append(event)
        assert len(events) >= 1
        assert events[-1].type == "assistant_final"

    async def test_stream_user_turn(self, adapter: Any) -> None:
        events: list[AdapterEvent] = []
        async for event in adapter.stream_user_turn(
            bot_id=self.BOT_ID,
            session_key=self.SESSION_KEY,
            text="hello",
        ):
            assert isinstance(event, AdapterEvent)
            events.append(event)
        assert len(events) >= 1
        assert events[-1].type == "assistant_final"

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    async def test_cancel(self, adapter: Any) -> None:
        result = await adapter.cancel(bot_id=self.BOT_ID)
        assert isinstance(result, bool)

    async def test_switch_slot(self, adapter: Any) -> None:
        result = await adapter.switch_slot(slot_id="slot-1")
        assert isinstance(result, bool)

    async def test_fetch_history(self, adapter: Any) -> None:
        result = await adapter.fetch_history(session_key=self.SESSION_KEY)
        assert isinstance(result, list)

    async def test_resume_session(self, adapter: Any) -> None:
        result = await adapter.resume_session(session_key=self.SESSION_KEY)
        assert isinstance(result, bool)

    async def test_reset_session(self, adapter: Any) -> None:
        result = await adapter.reset_session(session_key=self.SESSION_KEY)
        assert isinstance(result, bool)

    async def test_poll_events(self, adapter: Any) -> None:
        result = await adapter.poll_events(session_key=self.SESSION_KEY)
        assert isinstance(result, list)

    # ------------------------------------------------------------------
    # Class-level schemas
    # ------------------------------------------------------------------

    async def test_config_schema(self, adapter: Any) -> None:
        result = type(adapter).config_schema()
        assert isinstance(result, list)

    async def test_create_bot_schema(self, adapter: Any) -> None:
        result = type(adapter).create_bot_schema()
        assert isinstance(result, list)

    # ------------------------------------------------------------------
    # Behavioural
    # ------------------------------------------------------------------

    async def test_session_isolation(self, adapter: Any) -> None:
        await adapter.send_user_turn(
            bot_id=self.BOT_ID,
            session_key="session-a",
            text="hello from a",
        )
        await adapter.send_user_turn(
            bot_id=self.BOT_ID,
            session_key="session-b",
            text="hello from b",
        )
        history_a = await adapter.fetch_history(session_key="session-a")
        history_b = await adapter.fetch_history(session_key="session-b")
        assert history_a != history_b or (history_a == [] and history_b == [])

    async def test_reset_clears_history(self, adapter: Any) -> None:
        await adapter.send_user_turn(
            bot_id=self.BOT_ID,
            session_key=self.SESSION_KEY,
            text="seed message",
        )
        await adapter.reset_session(session_key=self.SESSION_KEY)
        history = await adapter.fetch_history(session_key=self.SESSION_KEY)
        assert history == []
