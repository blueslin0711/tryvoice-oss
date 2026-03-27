"""SessionWatcher: JSONL file watcher with full-reread, Set dedup, and coalescing sync.

Replaces dual-path message sync with a single watcher that reads Claude Code
session JSONL files, deduplicates messages by UUID, detects text growth
(streaming updates), and emits callbacks for new/updated messages and turn events.

Inspired by Happy Coder's SessionScanner pattern.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Awaitable, Callable, Optional

from loguru import logger

# Internal event types to filter out (not real conversation messages)
_INTERNAL_EVENT_TYPES = frozenset({"file-history-snapshot", "change", "queue-operation"})


class CoalescingSync:
    """Coalescing async sync runner.

    Ensures at most one instance of ``fn`` runs at a time.  If ``invalidate()``
    is called while ``fn`` is already running, one additional run is queued
    (further invalidations while queued are coalesced into that single run).
    """

    def __init__(self, fn: Callable[[], Awaitable[None]]) -> None:
        self._fn = fn
        self._running = False
        self._pending = False
        self._stopped = False
        self._waiters: list[asyncio.Future[None]] = []

    def invalidate(self) -> None:
        """Request a sync run.  Fire-and-forget."""
        if self._stopped:
            return
        if self._running:
            self._pending = True
        else:
            asyncio.ensure_future(self._run())

    async def invalidate_and_await(self) -> None:
        """Request a sync run and wait until it completes."""
        if self._stopped:
            return
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[None] = loop.create_future()
        self._waiters.append(fut)
        if self._running:
            self._pending = True
        else:
            asyncio.ensure_future(self._run())
        await fut

    def stop(self) -> None:
        """Stop accepting new invalidations."""
        self._stopped = True

    async def _run(self) -> None:
        self._running = True
        try:
            while True:
                self._pending = False
                try:
                    await self._fn()
                except Exception:
                    logger.opt(exception=True).warning("CoalescingSync: fn raised")
                # Resolve all current waiters
                waiters = self._waiters
                self._waiters = []
                for w in waiters:
                    if not w.done():
                        w.set_result(None)
                if not self._pending:
                    break
        finally:
            self._running = False


class SessionWatcher:
    """Watches Claude Code session JSONL files and emits message/turn callbacks.

    Core design:
    - Full-reread: reads entire JSONL file on each sync (files are append-only,
      typically <10MB).
    - Set dedup: ``_processed_keys`` (never cleared) tracks seen message UUIDs.
    - Text growth detection: compares current text with ``_last_text[key]`` to
      detect streaming updates (same UUID, longer text).
    - Coalescing sync: at most one sync runs at a time, with one queued.
    """

    def __init__(
        self,
        session_id: str,
        project_dir: Path,
        on_message_cb: Callable[[dict, bool], None],
        on_turn_event_cb: Callable[[str, dict], None],
    ) -> None:
        self._current_session_id: Optional[str] = session_id
        self._project_dir = Path(project_dir)
        self._on_message_cb = on_message_cb
        self._on_turn_event_cb = on_turn_event_cb

        # Dedup state
        self._processed_keys: set[str] = set()
        self._last_text: dict[str, str] = {}
        self._last_stop_reason: dict[str, str] = {}
        # Track fired turn events: key -> last stop_reason fired
        self._turn_event_fired: dict[str, str] = {}
        # Suppress turn event callbacks on the first sync (historical entries)
        self._initial_sync_done = False

        # Session lifecycle
        self._pending_sessions: set[str] = set()
        self._finished_sessions: set[str] = set()
        self._session_mtimes: dict[str, float] = {}  # session_id → last known mtime

        # Coalescing sync
        self._sync = CoalescingSync(self._sync_once)

        # Polling control
        self._poll_task: Optional[asyncio.Task[None]] = None
        self._stopped = False

    # -------------------------------------------------------------------
    # JSONL reading
    # -------------------------------------------------------------------

    def _read_session_log(self, session_id: str) -> list[dict]:
        """Read and parse a session JSONL file, filtering internal events.

        Returns list of valid parsed entries (dicts).
        """
        jsonl_path = self._project_dir / f"{session_id}.jsonl"
        if not jsonl_path.exists():
            return []

        entries: list[dict] = []
        try:
            with open(jsonl_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    # Filter internal event types
                    entry_type = entry.get("type", "")
                    if entry_type in _INTERNAL_EVENT_TYPES:
                        continue
                    entries.append(entry)
        except Exception as exc:
            logger.warning(f"Failed to read session JSONL {jsonl_path}: {exc}")

        return entries

    # -------------------------------------------------------------------
    # Message key generation
    # -------------------------------------------------------------------

    def _message_key(self, entry: dict) -> str:
        """Generate a dedup key for a JSONL entry.

        - user/assistant/system: use entry["uuid"]
        - summary: composite key from leafUuid + summary prefix
        - fallback: SHA1 hash of the entire entry
        """
        entry_type = entry.get("type", "")

        if entry_type in ("user", "assistant", "system"):
            uuid = entry.get("uuid")
            if uuid:
                return uuid

        if entry_type == "summary":
            leaf_uuid = entry.get("leafUuid", "")
            summary = entry.get("summary", "")[:50]
            return f"summary:{leaf_uuid}:{summary}"

        # Fallback: hash the entire entry
        return hashlib.sha1(json.dumps(entry, sort_keys=True).encode()).hexdigest()

    # -------------------------------------------------------------------
    # Text extraction
    # -------------------------------------------------------------------

    def _extract_text(self, entry: dict) -> str:
        """Extract text content from a JSONL entry.

        Handles both string content (user messages) and list content
        (assistant messages with text blocks).
        """
        msg = entry.get("message")
        if not msg:
            return ""

        content = msg.get("content", "")

        if isinstance(content, str):
            return content

        if isinstance(content, list):
            text_parts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
            return " ".join(text_parts)

        return ""

    # -------------------------------------------------------------------
    # Core sync
    # -------------------------------------------------------------------

    async def _sync_once(self) -> None:
        """Read all active sessions and emit callbacks for new/updated messages."""
        # Collect session IDs to scan
        session_ids: list[str] = []
        if self._current_session_id:
            session_ids.append(self._current_session_id)
        session_ids.extend(self._pending_sessions)

        # Also re-include finished sessions whose JSONL has been modified
        for sid in list(self._finished_sessions):
            jsonl_path = self._project_dir / f"{sid}.jsonl"
            if jsonl_path.exists():
                try:
                    mtime = jsonl_path.stat().st_mtime
                    prev_mtime = self._session_mtimes.get(sid, 0)
                    if mtime > prev_mtime:
                        session_ids.append(sid)
                except OSError:
                    pass

        pending_to_finish: set[str] = set()

        for sid in session_ids:
            entries = self._read_session_log(sid)

            # Track mtime after reading
            jsonl_path = self._project_dir / f"{sid}.jsonl"
            if jsonl_path.exists():
                try:
                    self._session_mtimes[sid] = jsonl_path.stat().st_mtime
                except OSError:
                    pass

            for entry in entries:
                key = self._message_key(entry)
                text = self._extract_text(entry)

                if key in self._processed_keys:
                    # Check for text growth OR stop_reason change
                    prev_text = self._last_text.get(key, "")
                    text_grew = text and text != prev_text and len(text) > len(prev_text)
                    # Detect stop_reason appearing (e.g. streaming → tool_use/end_turn)
                    sr = entry.get("message", {}).get("stop_reason", "") if entry.get("type") == "assistant" else ""
                    prev_sr = self._last_stop_reason.get(key, "")
                    sr_changed = sr and sr != prev_sr
                    if text_grew or sr_changed:
                        self._last_text[key] = text
                        if sr:
                            self._last_stop_reason[key] = sr
                        self._on_message_cb(entry, is_update=True)
                    # else: same text and stop_reason, skip
                else:
                    # New message
                    self._processed_keys.add(key)
                    if text:
                        self._last_text[key] = text
                    sr_init = (
                        entry.get("message", {}).get("stop_reason", "") if entry.get("type") == "assistant" else ""
                    )
                    if sr_init:
                        self._last_stop_reason[key] = sr_init
                    self._on_message_cb(entry, is_update=False)

                # Check turn events (only fire once per key+stop_reason)
                entry_type = entry.get("type", "")
                if entry_type == "assistant":
                    msg = entry.get("message", {})
                    raw_stop = msg.get("stop_reason")
                    # Claude Code JSONL uses None (null) for simple completions
                    # and "end_turn" for explicit end-of-turn. Both mean turn done.
                    stop_reason = raw_stop if isinstance(raw_stop, str) and raw_stop else ""
                    # Treat None/null as end_turn — the message is final.
                    is_end = raw_stop is None or stop_reason == "end_turn"
                    is_tool = stop_reason == "tool_use"
                    effective = "end_turn" if is_end else stop_reason
                    if effective and effective != self._turn_event_fired.get(key):
                        self._turn_event_fired[key] = effective
                        # Only fire callbacks after the initial sync to avoid
                        # flooding with events for historical entries.
                        if self._initial_sync_done:
                            if is_end:
                                self._on_turn_event_cb("turn_complete", entry)
                            elif is_tool:
                                self._on_turn_event_cb("tool_active", entry)

            # Mark pending sessions as finished after scanning
            if sid in self._pending_sessions:
                pending_to_finish.add(sid)

        # Move processed pending sessions to finished
        for sid in pending_to_finish:
            self._pending_sessions.discard(sid)
            self._finished_sessions.add(sid)

        self._initial_sync_done = True

    # -------------------------------------------------------------------
    # Session lifecycle
    # -------------------------------------------------------------------

    def on_new_session(self, new_session_id: str) -> None:
        """Handle arrival of a new session ID.

        - If same as current: no-op
        - If already in finished or pending: no-op
        - Otherwise: demote current to pending, set new as current
        """
        if new_session_id == self._current_session_id:
            return
        if new_session_id in self._finished_sessions:
            return
        if new_session_id in self._pending_sessions:
            return

        # Demote current to pending
        if self._current_session_id:
            self._pending_sessions.add(self._current_session_id)

        self._current_session_id = new_session_id
        self._sync.invalidate()

    # -------------------------------------------------------------------
    # Polling loop
    # -------------------------------------------------------------------

    async def start(self) -> None:
        """Start the async polling loop.

        Polls at 200ms interval with a 3s periodic fallback sync.
        """
        self._stopped = False
        self._poll_task = asyncio.create_task(self._poll_loop())

    async def _poll_loop(self) -> None:
        """Internal polling loop."""
        periodic_counter = 0
        while not self._stopped:
            try:
                await self._sync.invalidate_and_await()
            except Exception:
                logger.opt(exception=True).warning("SessionWatcher: sync error")

            periodic_counter += 1
            # 200ms poll interval; every 15 iterations (~3s) do a forced sync
            await asyncio.sleep(0.2)

            if periodic_counter >= 15:
                periodic_counter = 0
                self._sync.invalidate()

    async def stop(self) -> None:
        """Stop the polling loop and do a final sync."""
        self._stopped = True
        self._sync.stop()

        if self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass

        # Final sync
        try:
            await self._sync_once()
        except Exception:
            logger.opt(exception=True).warning("SessionWatcher: final sync error")

    async def cleanup(self) -> None:
        """Stop and clear all state."""
        await self.stop()
        self._processed_keys.clear()
        self._last_text.clear()
        self._last_stop_reason.clear()
        self._turn_event_fired.clear()
        self._initial_sync_done = False
        self._pending_sessions.clear()
        self._finished_sessions.clear()
        self._session_mtimes.clear()
        self._current_session_id = None
