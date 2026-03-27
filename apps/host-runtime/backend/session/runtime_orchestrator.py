"""Runtime session orchestrator with turn FSM, retry and timeout controls."""

from __future__ import annotations

import asyncio
import hashlib
import os
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from loguru import logger

from backend.adapter.registry import get_default_adapter
from backend.protocol.constants import MsgType
from backend.session.activity_monitor import TurnActivityMonitor
from backend.session.orchestrator import SessionOrchestrator, WSMessageSender
from backend.session.turn_fsm import TurnFSM, TurnState

# Activity-aware idle timeout constants
TURN_INITIAL_GRACE_SECONDS = float(os.getenv("TURN_INITIAL_GRACE_SECONDS", "600"))
TURN_IDLE_TIMEOUT_SECONDS = float(os.getenv("TURN_IDLE_TIMEOUT_SECONDS", "300"))
TURN_MAX_TIMEOUT_SECONDS = float(os.getenv("TURN_MAX_TIMEOUT_SECONDS", "0"))  # 0 = no hard limit
# After this many seconds of elapsed time, push a "stale" status to the
# frontend so the bot card can show a warning icon.  Does NOT cancel the turn.
TURN_STALE_WARNING_SECONDS = float(os.getenv("TURN_STALE_WARNING_SECONDS", "600"))
TURN_RETRY_MAX = 1
TURN_DEDUP_TTL_SECONDS = 5 * 60
TURN_DEDUP_MAX = 8000
TURN_STALE_RECOVER_SECONDS = 660.0


@dataclass
class _ActiveTurn:
    bot_id: str
    turn_id: str
    task: asyncio.Task | None
    started_monotonic: float
    client_msg_id: str
    source: str
    adapter: Any
    ws_send_id: int = 0  # id(ws_send) — identifies originating connection
    recovered: bool = False  # True for turns recovered after backend restart


class RuntimeSessionOrchestrator(SessionOrchestrator):
    """Phase 3 orchestrator that manages turn lifecycle via FSM."""

    def __init__(
        self,
        *,
        retry_max: int = TURN_RETRY_MAX,
    ):
        self._retry_max = max(0, int(retry_max))
        self._fsm = TurnFSM()
        self._adapter = get_default_adapter()
        self._turn_seen: "OrderedDict[str, float]" = OrderedDict()
        self._turn_seen_lock = asyncio.Lock()
        self._active_turns: dict[str, _ActiveTurn] = {}
        self._active_turns_lock = asyncio.Lock()
        self._recovery_done = False

    def set_adapter(self, adapter: Any) -> None:
        """Update adapter used for new turns."""
        self._adapter = adapter

    @property
    def adapter(self):
        """Return the currently active adapter instance."""
        return self._adapter

    async def _mark_or_reject_duplicate_turn(
        self,
        *,
        bot_id: str,
        source: str,
        client_msg_id: str,
        user_text: str,
    ) -> bool:
        msg_id = str(client_msg_id or "").strip()
        if msg_id:
            turn_key = f"{bot_id}:{source}:{msg_id}"
        else:
            # Best effort for clients that do not send msgId.
            digest = hashlib.sha1(user_text.encode("utf-8")).hexdigest()[:20]
            turn_key = f"{bot_id}:{source}:noid:{digest}"
        now = asyncio.get_running_loop().time()
        async with self._turn_seen_lock:
            while self._turn_seen:
                first_key = next(iter(self._turn_seen))
                if self._turn_seen[first_key] > now:
                    break
                self._turn_seen.popitem(last=False)
            expires = self._turn_seen.get(turn_key)
            if expires and expires > now:
                return True
            self._turn_seen[turn_key] = now + TURN_DEDUP_TTL_SECONDS
            self._turn_seen.move_to_end(turn_key)
            while len(self._turn_seen) > TURN_DEDUP_MAX:
                self._turn_seen.popitem(last=False)
            return False

    async def _emit_fsm_state(self, *, ws_send: WSMessageSender, bot_id: str, snapshot: dict[str, Any]) -> None:
        await ws_send(
            {
                "type": MsgType.TURN_STATE,
                "botId": bot_id,
                "state": snapshot.get("state", ""),
                "turnId": snapshot.get("turn_id", ""),
                "attempts": int(snapshot.get("attempts", 0)),
                "lastError": snapshot.get("last_error", ""),
            }
        )

    async def start_turn(
        self,
        *,
        user_text: str,
        bot_id: str,
        source: str,
        client_msg_id: str,
        ws_send: WSMessageSender,
        current_bot_id: str,
        bot_voices: dict[str, str],
        bot_tts_rates: dict[str, str],
        recent_bot_replies: dict[str, dict[str, Any]],
        history_store: Any,
    ) -> None:
        recovered = await self._fsm.recover_stale(stale_seconds=TURN_STALE_RECOVER_SECONDS)
        for snap in recovered:
            await self._emit_fsm_state(ws_send=ws_send, bot_id=str(snap.get("bot_id", bot_id)), snapshot=snap)

        if await self._mark_or_reject_duplicate_turn(
            bot_id=bot_id,
            source=source,
            client_msg_id=client_msg_id,
            user_text=user_text,
        ):
            logger.bind(component="session.orchestrator", bot_id=bot_id).warning(
                "duplicate turn rejected by orchestrator (msgId={})",
                client_msg_id,
            )
            await ws_send(
                {
                    "type": MsgType.STATUS,
                    "text": "重复消息已忽略",
                    "botId": bot_id,
                }
            )
            return

        turn_id = f"{bot_id}-{uuid.uuid4().hex[:12]}"
        snap = await self._fsm.begin_turn(
            bot_id=bot_id,
            turn_id=turn_id,
            source=source,
            client_msg_id=client_msg_id,
        )
        await self._emit_fsm_state(ws_send=ws_send, bot_id=bot_id, snapshot=snap)

        if source == "audio":
            snap = await self._fsm.transition(bot_id=bot_id, turn_id=turn_id, next_state=TurnState.TRANSCRIBING)
            await self._emit_fsm_state(ws_send=ws_send, bot_id=bot_id, snapshot=snap)

        snap = await self._fsm.transition(bot_id=bot_id, turn_id=turn_id, next_state=TurnState.STREAMING)
        await self._emit_fsm_state(ws_send=ws_send, bot_id=bot_id, snapshot=snap)

        last_error = ""
        success = False
        async with self._active_turns_lock:
            self._active_turns[turn_id] = _ActiveTurn(
                bot_id=bot_id,
                turn_id=turn_id,
                task=asyncio.current_task(),
                started_monotonic=asyncio.get_running_loop().time(),
                client_msg_id=client_msg_id,
                source=source,
                adapter=self._adapter,
                ws_send_id=id(ws_send),
            )

        adapter = self._adapter
        clear_cancel = getattr(adapter, "clear_cancel", None)
        if callable(clear_cancel):
            clear_cancel(bot_id)

        try:
            for attempt in range(1, self._retry_max + 2):
                snap = await self._fsm.set_attempts(bot_id=bot_id, turn_id=turn_id, attempts=attempt)
                await self._emit_fsm_state(ws_send=ws_send, bot_id=bot_id, snapshot=snap)
                try:
                    from backend.session.turn_executor import process_bot_message

                    monitor = TurnActivityMonitor()
                    monitor.start()
                    monitored_ws_send = monitor.wrap_ws_send(ws_send)

                    turn_task = asyncio.create_task(
                        process_bot_message(
                            user_text=user_text,
                            bot_id=bot_id,
                            source=source,
                            client_msg_id=client_msg_id,
                            ws_send=monitored_ws_send,
                            current_bot_id=current_bot_id,
                            bot_voices=bot_voices,
                            bot_tts_rates=bot_tts_rates,
                            recent_bot_replies=recent_bot_replies,
                            history_store=history_store,
                            activity_monitor=monitor,
                        )
                    )

                    # Per-adapter turn timeouts (env vars serve as fallback)
                    try:
                        from backend.runtime.slot_registry import require_slot

                        _slot_cfg = require_slot(bot_id)
                        _session_key = _slot_cfg.get("sessionKey", "")
                    except Exception:
                        _session_key = ""
                    _caps = (
                        adapter.capabilities_for(_session_key)
                        if hasattr(adapter, "capabilities_for")
                        else adapter.report_capabilities()
                    )
                    _initial_grace = float(
                        getattr(_caps, "turn_initial_grace_seconds", 0) or TURN_INITIAL_GRACE_SECONDS
                    )
                    _idle_timeout = float(getattr(_caps, "turn_idle_timeout_seconds", 0) or TURN_IDLE_TIMEOUT_SECONDS)
                    _max_timeout = float(getattr(_caps, "turn_max_timeout_seconds", 0) or TURN_MAX_TIMEOUT_SECONDS)

                    # Watchdog loop: check idle/elapsed instead of hard timeout
                    _stale_warned = False
                    while not turn_task.done():
                        await asyncio.sleep(5.0)
                        # Absolute upper bound (0 = disabled)
                        if _max_timeout > 0 and monitor.elapsed_seconds >= _max_timeout:
                            turn_task.cancel()
                            try:
                                await turn_task
                            except (asyncio.CancelledError, Exception):
                                pass
                            raise asyncio.TimeoutError()
                        # After initial grace period, check idle
                        if monitor.elapsed_seconds >= _initial_grace:
                            if monitor.idle_seconds >= _idle_timeout:
                                turn_task.cancel()
                                try:
                                    await turn_task
                                except (asyncio.CancelledError, Exception):
                                    pass
                                raise asyncio.TimeoutError()
                        # Stale warning: push "stale" status so frontend shows ⚠️
                        if not _stale_warned and monitor.elapsed_seconds >= TURN_STALE_WARNING_SECONDS:
                            _stale_warned = True
                            await ws_send({"type": MsgType.STATUS, "text": "stale", "botId": bot_id})
                        # Heartbeat only when silent for 15s+ (avoids overriding specific status messages)
                        # Use plain ws_send (not monitored_ws_send) so the watchdog heartbeat
                        # does NOT reset the idle timer — real adapter activity must do that.
                        elif monitor.idle_seconds >= 15.0:
                            await ws_send({"type": MsgType.STATUS, "text": "处理中...", "botId": bot_id})
                            await self._fsm.touch(bot_id=bot_id, turn_id=turn_id)

                    # Propagate any exception from the task
                    await turn_task
                    success = True
                    break
                except asyncio.CancelledError:
                    last_error = "turn cancelled"
                    break
                except asyncio.TimeoutError:
                    idle = monitor.idle_seconds if monitor else 0
                    elapsed = monitor.elapsed_seconds if monitor else 0
                    signals = monitor.signal_count if monitor else 0
                    last_error = f"turn idle timeout after {int(elapsed)}s (idle={int(idle)}s, signals={signals})"
                except Exception as exc:
                    last_error = str(exc)

                if attempt <= self._retry_max:
                    await ws_send(
                        {
                            "type": MsgType.STATUS,
                            "text": f"处理失败，正在重试({attempt}/{self._retry_max})...",
                            "botId": bot_id,
                        }
                    )
                    logger.bind(component="session.orchestrator", bot_id=bot_id).warning(
                        "retrying turn {}, attempt={}, error={}",
                        turn_id,
                        attempt,
                        last_error,
                    )

            if not success:
                is_cancelled = last_error == "turn cancelled"
                snap = await self._fsm.transition(
                    bot_id=bot_id,
                    turn_id=turn_id,
                    next_state=(TurnState.INTERRUPTED if is_cancelled else TurnState.ERROR),
                    error=last_error or "turn failed",
                )
                await self._emit_fsm_state(ws_send=ws_send, bot_id=bot_id, snapshot=snap)
                if is_cancelled:
                    await ws_send(
                        {
                            "type": MsgType.TURN_CANCELLED,
                            "botId": bot_id,
                            "turnId": turn_id,
                            "mode": "generation_cancelled",
                        }
                    )
                else:
                    await ws_send(
                        {
                            "type": MsgType.RESPONSE,
                            "text": f"处理失败: {last_error or 'unknown error'}",
                            "botId": bot_id,
                        }
                    )
            else:
                snap = await self._fsm.transition(bot_id=bot_id, turn_id=turn_id, next_state=TurnState.SPEAKING)
                await self._emit_fsm_state(ws_send=ws_send, bot_id=bot_id, snapshot=snap)
        finally:
            async with self._active_turns_lock:
                self._active_turns.pop(turn_id, None)
            snap = await self._fsm.finish_turn(bot_id=bot_id, turn_id=turn_id)
            await self._emit_fsm_state(ws_send=ws_send, bot_id=bot_id, snapshot=snap)

    async def request_cancel(
        self,
        *,
        bot_id: str,
        ws_send: WSMessageSender,
        turn_id: str = "",
        reason: str = "user",
    ) -> dict[str, Any]:
        _ = reason
        caller_id = id(ws_send)
        active: _ActiveTurn | None = None
        async with self._active_turns_lock:
            if turn_id:
                # Direct lookup by turn_id
                active = self._active_turns.get(turn_id)
            else:
                # Find the caller's own active turn for this bot
                for t in self._active_turns.values():
                    if t.bot_id == bot_id and t.ws_send_id == caller_id:
                        active = t
                        break
                # Fallback: cancel the most recent turn for this bot (any client)
                if not active:
                    for t in self._active_turns.values():
                        if t.bot_id == bot_id:
                            active = t
        if not active:
            return {
                "ok": False,
                "botId": bot_id,
                "active": False,
                "supportsCancel": bool(self._adapter.report_capabilities().supports_cancel),
                "mode": "tts_only_stop",
                "reason": "no_active_turn",
            }
        if turn_id and active.turn_id != turn_id:
            return {
                "ok": False,
                "botId": bot_id,
                "active": False,
                "supportsCancel": bool(self._adapter.report_capabilities().supports_cancel),
                "mode": "tts_only_stop",
                "reason": "turn_mismatch",
            }

        started = asyncio.get_running_loop().time()
        adapter = active.adapter
        caps = adapter.report_capabilities()
        supports_cancel = bool(caps.supports_cancel)
        adapter_result = False
        mode = "tts_only_stop"
        if supports_cancel:
            adapter_result = bool(await adapter.cancel(bot_id=bot_id, turn_id=active.turn_id))
            mode = "generation_cancelled" if adapter_result else "tts_only_stop"
            if active.task and not active.task.done():
                active.task.cancel()

        snap = await self._fsm.transition(
            bot_id=bot_id,
            turn_id=active.turn_id,
            next_state=TurnState.INTERRUPTED,
            error="user_cancelled",
        )
        await self._emit_fsm_state(ws_send=ws_send, bot_id=bot_id, snapshot=snap)
        if mode == "generation_cancelled":
            await ws_send({"type": MsgType.STATUS, "text": "已取消生成", "botId": bot_id})
        else:
            await ws_send({"type": MsgType.STATUS, "text": "仅停止朗读（当前连接不支持真 cancel）", "botId": bot_id})

        snap = await self._fsm.finish_turn(bot_id=bot_id, turn_id=active.turn_id)
        await self._emit_fsm_state(ws_send=ws_send, bot_id=bot_id, snapshot=snap)
        latency_ms = int((asyncio.get_running_loop().time() - started) * 1000)
        return {
            "ok": True,
            "botId": bot_id,
            "active": True,
            "turnId": active.turn_id,
            "supportsCancel": supports_cancel,
            "adapterResult": adapter_result,
            "mode": mode,
            "latencyMs": latency_ms,
        }

    async def recover_active_turns(self) -> int:
        """Scan tmux sessions to recover active turns lost during backend restart.

        Asks the adapter (if it supports ``scan_recovering_turns``) to detect
        tmux sessions where Claude Code is actively processing (not at the
        input prompt).  Creates synthetic ``_ActiveTurn`` entries so that
        ``get_active_turns_summary`` reports them to the frontend.

        Returns the number of recovered turns.
        """
        if self._recovery_done:
            return 0
        self._recovery_done = True

        adapter = self._adapter
        scan_fn = getattr(adapter, "scan_recovering_turns", None)
        if not callable(scan_fn):
            return 0

        _log = logger.bind(component="session.orchestrator")
        try:
            active_turns = await scan_fn()
        except Exception as exc:
            _log.warning("Failed to scan recovering turns: {}", exc)
            return 0

        if not active_turns:
            return 0

        now = asyncio.get_running_loop().time()
        count = 0
        async with self._active_turns_lock:
            for turn_info in active_turns:
                bot_id = turn_info["bot_id"]
                turn_id = f"recovered-{bot_id}-{uuid.uuid4().hex[:8]}"
                self._active_turns[turn_id] = _ActiveTurn(
                    bot_id=bot_id,
                    turn_id=turn_id,
                    task=None,
                    started_monotonic=now,
                    client_msg_id="",
                    source="recovered",
                    adapter=adapter,
                    ws_send_id=0,
                    recovered=True,
                )
                count += 1
                _log.info(
                    "Recovered active turn: bot_id={}, turn_id={}",
                    bot_id,
                    turn_id,
                )

        if count:
            # Start a background task to clean up recovered turns when they
            # finish (Claude returns to the prompt).
            asyncio.ensure_future(self._poll_recovered_turns())

        _log.info("Recovered {} active turn(s) after backend restart", count)
        return count

    async def _poll_recovered_turns(self) -> None:
        """Background poller that removes recovered turns once Claude is idle.

        Checks every 10 seconds whether the adapter still reports the bot's
        tmux session as processing.  When it stops, removes the synthetic
        ``_ActiveTurn`` entry.
        """
        _log = logger.bind(component="session.orchestrator")
        while True:
            await asyncio.sleep(10.0)
            async with self._active_turns_lock:
                recovered = [t for t in self._active_turns.values() if t.recovered]
                if not recovered:
                    _log.debug("All recovered turns have been cleaned up")
                    return

            # Re-scan to see which turns are still active
            adapter = self._adapter
            scan_fn = getattr(adapter, "scan_recovering_turns", None)
            if not callable(scan_fn):
                # Adapter changed or doesn't support scanning; clean up all
                async with self._active_turns_lock:
                    for t in list(self._active_turns.values()):
                        if t.recovered:
                            self._active_turns.pop(t.turn_id, None)
                return

            try:
                still_active = await scan_fn()
            except Exception:
                continue

            still_active_bots = {t["bot_id"] for t in still_active}
            async with self._active_turns_lock:
                for t in list(self._active_turns.values()):
                    if t.recovered and t.bot_id not in still_active_bots:
                        self._active_turns.pop(t.turn_id, None)
                        _log.info(
                            "Recovered turn completed: bot_id={}, turn_id={}",
                            t.bot_id,
                            t.turn_id,
                        )

    async def get_active_turns_summary(self) -> list[dict]:
        """Return summary of all currently active turns."""
        if not self._recovery_done:
            await self.recover_active_turns()
        async with self._active_turns_lock:
            now = asyncio.get_running_loop().time()
            return [
                {
                    "botId": t.bot_id,
                    "turnId": t.turn_id,
                    "elapsedSec": round(now - t.started_monotonic, 1),
                    "source": t.source,
                }
                for t in self._active_turns.values()
            ]

    async def fsm_snapshot_all(self) -> dict[str, dict[str, Any]]:
        return await self._fsm.snapshot_all()
