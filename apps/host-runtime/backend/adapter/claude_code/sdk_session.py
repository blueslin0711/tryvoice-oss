"""Persistent Claude Code subprocess using SDK JSON-line protocol.

Unlike ``claude -p`` (one process per turn), this keeps the process alive
and sends user messages via stdin JSON lines.  Supports:
- Multi-turn conversations (no cold start between turns)
- Interactive tool permissions (control_request / response)
- Graceful interrupt (no process kill needed)
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from typing import (
    AsyncIterator,
    Callable,
    Dict,
    List,
    Optional,
)

from loguru import logger


class SDKSession:
    """Persistent Claude Code subprocess using SDK JSON-line protocol."""

    def __init__(
        self,
        *,
        cli_path: str,
        cwd: str,
        resume_session_id: Optional[str] = None,
        settings_path: Optional[str] = None,
        permission_mode: str = "acceptEdits",
        model: Optional[str] = None,
        effort: Optional[str] = None,
        on_control_request: Optional[Callable] = None,
    ):
        self._cli_path = cli_path
        self._cwd = cwd
        self._resume_session_id = resume_session_id
        self._settings_path = settings_path
        self._permission_mode = permission_mode
        self._model = model
        self._effort = effort
        self._on_control_request = on_control_request

        self._proc: Optional[asyncio.subprocess.Process] = None
        self._session_id: Optional[str] = None
        self._alive = False
        self._stdout_reader_task: Optional[asyncio.Task] = None
        self._message_queue: asyncio.Queue = asyncio.Queue()
        self._pending_control: Dict[str, asyncio.Future] = {}
        self._turn_active = False

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def is_alive(self) -> bool:
        return self._alive and self._proc is not None and self._proc.returncode is None

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    @property
    def is_turn_active(self) -> bool:
        return self._turn_active

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def _build_cmd(self) -> List[str]:
        """Build the CLI command list."""
        cmd = [
            self._cli_path,
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
        ]
        if self._resume_session_id:
            cmd.extend(["--resume", self._resume_session_id])
        if self._settings_path:
            cmd.extend(["--settings", self._settings_path])
        if self._model:
            cmd.extend(["--model", self._model])
        if self._effort:
            cmd.extend(["--effort", self._effort])
        cmd.extend(["--permission-mode", self._permission_mode])
        # Enable stdio permission protocol
        cmd.append("--permission-prompt-tool")
        cmd.append("stdio")
        return cmd

    async def start(self) -> None:
        """Spawn the Claude CLI process."""
        cmd = self._build_cmd()

        env = os.environ.copy()
        for key in (
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
            "ANTHROPIC_API_KEY",
        ):
            env.pop(key, None)

        self._proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=self._cwd,
        )
        self._alive = True
        # Start background stdout reader
        self._stdout_reader_task = asyncio.create_task(self._read_stdout())

    async def stop(self) -> None:
        """Stop the SDK session gracefully."""
        self._alive = False
        if self._proc:
            if self._proc.stdin:
                try:
                    self._proc.stdin.close()
                except Exception:
                    pass
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=10.0)
            except asyncio.TimeoutError:
                self._proc.kill()
        if self._stdout_reader_task:
            self._stdout_reader_task.cancel()
            try:
                await self._stdout_reader_task
            except asyncio.CancelledError:
                pass

    # ------------------------------------------------------------------
    # Stdin / stdout
    # ------------------------------------------------------------------

    def _write_stdin(self, msg: dict) -> None:
        """Write a JSON line to the subprocess stdin."""
        if self._proc and self._proc.stdin:
            line = json.dumps(msg) + "\n"
            self._proc.stdin.write(line.encode("utf-8"))

    async def _read_stdout(self) -> None:
        """Read JSON lines from stdout, dispatch to message queue or control handlers."""
        try:
            async for raw_line in self._proc.stdout:  # type: ignore[union-attr]
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type", "")

                if msg_type == "control_response":
                    # Response to our control request (e.g., interrupt)
                    req_id = msg.get("response", {}).get("request_id", "")
                    fut = self._pending_control.pop(req_id, None)
                    if fut and not fut.done():
                        fut.set_result(msg)

                elif msg_type == "control_request":
                    # Claude asking us for permission
                    asyncio.ensure_future(self._handle_control_request(msg))

                elif msg_type == "control_cancel_request":
                    # Claude cancelling a pending permission request
                    req_id = msg.get("request_id", "")
                    fut = self._pending_control.pop(req_id, None)
                    if fut and not fut.done():
                        fut.cancel()

                else:
                    # Normal message — put in queue for send() consumer
                    await self._message_queue.put(msg)

                    # Capture session_id from system init
                    if msg_type == "system" and msg.get("subtype") == "init":
                        self._session_id = msg.get("session_id")
        except Exception as exc:
            logger.bind(crash=True, component="crash.sdk-process").error(
                "SDKSession stdout reader died: session={}, error={}",
                self._session_id or "unknown",
                exc,
            )
        finally:
            rc = self._proc.returncode if self._proc else None
            if rc is not None and rc != 0:
                logger.bind(crash=True, component="crash.sdk-process").warning(
                    "SDK process exited with code={}, session={}",
                    rc,
                    self._session_id or "unknown",
                )
            self._alive = False

    async def _handle_control_request(self, msg: dict) -> None:
        """Handle a control_request from Claude (e.g., can_use_tool)."""
        request = msg.get("request", {})
        request_id = msg.get("request_id", "")
        subtype = request.get("subtype", "")

        if subtype == "can_use_tool" and self._on_control_request:
            # Delegate to external handler
            try:
                result = await self._on_control_request(request)
                # result should be {"behavior": "allow"} or
                # {"behavior": "deny", "message": "..."}
            except Exception:
                result = {"behavior": "allow"}  # default: allow
        else:
            result = {"behavior": "allow"}  # auto-approve if no handler

        # Send response back via stdin
        response = {
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": result,
            },
        }
        self._write_stdin(response)

    # ------------------------------------------------------------------
    # Messaging
    # ------------------------------------------------------------------

    async def send(self, text: str) -> AsyncIterator[dict]:
        """Send a user message and yield SDK response messages until turn completes."""
        if not self._alive:
            raise RuntimeError("SDKSession not started or process died")

        # Write user message to stdin
        user_msg = {
            "type": "user",
            "message": {
                "role": "user",
                "content": text,
            },
        }
        self._write_stdin(user_msg)
        self._turn_active = True

        # Read messages until we get a "result" (turn done)
        try:
            while self._alive:
                try:
                    msg = await asyncio.wait_for(self._message_queue.get(), timeout=600)
                except asyncio.TimeoutError:
                    break

                yield msg

                if msg.get("type") == "result":
                    break
        finally:
            self._turn_active = False

    async def interrupt(self) -> None:
        """Send interrupt control request to gracefully cancel current generation."""
        if not self._alive or not self._proc or not self._proc.stdin:
            return
        request_id = uuid.uuid4().hex[:12]
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        self._pending_control[request_id] = fut

        control_req = {
            "type": "control_request",
            "request_id": request_id,
            "request": {"subtype": "interrupt"},
        }
        self._write_stdin(control_req)

        try:
            await asyncio.wait_for(fut, timeout=5.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
