"""Base class for CLI-based adapters that invoke a local CLI binary.

Provides shared plumbing for:
- CLI binary discovery (env var → ``which`` → candidate paths)
- Subprocess execution (single-shot text and streaming JSONL)
- In-memory conversation history with trim
- Cancel via per-session asyncio.Event

Subclass ``CliAdapterBase`` and override at minimum:
- ``cli_name``              — display name for logs
- ``_build_cli_cmd``        — construct the CLI command list
- ``_build_stream_cmd``     — construct the streaming CLI command list
- ``_parse_stream_events``  — convert raw JSONL dicts into AdapterEvents
- ``report_capabilities``   — declare adapter capabilities
"""

from __future__ import annotations

import asyncio
import glob as _glob
import json
import os
import shutil
import sys
import time
from abc import abstractmethod
from pathlib import Path
from typing import Any, AsyncIterator

from loguru import logger

from .base import BaseAdapter
from .contract import AdapterEvent
from .utils import MessageBuilder

IS_WINDOWS = sys.platform == "win32"


def find_cli(
    name: str,
    *,
    env_var: str = "",
    candidates: list[str] | None = None,
) -> str:
    """Locate a CLI binary by *name*.

    Resolution order:
    1. Explicit path from environment variable *env_var* (if set).
    2. ``shutil.which(name)``
    3. Candidate paths (supports glob patterns like ``~/.nvm/versions/*/bin/X``).
    4. Falls back to bare *name* (will fail at exec time if not in PATH).
    """
    if env_var:
        explicit = os.getenv(env_var, "").strip()
        if explicit:
            return explicit

    found = shutil.which(name)
    if found:
        return found

    for candidate in candidates or []:
        matched = _glob.glob(candidate)
        for m in matched:
            if os.path.isfile(m) and os.access(m, os.X_OK):
                return m
        if not matched and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate

    return name


class CliAdapterBase(BaseAdapter):
    """Abstract base for adapters that shell out to a local CLI binary.

    Concrete subclasses must implement:
    - ``cli_name``             — human-readable CLI name (for logs)
    - ``_build_cli_cmd``       — build command list for single-shot invocation
    - ``_build_stream_cmd``    — build command list for streaming invocation
    - ``_parse_stream_events`` — translate raw CLI JSONL into AdapterEvents
    - ``report_capabilities``  — return AdapterCapabilities
    """

    # Subclass should set these in __init__ or as class attrs
    cli_name: str = "cli"

    def __init__(
        self,
        *,
        cli_path: str,
        model: str = "",
        system_prompt: str = "You are a helpful assistant.",
        max_history: int = 50,
        timeout: int = 120,
        provider: str = "cli",
    ) -> None:
        self._cli_path = cli_path
        self._model = model
        self._system_prompt = system_prompt
        self._max_history = max_history
        self._timeout = timeout

        self._msg_builder = MessageBuilder(provider=provider, model=model)
        self._sessions: dict[str, list[dict[str, str]]] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._active_procs: dict[str, asyncio.subprocess.Process] = {}

    # ------------------------------------------------------------------
    # CLI environment — override to strip nested env vars
    # ------------------------------------------------------------------

    def _clean_env(self) -> dict[str, str]:
        """Return a copy of os.environ suitable for CLI invocation.

        Override to remove environment variables that would confuse a
        nested CLI process (e.g. CLAUDECODE for Claude Code).
        """
        return os.environ.copy()

    # ------------------------------------------------------------------
    # Abstract — subclass must implement
    # ------------------------------------------------------------------

    @abstractmethod
    def _build_cli_cmd(self, prompt: str) -> list[str]:
        """Return the command list for a single-shot text invocation."""
        ...

    @abstractmethod
    def _build_stream_cmd(self, prompt: str) -> list[str]:
        """Return the command list for a streaming JSONL invocation."""
        ...

    @abstractmethod
    async def _parse_stream_events(
        self,
        raw_events: AsyncIterator[dict[str, Any]],
        *,
        bot_id: str,
        session_key: str,
    ) -> AsyncIterator[AdapterEvent]:
        """Convert raw CLI JSONL events into AdapterEvents.

        Must yield at least one ``assistant_final`` event at the end.
        """
        ...  # pragma: no cover
        # make it a generator
        if False:
            yield  # type: ignore[misc]

    # ------------------------------------------------------------------
    # History helpers
    # ------------------------------------------------------------------

    def _build_prompt(self, session_key: str, user_text: str) -> str:
        """Build a multi-turn prompt from in-memory history."""
        parts: list[str] = []
        if self._system_prompt:
            parts.append(f"[System]\n{self._system_prompt}\n")
        for entry in self._sessions.get(session_key, []):
            label = "User" if entry["role"] == "user" else "Assistant"
            parts.append(f"[{label}]\n{entry['content']}\n")
        parts.append(f"[User]\n{user_text}")
        return "\n".join(parts)

    def _trim_history(self, session_key: str) -> None:
        history = self._sessions.get(session_key)
        if history and len(history) > self._max_history:
            self._sessions[session_key] = history[-self._max_history :]

    def _record_turn(self, session_key: str, user_text: str, reply: str) -> None:
        """Append a user/assistant pair to in-memory history and trim."""
        session = self._sessions.setdefault(session_key, [])
        session.append({"role": "user", "content": user_text})
        session.append({"role": "assistant", "content": reply})
        self._trim_history(session_key)

    # ------------------------------------------------------------------
    # Subprocess runners
    # ------------------------------------------------------------------

    async def _run_cli(self, prompt: str, *, cwd: str | None = None) -> str:
        """Run CLI in single-shot mode and return the text output."""
        cmd = self._build_cli_cmd(prompt)
        env = self._clean_env()
        work_dir = cwd or str(Path.home())

        _log = logger.bind(component=f"adapter.{self.cli_name}")
        _log.info("CLI invoke: cmd={}, cwd={}", " ".join(cmd[:6]), work_dir)
        t0 = time.monotonic()

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=work_dir,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=self._timeout)
        except asyncio.TimeoutError:
            _log.error("CLI timeout after {}s", self._timeout)
            proc.kill()  # type: ignore[possibly-undefined]
            return f"[{self.cli_name} CLI timeout]"
        except FileNotFoundError:
            _log.error("CLI not found at: {}", self._cli_path)
            return f"[{self.cli_name} CLI not found at: {self._cli_path}]"
        except Exception as exc:
            _log.error("CLI spawn error: {}", exc)
            return f"[{self.cli_name} CLI error: {exc}]"

        elapsed = time.monotonic() - t0
        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace").strip()
            _log.error("CLI failed: exit={}, elapsed={:.1f}s, stderr={}", proc.returncode, elapsed, err[:500])
            return f"[{self.cli_name} CLI error (exit {proc.returncode}): {err[:300]}]"

        out = stdout.decode("utf-8", errors="replace").strip()
        _log.info("CLI ok: exit=0, elapsed={:.1f}s, len={}", elapsed, len(out))
        return out or "[empty response]"

    async def _run_cli_stream(
        self,
        prompt: str,
        *,
        session_key: str = "",
        cwd: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Run CLI in streaming mode and yield parsed JSONL dicts."""
        cmd = self._build_stream_cmd(prompt)
        env = self._clean_env()
        work_dir = cwd or str(Path.home())

        _log = logger.bind(component=f"adapter.{self.cli_name}")
        _log.info("CLI stream invoke: cwd={}", work_dir)
        t0 = time.monotonic()

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=work_dir,
            )
        except FileNotFoundError:
            _log.error("CLI not found at: {}", self._cli_path)
            yield {"type": "error", "error": f"{self.cli_name} CLI not found at: {self._cli_path}"}
            return

        if session_key:
            self._active_procs[session_key] = proc

        try:
            async for raw_line in proc.stdout:  # type: ignore[union-attr]
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
        except asyncio.CancelledError:
            proc.kill()
            raise
        finally:
            self._active_procs.pop(session_key, None)
            await proc.wait()
            elapsed = time.monotonic() - t0
            stderr_data = await proc.stderr.read() if proc.stderr else b""  # type: ignore[union-attr]
            stderr_text = stderr_data.decode("utf-8", errors="replace").strip()
            if proc.returncode != 0:
                _log.error(
                    "CLI stream failed: exit={}, elapsed={:.1f}s, stderr={}",
                    proc.returncode,
                    elapsed,
                    stderr_text[:500],
                )
            else:
                _log.info("CLI stream done: exit=0, elapsed={:.1f}s", elapsed)

    # ------------------------------------------------------------------
    # AgentAdapter protocol defaults
    # ------------------------------------------------------------------

    async def send_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
    ) -> str:
        user_text = str(text or "").strip()
        prompt = self._build_prompt(session_key, user_text)
        reply = await self._run_cli(prompt)
        if not reply.startswith("["):
            self._record_turn(session_key, user_text, reply)
        return reply

    async def stream_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
    ) -> AsyncIterator[AdapterEvent]:
        user_text = str(text or "").strip()
        prompt = self._build_prompt(session_key, user_text)

        raw_stream = self._run_cli_stream(prompt, session_key=session_key)
        async for evt in self._parse_stream_events(
            raw_stream,
            bot_id=bot_id,
            session_key=session_key,
        ):
            yield evt

    async def cancel(self, *, bot_id: str, turn_id: str | None = None) -> bool:
        cancelled = False
        for key, evt in self._cancel_events.items():
            evt.set()
            cancelled = True
        for key, proc in list(self._active_procs.items()):
            try:
                proc.kill()
                cancelled = True
            except ProcessLookupError:
                pass
        return cancelled

    async def fetch_history(self, *, session_key: str, limit: int = 100) -> list[dict[str, Any]]:
        raw = self._sessions.get(session_key, [])
        return [self._msg_builder.build(role=e["role"], text=e["content"]) for e in raw[-limit:]]

    async def reset_session(self, *, session_key: str) -> bool:
        self._sessions.pop(session_key, None)
        self._cancel_events.pop(session_key, None)
        return True
