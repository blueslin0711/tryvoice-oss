"""Claude Code terminal adapter for TryVoice.

Discovers and connects to local Claude Code terminal sessions via the
``claude`` CLI subprocess. Supports resuming existing sessions and
creating new sessions via tmux.

Session key format:
  "claude:<SESSION_ID>"   - All session keys use this format

Configuration via environment variables or ConfigStore:
  ANTHROPIC_MODEL         - Model name (default claude-sonnet-4-6)
  CLAUDE_CLI_PATH         - Path to claude CLI (default: auto-detect)
  CLAUDE_CODE_PROJECT_DIR - Claude Code project dir (default: auto-detect from ~)
  LLM_SYSTEM_PROMPT       - System message (default "You are a helpful assistant.")
  LLM_MAX_HISTORY         - Max history messages per session (default 50)
  LLM_MAX_TOKENS          - Max output tokens (default 4096)
  LLM_TIMEOUT             - CLI timeout in seconds (default 120)
"""

from __future__ import annotations

import asyncio
import collections
import json
import os
import re
import shutil
import sys
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator

from loguru import logger

if TYPE_CHECKING:
    from .session_watcher import SessionWatcher

IS_WINDOWS = sys.platform == "win32"

from backend.adapter_sdk.config_types import BotInfo, ConfigField, CreateBotField  # noqa: E402
from backend.adapter_sdk.contract import AdapterCapabilities, AdapterEvent  # noqa: E402

from .sdk_session import SDKSession  # noqa: E402
from .session_scanner import scan_active_sessions  # noqa: E402
from .tmux_session import TmuxSession, _is_claude_prompt  # noqa: E402

_SPLIT_RE = re.compile(r"(?<=[。！？!?；;，,\n])")
_MAX_CHUNK = 48

# Prefix for session keys bound to Claude Code TUI sessions
_CLAUDE_SESSION_PREFIX = "claude:"

# Pattern to extract image path from TryVoice message format
_MEDIA_ATTACHED_RE = re.compile(r"^\[media attached:\s*([^\]]+)\]")


def _extract_media(text: str) -> tuple[str | None, str]:
    """Extract media path and clean prompt from TryVoice message format.

    Input:  "[media attached: /path/to/img.png]\nDescribe this image"
    Output: ("/path/to/img.png", "Describe this image")
    """
    m = _MEDIA_ATTACHED_RE.match(text)
    if not m:
        return None, text
    media_path = m.group(1).strip()
    prompt = text[m.end() :].strip()
    return media_path, prompt


def _normalize_stop_reason(raw: str) -> str:
    """Normalize Claude API stop_reason (snake_case) to wire-format (camelCase).

    The Claude Code JSONL uses snake_case (e.g. ``tool_use``, ``end_turn``),
    but the TryVoice canonical history pipeline expects camelCase
    (``toolUse``, ``endTurn``) to match other adapters.
    """
    _MAP = {
        "tool_use": "toolUse",
        "end_turn": "endTurn",
        "max_tokens": "maxTokens",
        "stop_sequence": "stopSequence",
    }
    return _MAP.get(raw, raw)


def _chunk_text(text: str) -> list[str]:
    """Split text into TTS-friendly chunks at punctuation boundaries."""
    parts = _SPLIT_RE.split(text)
    chunks: list[str] = []
    buf = ""
    for part in parts:
        if not part:
            continue
        buf += part
        if _SPLIT_RE.search(buf) or len(buf) >= _MAX_CHUNK:
            chunks.append(buf)
            buf = ""
    if buf:
        chunks.append(buf)
    return chunks


def _find_claude_cli() -> str:
    """Find the claude CLI binary path."""
    explicit = os.getenv("CLAUDE_CLI_PATH", "").strip()
    if explicit:
        return explicit
    found = shutil.which("claude")
    if found:
        return found
    if IS_WINDOWS:
        candidates = [
            os.path.expandvars(r"%APPDATA%\Claude\claude.exe"),
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\claude\claude.exe"),
            os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\claude\claude.exe"),
        ]
    else:
        candidates = [
            os.path.expanduser("~/.local/bin/claude"),
            "/usr/local/bin/claude",
            os.path.expanduser("~/.nvm/versions/node/*/bin/claude"),
            os.path.expanduser("~/.npm-global/bin/claude"),
            "/opt/homebrew/bin/claude",
        ]
    for candidate in candidates:
        # Support glob patterns in candidates (e.g. nvm paths)
        import glob as _glob

        matched = _glob.glob(candidate)
        for m in matched:
            if os.path.isfile(m) and os.access(m, os.X_OK):
                return m
        if not matched and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "claude"


def _detect_project_dir() -> Path | None:
    """Detect the Claude Code project directory for the home folder."""
    explicit = os.getenv("CLAUDE_CODE_PROJECT_DIR", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    home = Path.home()
    from .session_scanner import _cwd_to_project_dir_name

    encoded = _cwd_to_project_dir_name(str(home))
    candidate = home / ".claude" / "projects" / encoded
    if candidate.is_dir():
        return candidate
    return None


def _parse_claude_session_id(session_key: str) -> str | None:
    """Extract Claude Code session ID from session key, or None."""
    if session_key.startswith(_CLAUDE_SESSION_PREFIX):
        return session_key[len(_CLAUDE_SESSION_PREFIX) :]
    return None


def _format_tool_description(tool_name: str, tool_input: dict) -> str:
    """Format tool name + input into a human-readable description."""
    if tool_name == "Bash":
        return f"Run command: {tool_input.get('command', '(unknown)')}"
    elif tool_name in ("Write", "Edit"):
        return f"{tool_name} file: {tool_input.get('file_path', tool_input.get('path', '(unknown)'))}"
    elif tool_name == "WebFetch":
        return f"Fetch URL: {tool_input.get('url', '(unknown)')}"
    else:
        return f"{tool_name}: {json.dumps(tool_input, ensure_ascii=False)[:200]}"


def _read_session_jsonl(
    project_dir: Path,
    session_id: str,
    limit: int = 100,
    after_ts: str = "",
) -> list[dict[str, Any]]:
    """Read user/assistant messages from a Claude Code session JSONL file.

    If ``after_ts`` is provided (ISO-8601 string), only messages with
    ``timestamp >= after_ts`` are returned.  This prevents returning
    stale history from a resumed Claude Code session that pre-dates
    the TryVoice bot creation.
    """
    jsonl_path = project_dir / f"{session_id}.jsonl"
    if not jsonl_path.exists():
        return []

    messages: list[dict[str, Any]] = []
    # Track whether the last assistant message used tools.
    # If so, the subsequent user messages are tool results (not real
    # user input) and should be skipped.
    _last_assistant_used_tool = False
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("type") not in ("user", "assistant"):
                    continue
                msg = d.get("message", {})
                role = msg.get("role", "")
                if role not in ("user", "assistant"):
                    continue

                # -- Skip user messages that are tool results --
                # In Claude's conversation format, after an assistant
                # message with stop_reason="tool_use", all subsequent
                # user messages (until the next assistant message) are
                # tool results — regardless of whether their content
                # blocks are type="tool_result" or type="text" (e.g.
                # Skill tool injects its output as plain text blocks).
                if role == "assistant":
                    raw_sr = msg.get("stop_reason") or ""
                    # Infer tool-use from content when stop_reason is None
                    # (streaming snapshots may not have final stop_reason yet)
                    has_tool_content = any(
                        isinstance(c, dict) and c.get("type") == "tool_use"
                        for c in (msg.get("content", "") if isinstance(msg.get("content", ""), list) else [])
                    )
                    _last_assistant_used_tool = raw_sr == "tool_use" or (not raw_sr and has_tool_content)
                elif role == "user" and _last_assistant_used_tool:
                    # This user message is a tool result, skip it.
                    continue

                content = msg.get("content", "")
                if isinstance(content, list):
                    text_parts = [c.get("text", "") for c in content if c.get("type") == "text"]
                    text = " ".join(text_parts)
                    tool_parts = [c for c in content if c.get("type") == "tool_use"]
                    if tool_parts and not text:
                        ask_parts = [t for t in tool_parts if t.get("name") == "AskUserQuestion"]
                        if ask_parts:
                            questions = ask_parts[0].get("input", {}).get("questions", [])
                            q_texts = [q.get("question", "") for q in questions if q.get("question")]
                            text = "[AskUserQuestion]\n" + "\n".join(f"- {q}" for q in q_texts)
                        else:
                            names = [t.get("name", "?") for t in tool_parts]
                            text = f"[tool: {', '.join(names)}]"
                elif isinstance(content, str):
                    text = content
                else:
                    continue
                text = text.strip()
                if not text:
                    continue
                ts = d.get("timestamp", "")
                if after_ts and ts and ts < after_ts:
                    continue
                # Infer stopReason for streaming snapshots (stop_reason=None)
                if role == "assistant":
                    raw_sr = msg.get("stop_reason")
                    if raw_sr is None:
                        # Any snapshot containing tool_use blocks is intermediate
                        has_tools = bool(tool_parts) if isinstance(content, list) else False
                        inferred_sr = "toolUse" if has_tools else "endTurn"
                    else:
                        inferred_sr = _normalize_stop_reason(raw_sr)
                else:
                    inferred_sr = ""
                messages.append(
                    {
                        "id": d.get("uuid", f"cc-{uuid.uuid4().hex[:10]}"),
                        "timestamp": d.get("timestamp", ""),
                        "role": role,
                        "text": text,
                        "content": text,
                        "stopReason": inferred_sr if role == "assistant" else "",
                        "provider": "claude-code-tui",
                        "model": msg.get("model", ""),
                    }
                )
    except Exception as exc:
        logger.warning(f"Failed to read session JSONL {jsonl_path}: {exc}")

    return messages[-limit:]


class ClaudeCodeAdapter:
    """Adapter that discovers and connects to Claude Code terminal sessions.

    Uses ``claude -p`` subprocess for responses. When session_key starts
    with "claude:", it resumes an existing Claude Code TUI session via
    ``--resume SESSION_ID``.
    """

    def __init__(self) -> None:
        self._model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")
        self._cli_path = _find_claude_cli()
        self._system_prompt = os.getenv("LLM_SYSTEM_PROMPT", "You are a helpful assistant.")
        self._max_tokens = int(os.getenv("LLM_MAX_TOKENS", "4096"))
        self._timeout = int(os.getenv("LLM_TIMEOUT", "120"))
        self._project_dir = _detect_project_dir()
        self._scan_interval = 60  # minutes
        # "observer" = tmux + JSONL polling (default); "controller" = per-turn subprocess
        # NOTE: read lazily via property because .env may not be loaded yet at
        # import time (registry.py imports before config/__init__.py runs load_dotenv).
        self._session_mode_override: str | None = None
        self._tmux_available: bool | None = None  # cached tmux detection result

        self._caps = AdapterCapabilities(
            supports_stream=True,
            supports_cancel=True,
            supports_session_resume=True,
            supports_multi_slot=True,
            supports_tool_events=True,
            supports_remote_history=True,
            supports_streaming_turn=True,
            supports_discovery=True,
            supports_creation=True,
            ephemeral_sessions=True,
            has_watcher=True,
            reconnect_burst_sync_ms=2000,  # reconnect: sync every 2s
            reconnect_burst_duration_ms=60000,  # burst for 60s
            turn_initial_grace_seconds=600,
            turn_idle_timeout_seconds=300,
            turn_max_timeout_seconds=0,
            processing_timeout_hint_ms=660_000,
        )

        self._cancel_events: dict[str, asyncio.Event] = {}
        self._session_cwds: dict[str, str] = {}  # session_id → cwd for --resume
        self._bot_to_session: dict[str, str] = {}  # stable_bot_id → session_id
        self._real_session_ids: dict[str, str] = {}  # session_id → real_session_id (JSONL tracking)
        self._real_session_bound_ts: dict[str, str] = {}  # session_id → ISO-8601 when mapping was created
        self._tmux_sessions: dict[str, TmuxSession] = {}  # session_id → TmuxSession
        self._tmux_locks: dict[str, asyncio.Lock] = {}  # per-session creation lock
        self._pre_warm_active: set[str] = set()  # session IDs currently being warmed
        # Shared across all TmuxSession instances so that concurrent new sessions
        # in the same project dir don't grab each other's JSONL files.
        self._claimed_session_ids: set[str] = set()
        self._session_watchers: dict[str, "SessionWatcher"] = {}  # session_id → SessionWatcher
        self._ws_broadcast_fn = None
        self._canonical_store = None
        self._watcher_tool_state: dict[str, bool] = {}
        self._pending_turn_done: dict[str, asyncio.Event] = {}
        self._pending_client_msg_ids: dict[str, collections.deque] = {}  # bot_id → FIFO queue of client_msg_ids
        self._turn_source_channel: dict[str, str] = {}  # bot_id → "web" | "terminal"
        self._ts = int(time.time() * 1000)
        # Controller mode: persistent SDK sessions and per-session locks
        self._sdk_sessions: dict[str, SDKSession] = {}  # session_id → SDKSession
        self._controller_locks: dict[str, asyncio.Lock] = {}  # session_id → Lock
        self._controller_effort: dict[str, str] = {}  # bot_id → effort level for controller mode
        self._sdk_turn_active: dict[str, bool] = {}  # bot_id → True while SDK turn is in flight
        self._sdk_pending_replies: dict[str, asyncio.Future] = {}  # bot_id → Future
        self._hook_pending_replies: dict[str, asyncio.Future] = {}  # request_id → Future
        self._hook_pending_payloads: dict[str, dict] = {}  # request_id → ws_payload (for reconnect resend)
        self._tmux_name_to_bot: dict[str, str] = {}  # tmux_name → bot_id
        self._crash_recovery_in_progress = False
        # Tmux health monitoring
        self._health_loop_task: asyncio.Task | None = None
        self._health_loop_stopped = False
        self._health_check_interval = 15.0  # seconds
        self._load_session_cwds()  # Restore from disk on startup

        if self._project_dir:
            logger.info(f"Claude Code project dir: {self._project_dir}")
        else:
            logger.warning("Claude Code project dir not found; --resume will not work")

    async def _check_tmux_server_alive(self) -> bool:
        """Check if the tmux server process is running.

        Returns True if `tmux list-sessions` succeeds (even with 0 sessions),
        False if the server is not running or the command times out.
        """
        _log = logger.bind(component="adapter.claude-code.health")
        try:
            proc = await asyncio.create_subprocess_exec(
                "tmux",
                "list-sessions",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=5.0)
            if proc.returncode != 0:
                err = stderr.decode("utf-8", errors="replace")
                if "no server running" in err:
                    _log.warning(
                        "tmux server not running (rc={}, stderr={})",
                        proc.returncode,
                        err.strip(),
                    )
                    return False
                # Other errors (e.g. "no sessions") still mean server is alive
            return True
        except asyncio.TimeoutError:
            _log.warning("tmux list-sessions timed out after 5s")
            return False
        except OSError as exc:
            _log.warning("tmux list-sessions OSError: {}", exc)
            return False

    async def _handle_tmux_server_crash(self) -> None:
        """Handle tmux server crash: clear stale state and rebuild all sessions.

        Called by the health loop when tmux server is detected as dead.
        Clears all in-memory tmux session and watcher references (which are now
        stale), then calls pre_warm for each known session to create new tmux
        sessions on the fresh tmux server.

        Uses _crash_recovery_in_progress flag to prevent concurrent recovery
        and to block pre_warm re-entrance during cleanup (pre_warm checks this
        flag and skips if set, so clearing _pre_warm_active is safe).
        """
        if self._crash_recovery_in_progress:
            return
        self._crash_recovery_in_progress = True

        _log = logger.bind(component="adapter.claude-code.health")
        session_ids = list(self._tmux_sessions.keys())
        if not session_ids:
            self._crash_recovery_in_progress = False
            return

        # Collect tmux server PID from sessions for crash diagnostics
        server_pids = set()
        for sid in session_ids:
            sess = self._tmux_sessions.get(sid)
            if sess and hasattr(sess, "_tmux_server_pid"):
                server_pids.add(getattr(sess, "_tmux_server_pid", "unknown"))

        # Log pre-crash session state for diagnostics
        for sid in session_ids:
            sess = self._tmux_sessions.get(sid)
            watcher = self._session_watchers.get(sid)
            real_id = self._real_session_ids.get(sid)
            _log.info(
                "pre-crash state session={}: alive={}, real_id={}, has_watcher={}",
                sid[:8],
                sess.is_alive() if sess else "N/A",
                real_id[:8] if real_id else None,
                watcher is not None,
            )

        # Check tmux socket and server process for diagnostics
        try:
            tmux_sock = Path(f"/private/tmp/tmux-{os.getuid()}/default")
            sock_exists = tmux_sock.exists()
            # Check if the known server PID is still alive
            pid_alive = {}
            for pid in server_pids:
                try:
                    os.kill(int(pid), 0)
                    pid_alive[pid] = True
                except (ProcessLookupError, ValueError):
                    pid_alive[pid] = False
                except PermissionError:
                    pid_alive[pid] = True  # exists but no permission
            _log.info(
                "tmux diagnostics: socket={} (exists={}), server_pids={}, pid_alive={}",
                tmux_sock,
                sock_exists,
                server_pids,
                pid_alive,
            )
        except Exception:
            pass

        _crash = logger.bind(crash=True, component="crash.tmux-server")
        _crash.error(
            "tmux server crash detected — rebuilding {} session(s): {}, last_server_pids={}",
            len(session_ids),
            [s[:8] for s in session_ids],
            server_pids,
        )

        try:
            # 1. Stop all watchers (they poll stale JSONL file descriptors)
            for sid in session_ids:
                watcher = self._session_watchers.pop(sid, None)
                if watcher:
                    try:
                        await watcher.stop()
                    except Exception:
                        pass  # watcher may already be broken

            # 2. Clear tmux session references (all are dead)
            self._tmux_sessions.clear()
            self._pre_warm_active.clear()

            # 3. Rebuild each session via existing pre_warm path
            rebuilt = 0
            failed = 0
            for sid in session_ids:
                session_key = f"claude:{sid}"
                try:
                    await self.pre_warm(session_key=session_key)
                    rebuilt += 1
                except Exception as exc:
                    failed += 1
                    _crash.warning("rebuild failed session={}: {}", sid[:8], exc)

            _crash.info(
                "tmux recovery complete — {}/{} session(s) rebuilt, {} failed",
                rebuilt,
                len(session_ids),
                failed,
            )
        finally:
            self._crash_recovery_in_progress = False

    async def _tmux_health_loop(self) -> None:
        """Background loop: check tmux server health every N seconds.

        Only runs in observer mode when there are managed tmux sessions.
        On detecting a dead server, triggers full session rebuild.
        """
        _log = logger.bind(component="adapter.claude-code.health")
        check_count = 0
        while not self._health_loop_stopped:
            await asyncio.sleep(self._health_check_interval)
            if self._health_loop_stopped:
                break
            # Skip if not in observer mode or no sessions to monitor
            if self._session_mode != "observer":
                continue
            if not self._tmux_sessions:
                continue

            alive = await self._check_tmux_server_alive()
            check_count += 1
            if not alive:
                _log.warning(
                    "health check #{}: tmux server DEAD, triggering recovery",
                    check_count,
                )
                await self._handle_tmux_server_crash()
                check_count = 0
            else:
                # Tmux server alive — also check individual claude processes
                await self._check_claude_processes()
                if check_count % 10 == 0:
                    _log.debug(
                        "health check #{}: tmux alive, monitoring {} session(s)",
                        check_count,
                        len(self._tmux_sessions),
                    )

    async def _check_claude_processes(self) -> None:
        """Check if claude processes are alive in all managed tmux sessions."""
        for session_id, tmux_session in list(self._tmux_sessions.items()):
            if not hasattr(tmux_session, "check_claude_process_alive"):
                continue
            try:
                alive = await tmux_session.check_claude_process_alive()
                if not alive:
                    _crash = logger.bind(crash=True, component="crash.claude-process")
                    _crash.warning(
                        "claude process dead in {}, session={}, restarting",
                        tmux_session._tmux_name,
                        session_id[:8],
                    )
                    await tmux_session.restart_claude()
                    _crash.info("claude process restarted in {}", tmux_session._tmux_name)
            except Exception as exc:
                logger.bind(crash=True, component="crash.claude-process").warning(
                    "claude process check/restart failed session={}: {}",
                    session_id[:8],
                    exc,
                )

    def start_health_loop(self) -> None:
        """Start the tmux health monitoring background task."""
        if self._health_loop_task is None or self._health_loop_task.done():
            self._health_loop_stopped = False
            self._health_loop_task = asyncio.ensure_future(self._tmux_health_loop())

    async def stop_health_loop(self) -> None:
        """Stop the tmux health monitoring background task."""
        self._health_loop_stopped = True
        if self._health_loop_task and not self._health_loop_task.done():
            self._health_loop_task.cancel()
            try:
                await self._health_loop_task
            except asyncio.CancelledError:
                pass
            self._health_loop_task = None

    def _check_tmux_available(self) -> bool:
        """Check whether tmux binary is available on this system (cached)."""
        if self._tmux_available is None:
            self._tmux_available = shutil.which("tmux") is not None
            if not self._tmux_available:
                logger.warning(
                    "tmux not found — observer mode unavailable, "
                    "falling back to controller mode. "
                    "Install tmux (e.g. `brew install tmux`) for full terminal experience."
                )
        return self._tmux_available

    @property
    def _session_mode(self) -> str:
        """Return session mode, reading from env on first access (after .env is loaded).

        Auto-downgrades from observer to controller when tmux is not installed.
        """
        if self._session_mode_override is not None:
            mode = self._session_mode_override
        else:
            mode = os.getenv("TRYVOICE_SESSION_MODE", "observer")
        if mode == "observer" and not self._check_tmux_available():
            return "controller"
        return mode

    @_session_mode.setter
    def _session_mode(self, value: str) -> None:
        self._session_mode_override = value

    # -- Session CWD persistence (survives backend restart) --

    _SESSION_CWDS_PATH = Path.home() / ".tryvoice" / "claude-session-dirs.json"

    def _persist_session_cwds(self) -> None:
        """Persist session_id → cwd, bot_id → session_id, and real_session_id mappings to disk."""
        try:
            data = {
                "session_cwds": dict(self._session_cwds),
                "bot_to_session": dict(self._bot_to_session),
                "real_session_ids": dict(self._real_session_ids),
                "real_session_bound_ts": dict(self._real_session_bound_ts),
            }
            self._SESSION_CWDS_PATH.parent.mkdir(parents=True, exist_ok=True)
            self._SESSION_CWDS_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except Exception as e:
            logger.warning(f"Failed to persist session cwds: {e}")

    def _load_session_cwds(self) -> None:
        """Load session_id → cwd and bot_id → session_id mappings from disk."""
        try:
            if self._SESSION_CWDS_PATH.exists():
                data = json.loads(self._SESSION_CWDS_PATH.read_text(encoding="utf-8"))
                self._session_cwds.update(data.get("session_cwds", {}))
                self._bot_to_session.update(data.get("bot_to_session", {}))
                self._real_session_ids.update(data.get("real_session_ids", {}))
                self._real_session_bound_ts.update(data.get("real_session_bound_ts", {}))
                logger.info(f"Loaded {len(self._session_cwds)} session cwd(s) from disk")
        except Exception as e:
            logger.warning(f"Failed to load session cwds: {e}")

    def _on_real_session_id_changed(self, session_id: str, real_session_id: str) -> None:
        """Callback from TmuxSession when real_session_id changes. Persist to disk."""
        from datetime import datetime, timezone

        self._real_session_ids[session_id] = real_session_id
        self._real_session_bound_ts[session_id] = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        self._persist_session_cwds()
        # Notify SessionWatcher about the new real session ID
        watcher = self._session_watchers.get(session_id)
        if watcher:
            watcher.on_new_session(real_session_id)

    # -------------------------------------------------------------------
    # SessionWatcher lifecycle (live push + persist)
    # -------------------------------------------------------------------

    async def _get_or_create_watcher(self, cc_session_id: str, bot_id: str) -> "SessionWatcher | None":
        """Get or create a SessionWatcher for a claude session.

        Returns None if the session's cwd is unknown (avoids defaulting to
        the home-directory project dir which would load unrelated history).
        """
        if cc_session_id in self._session_watchers:
            return self._session_watchers[cc_session_id]

        from .session_scanner import _cwd_to_project_dir_name
        from .session_watcher import SessionWatcher

        cwd = self._session_cwds.get(cc_session_id, "")
        if not cwd:
            logger.bind(component="adapter.claude-code").warning(
                "No cwd for session {}, skipping watcher creation", cc_session_id[:8]
            )
            return None
        project_dir = Path.home() / ".claude" / "projects" / _cwd_to_project_dir_name(cwd)

        # Determine real session ID (for discovered bots, cc_session_id IS the real ID)
        real_id = self._real_session_ids.get(cc_session_id, cc_session_id)

        watcher = SessionWatcher(
            session_id=real_id if (project_dir / f"{real_id}.jsonl").exists() else None,
            project_dir=project_dir,
            on_message_cb=lambda entry, is_update: self._on_watcher_message(bot_id, entry, is_update),
            on_turn_event_cb=lambda event_type, entry: self._on_watcher_turn_event(bot_id, event_type, entry),
        )
        await watcher.start()
        self._session_watchers[cc_session_id] = watcher
        return watcher

    def _on_watcher_message(self, bot_id: str, entry: dict, is_update: bool):
        """Unified handler: persist to canonical_store + push via WebSocket."""
        _log = logger.bind(component="adapter.claude-code.watcher")

        etype = entry.get("type", "")
        if etype not in ("user", "assistant"):
            return  # Only sync user and assistant messages

        msg = entry.get("message", {})
        role = msg.get("role", "")
        if role not in ("user", "assistant"):
            return

        # Skip tool-result user messages (same filter as _read_session_jsonl)
        # After an assistant message containing tool_use blocks, subsequent
        # user messages are tool results, not real user input.
        # Check both stop_reason and content blocks because Claude Code JSONL
        # may split tool_use into a separate entry with stop_reason=None.
        if role == "assistant":
            stop_reason = msg.get("stop_reason", "")
            _has_tool_blocks = isinstance(msg.get("content", []), list) and any(
                isinstance(b, dict) and b.get("type") == "tool_use" for b in msg["content"]
            )
            self._watcher_tool_state[bot_id] = stop_reason == "tool_use" or _has_tool_blocks
        elif role == "user" and self._watcher_tool_state.get(bot_id, False):
            return  # Skip tool result

        text = self._watcher_extract_text(entry)
        thinking_text = self._watcher_extract_thinking(entry) if role == "assistant" else ""
        # Check for tool_use blocks (may have no text/thinking at all)
        has_tool_use = False
        if role == "assistant" and isinstance(msg.get("content", []), list):
            has_tool_use = any(isinstance(b, dict) and b.get("type") == "tool_use" for b in msg["content"])
        if not text and not thinking_text and not has_tool_use:
            return

        entry_uuid = entry.get("uuid", "")
        if not entry_uuid:
            return  # Can't deduplicate without UUID

        source_ts = entry.get("timestamp", "")
        stop_reason = msg.get("stop_reason", "") if role == "assistant" else ""
        model = msg.get("model", "")

        # All text is "result" regardless of stop_reason so that both
        # granularity levels ("仅文字" / "含 Tool Call") always display
        # assistant text — intermediate step text AND final answers.
        # Tool-use blocks are emitted separately below with
        # contentKind="tool_call" + intermediate=True, so they are only
        # visible in "含 Tool Call" mode.  Entries with no text at all
        # (tool_use-only) skip the text payload entirely (line 818).
        content_kind: str = "result"

        # Persist to canonical_store
        server_seq = None
        is_new_event = True
        if self._canonical_store:
            # Derive session_key from bot_id → session_id mapping
            _sid = getattr(self, "_bot_to_session", {}).get(bot_id, "")
            _session_key = f"claude:{_sid}" if _sid else ""
            try:
                # Persist text (or thinking text for thinking-only entries).
                # content_kind is stored in payload_json so history sync
                # includes it for frontend granularity filtering.
                _store_text = text or thinking_text or ""
                _store_ck = "thinking" if (not text and thinking_text) else ""
                server_seq, is_new_event = self._canonical_store.upsert_event(
                    bot_id=bot_id,
                    event_key=entry_uuid,
                    role=role,
                    text=_store_text,
                    source_ts=source_ts,
                    session_key=_session_key,
                    stop_reason=stop_reason,
                    model=model,
                    content_kind=_store_ck,
                )
            except Exception as exc:
                _log.warning("watcher: canonical_store upsert failed: {}", exc)

        # Dequeue pending client_msg_id (FIFO) for web-originated user messages
        # and track turn source so assistant replies inherit the channel.
        # Only dequeue for genuinely NEW messages — after a mode switch the
        # watcher rescans JSONL and replays historical entries that already
        # exist in canonical_store.  Those must not consume the client_msg_id
        # meant for the current turn (Happy project solves this by marking
        # all existing UUIDs as processed before starting the scanner).
        client_msg_id = ""
        if role == "user" and is_new_event:
            q = self._pending_client_msg_ids.get(bot_id)
            if q:
                client_msg_id = q.popleft()
            # Track: "web" if from outbox, "terminal" if from tmux direct input
            self._turn_source_channel[bot_id] = "web" if client_msg_id else "terminal"

        source_channel = self._turn_source_channel.get(bot_id, "web")

        # Push to frontend via WebSocket
        # Skip replayed messages (is_new_event=False) — after a mode switch the
        # watcher rescans JSONL and replays historical entries already in
        # canonical_store; broadcasting those would create frontend duplicates.
        # Broadcast all new events to the frontend via WebSocket.
        # The watcher is the single source of truth for message_sync:
        # it has real serverSeq, timestamp, and JSONL UUID eventKeys.
        # During controller mode the turn_executor only handles TTS
        # accumulation — the watcher handles all display pushes.
        if self._ws_broadcast_fn and server_seq is not None and is_new_event:
            # Emit thinking block first (before the main text) if present
            if thinking_text:
                thinking_payload: dict = {
                    "type": "message_sync",
                    "botId": bot_id,
                    "eventKey": f"{entry_uuid}__thinking",
                    "role": role,
                    "text": thinking_text,
                    "serverSeq": server_seq,
                    "timestamp": source_ts,
                    "sourceChannel": source_channel,
                    "contentKind": "thinking",
                    "intermediate": True,
                }
                asyncio.ensure_future(self._ws_broadcast_fn(bot_id, thinking_payload))
                _log.debug(
                    "watcher: pushed thinking message_sync bot={} uuid={}__thinking",
                    bot_id,
                    entry_uuid[:8],
                )

            if text:
                payload: dict = {
                    "type": "message_sync",
                    "botId": bot_id,
                    "eventKey": entry_uuid,
                    "role": role,
                    "text": text,
                    "serverSeq": server_seq,
                    "timestamp": source_ts,
                    "sourceChannel": source_channel,
                    "contentKind": content_kind,
                }
                # content_kind is always "result" for text, so no intermediate
                # flag is set — text is always visible in all granularity levels.
                # (tool_call payloads are emitted separately below with their
                # own intermediate=True flag.)
                if client_msg_id:
                    payload["clientMsgId"] = client_msg_id
                asyncio.ensure_future(self._ws_broadcast_fn(bot_id, payload))
                _log.debug(
                    "watcher: pushed message_sync bot={} uuid={} role={} seq={} update={} contentKind={}",
                    bot_id,
                    entry_uuid[:8],
                    role,
                    server_seq,
                    is_update,
                    content_kind,
                )

            # Emit individual tool_call messages for each tool_use block.
            # These provide the 'all' granularity level with raw tool invocation
            # details.  Check has_tool_use (not stop_reason) because Claude Code
            # JSONL often splits text and tool_use into separate entries where
            # the tool_use entry may have stop_reason=None.
            # Skip for end_turn — those are final answers, not tool steps.
            if has_tool_use and stop_reason != "end_turn":
                tool_calls = self._watcher_extract_tool_uses(entry)
                for idx, tool_call_text in enumerate(tool_calls):
                    tool_payload: dict = {
                        "type": "message_sync",
                        "botId": bot_id,
                        "eventKey": f"{entry_uuid}__tool_{idx}",
                        "role": role,
                        "text": tool_call_text,
                        "serverSeq": server_seq,
                        "timestamp": source_ts,
                        "sourceChannel": source_channel,
                        "contentKind": "tool_call",
                        "intermediate": True,
                    }
                    asyncio.ensure_future(self._ws_broadcast_fn(bot_id, tool_payload))
                    _log.debug(
                        "watcher: pushed tool_call message_sync bot={} uuid={}__tool_{} tool={}",
                        bot_id,
                        entry_uuid[:8],
                        idx,
                        tool_call_text,
                    )

    def _on_watcher_turn_event(self, bot_id: str, event_type: str, entry: dict):
        """Handle turn lifecycle events from watcher."""
        _log = logger.bind(component="adapter.claude-code.watcher")
        _log.debug("watcher_turn: bot={} event={}", bot_id, event_type)

        if event_type == "turn_complete":
            # Signal any pending stream_user_turn waiters
            done_event = self._pending_turn_done.get(bot_id)
            if done_event:
                done_event.set()
                _log.info("turn_complete: released done_event for bot={}", bot_id)
            # Clear processing status
            if self._ws_broadcast_fn:
                asyncio.ensure_future(
                    self._ws_broadcast_fn(
                        bot_id,
                        {
                            "type": "status",
                            "botId": bot_id,
                            "text": "",
                        },
                    )
                )

        elif event_type == "tool_active":
            # Claude is executing a tool — update status with tool name
            tool_name = ""
            msg = entry.get("message", {})
            content = msg.get("content", [])
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        tool_name = block.get("name", "")
                        break
            status_text = f"执行 {tool_name}..." if tool_name else "执行工具..."
            if self._ws_broadcast_fn:
                asyncio.ensure_future(
                    self._ws_broadcast_fn(
                        bot_id,
                        {
                            "type": "status",
                            "botId": bot_id,
                            "text": status_text,
                        },
                    )
                )

    @staticmethod
    def _watcher_extract_text(entry: dict) -> str:
        """Extract display text from JSONL entry (excludes thinking blocks)."""
        msg = entry.get("message", {})
        content = msg.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
            return " ".join(parts)
        return ""

    @staticmethod
    def _watcher_extract_thinking(entry: dict) -> str:
        """Extract thinking block text from JSONL entry assistant messages."""
        msg = entry.get("message", {})
        content = msg.get("content", [])
        if not isinstance(content, list):
            return ""
        parts = [
            b.get("thinking", "") or b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "thinking"
        ]
        return " ".join(p for p in parts if p)

    @staticmethod
    def _watcher_extract_tool_uses(entry: dict) -> list:
        """Extract tool_use blocks from JSONL entry and return markdown-formatted strings.

        Produces readable markdown: tool name as header, args as key-value pairs
        with multi-line values wrapped in code fences.
        """
        msg = entry.get("message", {})
        content = msg.get("content", [])
        if not isinstance(content, list):
            return []
        result = []
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            tool_name = block.get("name", "unknown_tool")
            inputs = block.get("input", {})
            if not isinstance(inputs, dict):
                result.append(f"**{tool_name}**\n{inputs}")
                continue
            # Build readable description based on tool type
            desc = _format_tool_description(tool_name, inputs)
            parts = [f"**{tool_name}** — {desc}"]
            # For Edit/Write, show code content in fenced blocks
            for key in ("old_string", "new_string", "content", "command"):
                val = inputs.get(key, "")
                if not val or not isinstance(val, str):
                    continue
                if "\n" in val or len(val) > 80:
                    parts.append(f"`{key}`:\n```\n{val}\n```")
                else:
                    parts.append(f"`{key}`: `{val}`")
            result.append("\n".join(parts))
        return result

    def _on_organic_session_changed(self, session_id: str, bot_id: str) -> None:
        """Callback from TmuxSession when /clear is detected organically in tmux."""
        if not bot_id or not self._ws_broadcast_fn:
            return
        asyncio.ensure_future(self._broadcast_organic_reset(bot_id))

    async def _broadcast_organic_reset(self, bot_id: str) -> None:
        """Notify all connected WebSocket clients that a terminal /clear was detected."""
        try:
            await self._ws_broadcast_fn(bot_id, {"type": "session_reset_detected", "botId": bot_id})
        except Exception as exc:
            logger.warning("Failed to broadcast organic reset for {}: {}", bot_id, exc)

    def set_ws_broadcast(self, broadcast_fn) -> None:
        """Inject WebSocket broadcast function from host runtime."""
        self._ws_broadcast_fn = broadcast_fn

    def set_canonical_store(self, store) -> None:
        """Inject canonical store reference from host runtime."""
        self._canonical_store = store

    def apply_config(self, config: dict) -> None:
        """Apply configuration from ConfigStore at runtime."""
        if "anthropic_model" in config:
            self._model = str(config["anthropic_model"])
        if "claude_cli_path" in config:
            self._cli_path = str(config["claude_cli_path"])
        if "system_prompt" in config:
            self._system_prompt = str(config["system_prompt"])
        if "scan_interval" in config:
            self._scan_interval = int(config["scan_interval"])
        if "session_mode" in config:
            new_mode = str(config["session_mode"])
            old_mode = self._session_mode
            self._session_mode = new_mode
            if old_mode != new_mode:
                asyncio.create_task(self._handle_mode_switch(old_mode, new_mode))

    async def _handle_mode_switch(self, old_mode: str, new_mode: str) -> None:
        """Clean up old mode resources and initialise new mode after a live switch."""
        _log = logger.bind(component="adapter.claude-code.mode-switch")
        _log.info("session mode switch: {} → {}", old_mode, new_mode)

        if old_mode == "controller" and new_mode == "observer":
            # Controller → Observer: stop SDK sessions, create tmux + attach.
            # Only migrate bots that had a live SDK session (i.e. actually
            # managed by TryVoice), not every session from discover_bots.
            managed_bot_sids: list[tuple[str, str]] = []
            for sid, sdk in list(self._sdk_sessions.items()):
                # Find the bot_id that owns this SDK session
                bot_id = next((b for b, s in self._bot_to_session.items() if s == sid), None)
                if sdk.is_alive:
                    _log.info("stopping SDK session {}", sid[:8])
                    await sdk.stop()
                if bot_id:
                    managed_bot_sids.append((bot_id, sid))
            self._sdk_sessions.clear()

            # Also include bots registered in the slot registry (configured
            # in .env / web UI) that may not have an SDK session yet.
            from backend.runtime.slot_registry import list_slots

            for slot in list_slots():
                sk = slot.get("sessionKey", "")
                cc_id = _parse_claude_session_id(sk)
                if cc_id:
                    bid = slot.get("botId", slot.get("slotId", ""))
                    if bid and not any(b == bid for b, _ in managed_bot_sids):
                        managed_bot_sids.append((bid, cc_id))

            # Create tmux sessions and attach terminal windows
            for bot_id, sid in managed_bot_sids:
                try:
                    tmux = await self._get_tmux_session(sid)
                    tmux._bot_id = bot_id
                    await self._get_or_create_watcher(sid, bot_id)
                    if hasattr(tmux, "_tmux_name") and tmux._tmux_name:
                        self._tmux_name_to_bot[tmux._tmux_name] = bot_id
                    await tmux.open_terminal_window()
                    _log.info("observer: tmux session ready for bot={}", bot_id)
                except Exception as exc:
                    _log.error("observer: failed to create tmux for bot={}: {}", bot_id, exc)

        elif old_mode == "observer" and new_mode == "controller":
            # Observer → Controller: stop tmux sessions and watchers
            for sid, tmux in list(self._tmux_sessions.items()):
                try:
                    if tmux.is_alive():
                        _log.info("stopping tmux session {}", sid[:8])
                        await tmux.stop()
                except Exception as exc:
                    _log.warning("failed to stop tmux {}: {}", sid[:8], exc)
            self._tmux_sessions.clear()

            for sid, watcher in list(self._session_watchers.items()):
                try:
                    await watcher.stop()
                except Exception:
                    pass
            self._session_watchers.clear()
            _log.info("controller: tmux sessions and watchers stopped")

    def _next_ts(self) -> str:
        self._ts += 9
        return str(self._ts)

    def _msg(self, *, role: str, text: str) -> dict[str, Any]:
        return {
            "id": f"llm-{uuid.uuid4().hex[:10]}",
            "timestamp": self._next_ts(),
            "role": role,
            "text": text,
            "content": text,
            "stopReason": "endTurn" if role == "assistant" else "",
            "provider": "claude-code-cli",
            "model": self._model,
        }

    def _resolve_cwd(self, session_id: str | None) -> str:
        """Return the correct working directory for a claude CLI invocation.

        Checks in-memory cache first, then searches ~/.claude/projects/
        for the session JSONL file to derive the project directory and
        reverse-map it to the original cwd.
        """
        if session_id and session_id in self._session_cwds:
            return self._session_cwds[session_id]

        if not session_id:
            return str(Path.home())

        # Search for the JSONL file across all project dirs
        from .session_scanner import (
            _cwd_to_project_dir_name,
            _detect_project_dirs,
            _find_live_claude_sessions,
            _project_dir_to_cwd,
        )

        # Populate the live-process cwd cache if empty (e.g. after backend restart)
        if not _project_dir_to_cwd:
            _find_live_claude_sessions()

        jsonl_name = f"{session_id}.jsonl"
        for project_dir in _detect_project_dirs():
            jsonl_path = project_dir / jsonl_name
            if jsonl_path.exists():
                # Prefer the scanner's live-process cache (populated by lsof — exact path)
                cwd = _project_dir_to_cwd.get(str(project_dir))
                if not cwd:
                    # Fallback: reverse the project dir name back to a cwd path.
                    # NOTE: this decode is ambiguous when the path contains literal hyphens
                    # (e.g. .worktrees/space-1 decodes to space/1).  Use only as last resort.
                    dir_name = project_dir.name
                    home = str(Path.home())
                    home_encoded = _cwd_to_project_dir_name(home)
                    if dir_name == home_encoded:
                        cwd = home
                    elif dir_name.startswith(home_encoded):
                        suffix = dir_name[len(home_encoded) :]
                        # Reverse: -- was /., - was /
                        restored = suffix.replace("--", "/.").replace("-", "/")
                        if IS_WINDOWS:
                            restored = restored.replace("/", "\\")
                        candidate = home + restored
                        if Path(candidate).is_dir():
                            cwd = candidate
                        else:
                            # Ambiguous hyphen decode produced a non-existent path;
                            # fall back to home to avoid a broken cd.
                            logger.warning(
                                f"Decoded cwd does not exist: {candidate} (from project dir {dir_name}); using home"
                            )
                            cwd = home
                    else:
                        cwd = home
                self._session_cwds[session_id] = cwd
                logger.info(f"Resolved cwd for session {session_id[:8]}: {cwd}")
                return cwd

        return str(Path.home())

    async def _run_claude_cli(
        self,
        prompt: str,
        *,
        resume_session_id: str | None = None,
    ) -> str:
        """Run claude -p and return the text output."""
        cmd = [
            self._cli_path,
            "-p",
            prompt,
            "--model",
            self._model,
            "--output-format",
            "text",
        ]
        if resume_session_id:
            cmd.extend(["--resume", resume_session_id])

        env = os.environ.copy()
        env.pop("CLAUDECODE", None)
        env.pop("CLAUDE_CODE_ENTRYPOINT", None)
        env.pop("CLAUDE_CODE_SESSION_ACCESS_TOKEN", None)
        env.pop("ANTHROPIC_API_KEY", None)

        cwd = self._resolve_cwd(resume_session_id)
        _log = logger.bind(component="adapter.claude-code")
        _log.info(
            "CLI invoke: cmd={}, cwd={}, resume={}",
            " ".join(cmd[:6]) + ("..." if len(cmd) > 6 else ""),
            cwd,
            resume_session_id or "none",
        )
        t0 = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=cwd,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=self._timeout)
        except asyncio.TimeoutError:
            _log.error("CLI timeout after {}s", self._timeout)
            proc.kill()
            return "[Claude CLI timeout]"
        except FileNotFoundError:
            _log.error("CLI not found at: {}", self._cli_path)
            return f"[Claude CLI not found at: {self._cli_path}]"
        except Exception as exc:
            _log.error("CLI spawn error: {}", exc)
            return f"[Claude CLI error: {exc}]"

        elapsed = time.monotonic() - t0
        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace").strip()
            _log.error(
                "CLI failed: exit={}, elapsed={:.1f}s, stderr={}",
                proc.returncode,
                elapsed,
                err[:500],
            )
            return f"[Claude CLI error (exit {proc.returncode}): {err[:300]}]"

        out = stdout.decode("utf-8", errors="replace").strip()
        _log.info("CLI ok: exit=0, elapsed={:.1f}s, len={}", elapsed, len(out))
        return out or "[empty response]"

    async def _get_or_create_sdk_session(self, cc_session_id: str, bot_id: str) -> SDKSession:
        """Get or create a persistent SDKSession for controller mode."""
        existing = self._sdk_sessions.get(cc_session_id)
        if existing and existing.is_alive:
            return existing

        # Clean up dead session
        if existing:
            await existing.stop()

        cwd = self._session_cwds.get(cc_session_id, str(Path.home()))

        # Determine resume session ID
        real_claude_id = self._real_session_ids.get(cc_session_id)
        if not real_claude_id and cwd:
            from .session_scanner import _cwd_to_project_dir_name

            proj_dir = Path.home() / ".claude" / "projects" / _cwd_to_project_dir_name(cwd)
            if (proj_dir / f"{cc_session_id}.jsonl").exists():
                real_claude_id = cc_session_id

        sdk = SDKSession(
            cli_path=self._cli_path,
            cwd=cwd,
            resume_session_id=real_claude_id,
            permission_mode="acceptEdits",
            model=self._model,
            effort=self._controller_effort.get(bot_id),
            on_control_request=lambda req: self._on_sdk_control_request(bot_id, req),
        )
        await sdk.start()
        self._sdk_sessions[cc_session_id] = sdk

        return sdk

    async def _on_sdk_control_request(self, bot_id: str, request: dict) -> dict:
        """Handle tool permission request from SDK session.

        AskUserQuestion and ExitPlanMode are forwarded to the frontend via
        WebSocket; all other tools are auto-approved (acceptEdits mode).
        """
        tool_name = request.get("tool_name", "")
        tool_input = request.get("input", {})
        _log = logger.bind(component="adapter.claude-code.sdk", bot_id=bot_id)

        if tool_name == "AskUserQuestion":
            _log.info("SDK: AskUserQuestion, forwarding to frontend")
            questions = tool_input.get("questions", [])

            # Create a future that will be resolved when the user replies
            reply_future = asyncio.get_event_loop().create_future()
            self._sdk_pending_replies[bot_id] = reply_future

            # Send to frontend via WebSocket
            if self._ws_broadcast_fn:
                await self._ws_broadcast_fn(
                    bot_id,
                    {
                        "type": "user_input_request",
                        "botId": bot_id,
                        "inputKind": "ask_user",
                        "questions": questions,
                        "eventKey": f"sdk-ask-{bot_id}-{id(reply_future)}",
                    },
                )

            # Wait for user reply (timeout 5 minutes)
            try:
                reply_text = await asyncio.wait_for(reply_future, timeout=300.0)
                _log.info("SDK: AskUserQuestion reply received: len={}", len(reply_text))
                return {"behavior": "allow", "updatedInput": {"result": reply_text}}
            except asyncio.TimeoutError:
                _log.warning("SDK: AskUserQuestion timed out")
                return {"behavior": "deny", "message": "User did not respond in time"}
            finally:
                self._sdk_pending_replies.pop(bot_id, None)

        elif tool_name == "ExitPlanMode":
            _log.info("SDK: ExitPlanMode, forwarding to frontend")
            plan_summary = tool_input.get("plan", "")
            allowed_prompts = tool_input.get("allowedPrompts", [])

            reply_future = asyncio.get_event_loop().create_future()
            self._sdk_pending_replies[bot_id] = reply_future

            if self._ws_broadcast_fn:
                await self._ws_broadcast_fn(
                    bot_id,
                    {
                        "type": "user_input_request",
                        "botId": bot_id,
                        "inputKind": "plan_options",
                        "planSummary": plan_summary,
                        "allowedPrompts": allowed_prompts,
                        "eventKey": f"sdk-plan-{bot_id}-{id(reply_future)}",
                    },
                )

            try:
                reply_text = await asyncio.wait_for(reply_future, timeout=300.0)
                _log.info("SDK: ExitPlanMode reply received: len={}", len(reply_text))
                return {"behavior": "allow", "updatedInput": {"result": reply_text}}
            except asyncio.TimeoutError:
                _log.warning("SDK: ExitPlanMode timed out")
                return {"behavior": "deny", "message": "User did not respond in time"}
            finally:
                self._sdk_pending_replies.pop(bot_id, None)

        else:
            # All other tools: auto-approve (acceptEdits mode)
            _log.debug("SDK: auto-approve tool={}", tool_name)
            return {"behavior": "allow"}

    async def _stream_controller_turn(
        self,
        user_text: str,
        cc_session_id: str,
        bot_id: str,
    ) -> AsyncIterator[AdapterEvent]:
        """Controller mode: send turn via persistent SDKSession."""
        _log = logger.bind(component="adapter.claude-code.controller", bot_id=bot_id)

        # Concurrency guard (keep existing lock)
        if cc_session_id not in self._controller_locks:
            self._controller_locks[cc_session_id] = asyncio.Lock()
        lock = self._controller_locks[cc_session_id]

        if lock.locked():
            yield AdapterEvent(
                type="assistant_final",
                bot_id=bot_id,
                text="Another message is already being processed.",
            )
            return

        async with lock:
            sdk = await self._get_or_create_sdk_session(cc_session_id, bot_id)
            # Ensure SessionWatcher is running for canonical_store persistence
            await self._get_or_create_watcher(cc_session_id, bot_id)
            _log.info("controller turn via SDK: session={}, resume={}", cc_session_id[:8], sdk.session_id or "none")

            # Signal watcher to skip WS broadcast while SDK stream is active
            self._sdk_turn_active[bot_id] = True
            full_parts: list[str] = []
            try:
                async for msg in sdk.send(user_text):
                    msg_type = msg.get("type", "")
                    content_types = (
                        [b.get("type") for b in msg.get("message", {}).get("content", []) if isinstance(b, dict)]
                        if msg_type == "assistant"
                        else "n/a"
                    )
                    _log.debug(
                        "SDK msg: type={} subtype={} content_types={}", msg_type, msg.get("subtype", ""), content_types
                    )

                    # Capture session_id from system init
                    if msg_type == "system" and msg.get("subtype") == "init":
                        new_sid = msg.get("session_id", "")
                        if new_sid:
                            from datetime import datetime
                            from datetime import timezone as _tz

                            self._real_session_ids[cc_session_id] = new_sid
                            self._real_session_bound_ts[cc_session_id] = datetime.now(tz=_tz.utc).strftime(
                                "%Y-%m-%dT%H:%M:%S"
                            )
                            cwd = self._session_cwds.get(cc_session_id, "")
                            if cwd:
                                self._session_cwds[new_sid] = cwd
                            self._persist_session_cwds()
                            _log.info("SDK: captured session_id={}", new_sid[:8])
                            # Notify SessionWatcher so it can read the JSONL file
                            watcher = self._session_watchers.get(cc_session_id)
                            if watcher:
                                watcher.on_new_session(new_sid)

                    # Stream assistant text
                    elif msg_type == "assistant":
                        content = msg.get("message", {}).get("content", [])
                        # All text blocks are sent as "result" (never intermediate)
                        # so that both granularity levels ("仅文字" and "含 Tool Call")
                        # always display assistant text.  This matches Observer mode
                        # where JSONL entries with null/empty stop_reason are
                        # conservatively treated as "result" (adapter.py line 744).
                        # Only tool_use blocks get content_kind="tool_call" below.
                        if isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict):
                                    if block.get("type") == "thinking":
                                        thinking = block.get("thinking", "") or block.get("text", "")
                                        if thinking:
                                            yield AdapterEvent(
                                                type="assistant_delta",
                                                bot_id=bot_id,
                                                text=thinking,
                                                content_kind="thinking",
                                            )
                                    elif block.get("type") == "text":
                                        chunk = block.get("text", "")
                                        if chunk:
                                            _log.info("SDK: text block len={} preview={}", len(chunk), chunk[:80])
                                            full_parts.append(chunk)
                                            yield AdapterEvent(
                                                type="assistant_delta",
                                                bot_id=bot_id,
                                                text=chunk,
                                                content_kind="result",
                                            )
                                    elif block.get("type") == "tool_use":
                                        name = block.get("name", "")
                                        _log.info("SDK: tool_call {}", name)
                                        # Format tool call display
                                        inp = block.get("input", {})
                                        args = ", ".join(f"{k}={repr(v)[:60]}" for k, v in list(inp.items())[:4])
                                        yield AdapterEvent(
                                            type="assistant_delta",
                                            bot_id=bot_id,
                                            text=f"{name}({args})",
                                            content_kind="tool_call",
                                        )

                    # Turn done
                    elif msg_type == "result":
                        result_text = msg.get("result", "")
                        subtype = msg.get("subtype", "")
                        if result_text and not full_parts:
                            full_parts.append(result_text)
                            yield AdapterEvent(
                                type="assistant_delta",
                                bot_id=bot_id,
                                text=result_text,
                                content_kind="result",
                            )
                        _log.info("SDK: turn complete subtype={}", subtype)

            except Exception as exc:
                _log.error("SDK turn error: {}", exc)
            finally:
                # Allow watcher to resume WS broadcast (e.g., terminal direct input)
                self._sdk_turn_active[bot_id] = False

            yield AdapterEvent(
                type="assistant_final",
                bot_id=bot_id,
                text="",
                payload={"full_reply": "".join(full_parts)},
            )

    # -- Config / bot management protocol --

    @classmethod
    def config_schema(cls) -> list[ConfigField]:
        return [
            ConfigField(
                "claude_cli_path",
                "Claude CLI Path",
                "string",
                default="claude",
                required=False,
                description="Path to claude CLI binary (auto-detected if empty)",
                group="connection",
            ),
            ConfigField(
                "anthropic_model",
                "Model",
                "string",
                default="claude-sonnet-4-6",
                description="Anthropic model to use",
                options=[
                    "claude-sonnet-4-6",
                    "claude-opus-4-6",
                    "claude-haiku-4-5-20251001",
                ],
                group="model",
            ),
        ]

    @classmethod
    def create_bot_schema(cls) -> list[CreateBotField]:
        return [
            CreateBotField("name", "Bot Name", "string", default="New Assistant"),
            CreateBotField(
                "cwd",
                "Working Directory",
                "string",
                default="~",
                required=False,
                description="Project directory for the Claude Code session",
            ),
        ]

    async def discover_bots(self) -> list[BotInfo]:
        """Scan for active Claude Code terminal sessions."""
        from .session_scanner import _project_dir_to_cwd

        bots = scan_active_sessions(
            active_minutes=self._scan_interval,
            max_results=10,
        )

        # Build set of session IDs already managed by this adapter
        # (includes both temp IDs and real IDs from tmux sessions)
        managed_session_ids: set[str] = set(self._tmux_sessions.keys())
        for tmux in self._tmux_sessions.values():
            if tmux.real_session_id:
                managed_session_ids.add(tmux.real_session_id)

        # Mark managed sessions so discover_only can flag them
        for b in bots:
            session_id = (b.metadata or {}).get("session_id", "")
            if session_id and session_id in managed_session_ids:
                if b.metadata is None:
                    b.metadata = {}
                b.metadata["managed"] = True

        # Cache session_id → cwd and bot_id → session_id mappings
        for b in bots:
            session_id = (b.metadata or {}).get("session_id", "")
            project_dir = (b.metadata or {}).get("project_dir", "")
            cwd = _project_dir_to_cwd.get(project_dir, "")
            if cwd and session_id:
                self._session_cwds[session_id] = cwd
            if session_id:
                self._bot_to_session[b.bot_id] = session_id
        self._persist_session_cwds()
        return bots

    async def create_bot(self, *, params: dict) -> BotInfo:
        """Create a new Claude Code bot with a stable ID derived from cwd.

        Starts a tmux session and uses a temporary session UUID as session_key.
        The real Claude session UUID is detected later by pre_warm/TmuxSession
        and the slot's sessionKey is updated accordingly.
        """
        from .session_scanner import _cwd_to_project_dir_name, derive_stable_bot_id

        name = params.get("name", "New Bot")
        raw_cwd = params.get("cwd", "").strip() or str(Path.home())
        cwd = str(Path(raw_cwd).expanduser().resolve())
        if not Path(cwd).is_dir():
            raise ValueError(f"Directory does not exist: {cwd}")

        # Derive bot_id from project dir + UUID suffix for multi-instance support
        project_dir = str(Path.home() / ".claude" / "projects" / _cwd_to_project_dir_name(cwd))
        base_id = derive_stable_bot_id(project_dir)

        # Use a temporary UUID as session_key (will be replaced once real session starts)
        temp_session_id = uuid.uuid4().hex[:12]
        stable_id = f"{base_id}-{temp_session_id[:6]}"
        self._session_cwds[temp_session_id] = cwd
        self._bot_to_session[stable_id] = temp_session_id
        # Record binding timestamp so fetch_history can filter stale JSONL
        # entries after a backend restart (after_ts fallback).
        from datetime import datetime
        from datetime import timezone as _tz

        self._real_session_bound_ts.setdefault(
            temp_session_id,
            datetime.now(tz=_tz.utc).strftime("%Y-%m-%dT%H:%M:%S"),
        )
        self._persist_session_cwds()

        return BotInfo(
            bot_id=stable_id,
            name=name,
            session_key=f"claude:{temp_session_id}",
            metadata={"project_dir": project_dir, "session_id": temp_session_id},
        )

    # -- AgentAdapter protocol --

    async def connect(self) -> bool:
        return True

    async def authenticate(self) -> bool:
        return True

    async def send_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
    ) -> str:
        user_text = str(text or "").strip()
        cc_session_id = _parse_claude_session_id(session_key)
        if not cc_session_id:
            raise ValueError(f"Invalid session_key format (expected 'claude:<ID>'): {session_key!r}")

        # Extract image attachment if present
        media_path, clean_text = _extract_media(user_text)
        has_image = media_path and os.path.isfile(media_path)
        if has_image:
            user_text = (
                f"Read and analyze the image at {media_path}\n\n"
                f"{clean_text or 'Please describe this image and extract key information.'}"
            )
            logger.info(f"[{bot_id}] Image attached: {media_path}")
        else:
            user_text = clean_text or user_text

        cancel_evt = self._cancel_events.pop(session_key, None)
        if cancel_evt:
            cancel_evt.clear()
        cancel_evt = asyncio.Event()
        self._cancel_events[session_key] = cancel_evt

        logger.info(f"[{bot_id}] Resuming Claude Code session {cc_session_id[:8]}...")
        # --resume is incompatible with --output-format stream-json
        # (produces no output), so always use text mode for resume.
        reply = await self._run_claude_cli(
            user_text,
            resume_session_id=cc_session_id,
        )

        return reply

    def _resolve_jsonl_path(self, session_id: str) -> Path:
        """Resolve the JSONL file path for a Claude Code session."""
        from .session_scanner import _detect_project_dirs

        jsonl_name = f"{session_id}.jsonl"
        for project_dir in _detect_project_dirs():
            p = project_dir / jsonl_name
            if p.exists():
                return p
        # Fallback to default project dir
        if self._project_dir:
            return self._project_dir / jsonl_name
        return Path.home() / ".claude" / "projects" / jsonl_name

    async def _get_tmux_session(self, session_id: str) -> TmuxSession:
        """Get or create a TmuxSession for the given session_id.

        Uses a per-session asyncio.Lock to prevent concurrent pre_warm and
        stream_user_turn from creating duplicate tmux sessions.
        """
        # Fast path: reuse alive session (no lock needed)
        existing = self._tmux_sessions.get(session_id)
        if existing and existing.is_alive():
            return existing

        # Serialize creation per session_id
        if session_id not in self._tmux_locks:
            self._tmux_locks[session_id] = asyncio.Lock()
        async with self._tmux_locks[session_id]:
            # Re-check after acquiring lock (another coroutine may have created it)
            existing = self._tmux_sessions.get(session_id)
            if existing and existing.is_alive():
                return existing

            # Clean up dead session
            if existing:
                await existing.stop()

            cwd = self._resolve_cwd(session_id)
            jsonl_path = self._resolve_jsonl_path(session_id)

            # Detect new session: no JSONL file means this session_id was
            # generated by create_bot and doesn't correspond to a real
            # Claude Code session yet. Stateless check — survives restarts.
            is_new = not jsonl_path.exists()

            # Recovery path: TryVoice UUID has no JSONL, but we have a
            # persisted real Claude session ID whose JSONL does exist.
            # Use the real JSONL so TmuxSession starts with --resume <real_id>.
            if is_new and session_id in self._real_session_ids:
                from .session_scanner import _detect_project_dirs as _dpd

                real_id = self._real_session_ids[session_id]
                for pdir in _dpd():
                    real_jsonl = pdir / f"{real_id}.jsonl"
                    if real_jsonl.exists():
                        is_new = False
                        jsonl_path = real_jsonl
                        logger.bind(component="adapter.claude-code").info(
                            "recovery: resolved real JSONL for session={} → real_id={}, path={}",
                            session_id[:8],
                            real_id[:8],
                            real_jsonl,
                        )
                        break

            if is_new:
                # Point JSONL path at the correct project dir for this cwd.
                from .session_scanner import _cwd_to_project_dir_name

                project_dir = Path.home() / ".claude" / "projects" / _cwd_to_project_dir_name(cwd)
                jsonl_path = project_dir / f"{session_id}.jsonl"  # placeholder

            # Build clean env (strip nested Claude Code vars)
            env = os.environ.copy()
            for key in (
                "CLAUDECODE",
                "CLAUDE_CODE_ENTRYPOINT",
                "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
                "ANTHROPIC_API_KEY",
            ):
                env.pop(key, None)

            session = TmuxSession(
                session_id=session_id,
                cli_path=self._cli_path,
                cwd=cwd,
                env=env,
                jsonl_path=jsonl_path,
                is_new=is_new,
                claimed_ids=self._claimed_session_ids,
                persisted_real_session_id=self._real_session_ids.get(session_id),
                on_real_session_id_changed=self._on_real_session_id_changed,
                on_organic_session_changed=self._on_organic_session_changed,
            )
            await session.start()
            self._tmux_sessions[session_id] = session
            # For existing (non-new) sessions the session_id IS the real
            # Claude ID — mark it claimed so new sessions don't grab its JSONL.
            if not is_new:
                self._claimed_session_ids.add(session_id)
            return session

    async def pre_warm(self, *, session_key: str) -> None:
        """Pre-create tmux session for a claude: session_key.

        Idempotent — _get_tmux_session checks is_alive() and reuses if possible.
        No-op for non-claude session keys.  Concurrent calls for the same
        session_id are coalesced so only one terminal window is opened.
        """
        cc_session_id = _parse_claude_session_id(session_key)
        if not cc_session_id:
            return
        if self._session_mode == "controller":
            return  # No tmux pre-warming in controller mode
        # Deduplicate concurrent pre_warm calls for the same session
        if cc_session_id in self._pre_warm_active:
            return
        self._pre_warm_active.add(cc_session_id)
        # Start health monitoring on first pre_warm (lazy — avoids startup race)
        if not self._crash_recovery_in_progress:
            if self._health_loop_task is None or self._health_loop_task.done():
                self.start_health_loop()
        _log = logger.bind(component="adapter.claude-code")
        _log.info("pre_warm: initializing tmux session={}", cc_session_id[:8])
        # Record binding timestamp (observer mode) so fetch_history can
        # filter stale JSONL entries after a backend restart.
        if cc_session_id not in self._real_session_bound_ts:
            from datetime import datetime
            from datetime import timezone as _tz

            self._real_session_bound_ts[cc_session_id] = datetime.now(tz=_tz.utc).strftime("%Y-%m-%dT%H:%M:%S")
            self._persist_session_cwds()
        try:
            session = await self._get_tmux_session(cc_session_id)
            # Start SessionWatcher — find bot_id from reverse mapping
            bot_id_for_watcher = None
            for bid, sid in self._bot_to_session.items():
                if sid == cc_session_id:
                    bot_id_for_watcher = bid
                    break
            await self._get_or_create_watcher(cc_session_id, bot_id_for_watcher or "")
            # Register tmux_name → bot_id for hook-based interactive forwarding
            if hasattr(session, "_tmux_name") and session._tmux_name:
                self._tmux_name_to_bot[session._tmux_name] = bot_id_for_watcher or ""
            # Open a visible terminal window so the user can see the session
            await session.open_terminal_window()
            # For new sessions, wait briefly for the real session ID to be
            # detected, then update the slot registry so discover matches.
            if session._is_new and not session.real_session_id:
                # Wait for _poll_until_ready to detect the real session ID
                for _ in range(30):
                    await asyncio.sleep(2.0)
                    if session.real_session_id:
                        break
            # NOTE: Do NOT call _update_slot_session_key here.
            # Changing the slotId/sessionKey at runtime causes the bot to
            # "disappear and reappear" from the frontend's perspective,
            # breaks active connections, and confuses
            # the user.  The real_session_id is used internally by
            # TmuxSession and fetch_history without modifying the slot.
            if session.real_session_id:
                # Just update the cwd cache so fetch_history works
                cwd = self._session_cwds.get(cc_session_id, "")
                if cwd and session.real_session_id != cc_session_id:
                    self._session_cwds[session.real_session_id] = cwd
        except Exception as exc:
            _log.warning("pre_warm failed for session={}: {}", cc_session_id[:8], exc)
        finally:
            self._pre_warm_active.discard(cc_session_id)

    async def _update_slot_session_key(self, old_session_id: str, new_session_id: str) -> None:
        """Update slot registry when real session ID is detected for a created bot.

        This ensures the slot's sessionKey matches what discover_bots returns,
        so the bot appears as "already added" instead of a phantom duplicate.
        """
        _log = logger.bind(component="adapter.claude-code")
        old_key = f"claude:{old_session_id}"
        new_key = f"claude:{new_session_id}"
        try:
            from backend.runtime.slot_registry import (
                list_slots,
                merge_slots,
                remove_slot,
                update_slot,
            )

            for slot in list_slots():
                if slot.get("sessionKey") == old_key:
                    # Update slotId suffix from temp UUID to real session UUID
                    old_slot_id = slot["slotId"]
                    new_slot_id = old_slot_id
                    if old_session_id[:6] in old_slot_id:
                        new_slot_id = old_slot_id.replace(old_session_id[:6], new_session_id[:6])
                    if old_slot_id != new_slot_id:
                        # slotId is immutable in update_slot, so remove + re-add
                        updated = dict(slot)
                        updated["slotId"] = new_slot_id
                        updated["sessionKey"] = new_key
                        remove_slot(old_slot_id)
                        merge_slots([updated])
                    else:
                        update_slot(old_slot_id, {"sessionKey": new_key})
                    # Also update internal cwd cache
                    cwd = self._session_cwds.pop(old_session_id, "")
                    if cwd:
                        self._session_cwds[new_session_id] = cwd
                    # Move tmux session entry so status/send use the new key
                    tmux = self._tmux_sessions.pop(old_session_id, None)
                    if tmux:
                        self._tmux_sessions[new_session_id] = tmux
                    # Update bot_to_session mapping with new bot_id
                    if old_slot_id != new_slot_id:
                        self._bot_to_session.pop(old_slot_id, None)
                        self._bot_to_session[new_slot_id] = new_session_id
                    else:
                        self._bot_to_session[old_slot_id] = new_session_id
                    self._persist_session_cwds()
                    _log.info(
                        "Slot session key updated: {} → {} (slot: {} → {})",
                        old_session_id[:8],
                        new_session_id[:8],
                        old_slot_id,
                        new_slot_id,
                    )
                    return
        except Exception as exc:
            _log.warning("Failed to update slot session key: {}", exc)

    async def attach_terminal(self, *, session_key: str) -> bool:
        """Open a visible terminal window attached to this bot's tmux session.

        Returns True if a terminal was opened, False if no tmux session exists.
        """
        cc_session_id = _parse_claude_session_id(session_key)
        if not cc_session_id:
            return False
        session = self._tmux_sessions.get(cc_session_id)
        if not session or not session.is_alive():
            return False
        await session.open_terminal_window()
        return True

    async def on_slot_removed(self, *, session_key: str) -> None:
        """Stop and clean up the tmux session for a removed claude: slot.

        Preserves ~/.claude/sessions/ history so the session can be resumed later.
        No-op for non-claude session keys.
        Also kills orphaned tmux sessions (e.g. after a server restart).
        """
        cc_session_id = _parse_claude_session_id(session_key)
        if not cc_session_id:
            return
        _log = logger.bind(component="adapter.claude-code")
        self._claimed_session_ids.discard(cc_session_id)

        # Clean up controller mode state (SDK sessions)
        sdk = self._sdk_sessions.pop(cc_session_id, None)
        if sdk:
            await sdk.stop()
        self._controller_locks.pop(cc_session_id, None)
        self._real_session_ids.pop(cc_session_id, None)

        # Stop SessionWatcher
        watcher = self._session_watchers.pop(cc_session_id, None)
        if watcher:
            await watcher.stop()
        # Clean up tmux_name → bot_id mapping
        tmux_session_for_cleanup = self._tmux_sessions.get(cc_session_id)
        if tmux_session_for_cleanup and hasattr(tmux_session_for_cleanup, "_tmux_name"):
            self._tmux_name_to_bot.pop(tmux_session_for_cleanup._tmux_name, None)
        session = self._tmux_sessions.pop(cc_session_id, None)
        if session:
            if session.real_session_id:
                self._claimed_session_ids.discard(session.real_session_id)
            _log.info("on_slot_removed: stopping tmux session={}", cc_session_id[:8])
            try:
                await session.stop()
            except Exception as exc:
                _log.warning("on_slot_removed stop failed session={}: {}", cc_session_id[:8], exc)
        else:
            # Try to kill orphaned tmux session directly (survives server restarts)
            tmux_name = f"vs-claude-{cc_session_id[:8]}"
            _log.info("on_slot_removed: killing orphaned tmux session {}", tmux_name)
            try:
                proc = await asyncio.create_subprocess_exec(
                    "tmux",
                    "kill-session",
                    "-t",
                    tmux_name,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except Exception:
                pass  # session may not exist — that's fine

        # Stop health loop when no tmux sessions remain
        if not self._tmux_sessions:
            await self.stop_health_loop()

    async def cleanup_orphaned_tmux_sessions(self) -> int:
        """Kill vs-claude-* tmux sessions that are not in the slot registry.

        Called during backend startup to reclaim resources from sessions
        orphaned by server restarts or session-key rotation.
        Returns the number of sessions killed.
        """
        _log = logger.bind(component="adapter.claude-code")
        try:
            proc = await asyncio.create_subprocess_exec(
                "tmux",
                "list-sessions",
                "-F",
                "#{session_name}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
            all_sessions = stdout.decode().strip().splitlines()
        except Exception:
            return 0

        vs_sessions = [s for s in all_sessions if s.startswith("vs-claude-")]
        if not vs_sessions:
            return 0

        # Build set of tmux names that SHOULD exist (from slot registry)
        from backend.runtime.slot_registry import list_slots

        active_ids: set[str] = set()
        for slot in list_slots():
            sk = slot.get("sessionKey", "")
            cc_id = _parse_claude_session_id(sk)
            if cc_id:
                active_ids.add(cc_id[:8])

        killed = 0
        for name in vs_sessions:
            short_id = name.removeprefix("vs-claude-")
            if short_id not in active_ids:
                _log.info("Killing orphaned tmux session: {}", name)
                try:
                    p = await asyncio.create_subprocess_exec(
                        "tmux",
                        "kill-session",
                        "-t",
                        name,
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                    )
                    await asyncio.wait_for(p.wait(), timeout=5.0)
                    killed += 1
                except Exception:
                    pass
        if killed:
            _log.info("Cleaned up {} orphaned tmux session(s)", killed)
        return killed

    async def get_session_status(self, *, session_key: str) -> str:
        """Return connection status for a claude: session_key.

        Returns:
            "connected"    — ready for input (tmux prompt or controller idle)
            "processing"   — actively generating/tool-using
            "warming"      — loading (--resume in progress)
            "disconnected" — session not running
        """
        cc_session_id = _parse_claude_session_id(session_key)
        if not cc_session_id:
            return "connected"  # Non-tmux sessions are always "connected"

        if self._session_mode == "controller":
            # Controller mode: SDK session status
            sdk = self._sdk_sessions.get(cc_session_id)
            if sdk and sdk.is_turn_active:
                return "processing"
            if sdk and sdk.is_alive:
                return "connected"
            return "connected"  # SDK not started yet = will start on first message

        # Observer mode: tmux-based status
        session = self._tmux_sessions.get(cc_session_id)
        if not session or not session.is_alive():
            # Session not yet created but pre_warm is running → "warming"
            if cc_session_id in self._pre_warm_active:
                return "warming"
            return "disconnected"
        # Check if a turn is in progress (watcher waiting for done)
        bot_id_for_session = None
        for bid, sid in self._bot_to_session.items():
            if sid == cc_session_id:
                bot_id_for_session = bid
                break
        if bot_id_for_session and bot_id_for_session in self._pending_turn_done:
            return "processing"
        if session._ready:
            return "connected"
        return "warming"

    async def stream_user_turn(
        self,
        *,
        bot_id: str,
        session_key: str,
        text: str,
        timeout_seconds: int = 240,
        client_msg_id: str = "",
    ) -> AsyncIterator[AdapterEvent]:
        """Stream assistant reply as AdapterEvent deltas via tmux persistent session."""
        user_text = str(text or "").strip()
        media_path, clean_text = _extract_media(user_text)
        has_image = media_path and os.path.isfile(media_path)
        if has_image:
            user_text = (
                f"Read and analyze the image at {media_path}\n\n"
                f"{clean_text or 'Please describe this image and extract key information.'}"
            )
        else:
            user_text = clean_text or user_text

        cc_session_id = _parse_claude_session_id(session_key)
        _log = logger.bind(component="adapter.claude-code")

        if not cc_session_id:
            raise ValueError(f"Invalid session_key format (expected 'claude:<ID>'): {session_key!r}")

        if self._session_mode == "controller":
            # Controller mode: per-turn subprocess with --output-format stream-json
            _log.info("stream_user_turn via controller: session={}", cc_session_id[:8])
            # Enqueue client_msg_id so watcher identifies this as a web-originated turn
            # (same as observer mode) — prevents "via terminal" mislabel and sort bugs.
            if client_msg_id:
                self._pending_client_msg_ids.setdefault(bot_id, collections.deque()).append(client_msg_id)
            async for evt in self._stream_controller_turn(user_text, cc_session_id, bot_id):
                yield evt
        else:
            # Observer mode: tmux persistent session + JSONL watching
            _log.info("stream_user_turn via tmux: session={}", cc_session_id[:8])
            tmux_session = await self._get_tmux_session(cc_session_id)
            tmux_session._bot_id = bot_id

            # Ensure watcher is running (it handles all WS push)
            await self._get_or_create_watcher(cc_session_id, bot_id)

            # Enqueue client_msg_id so watcher can attach it to the JSONL user message
            if client_msg_id:
                self._pending_client_msg_ids.setdefault(bot_id, collections.deque()).append(client_msg_id)

            # Send text to tmux (watcher handles output detection)
            await tmux_session.send_text(user_text)

            # For new bots, the JSONL file may not exist until Claude
            # processes the first message.  Retry detection so the
            # SessionWatcher gets the real session ID.
            if tmux_session.real_session_id is None:
                for _ in range(20):  # up to 10 s (20 × 0.5 s)
                    await asyncio.sleep(0.5)
                    if tmux_session._detect_real_session_id():
                        break

            # Wait for watcher to signal turn completion.
            # When timeout_seconds <= 0 the caller (orchestrator watchdog)
            # controls lifetime via task cancellation, so wait indefinitely.
            done_event = asyncio.Event()
            self._pending_turn_done[bot_id] = done_event
            if not hasattr(self, "_turn_start_ts"):
                self._turn_start_ts: dict[str, float] = {}
            self._turn_start_ts[bot_id] = asyncio.get_event_loop().time()
            heartbeat_interval = 10.0
            try:
                if timeout_seconds > 0:
                    await asyncio.wait_for(done_event.wait(), timeout=float(timeout_seconds))
                else:
                    while not done_event.is_set():
                        try:
                            await asyncio.wait_for(
                                asyncio.shield(done_event.wait()),
                                timeout=heartbeat_interval,
                            )
                        except asyncio.TimeoutError:
                            # Turn still active — send heartbeat status
                            if self._ws_broadcast_fn:
                                elapsed = int(asyncio.get_event_loop().time() - (self._turn_start_ts.get(bot_id, 0)))
                                await self._ws_broadcast_fn(
                                    bot_id,
                                    {
                                        "type": "status",
                                        "botId": bot_id,
                                        "text": f"处理中... ({elapsed}s)",
                                    },
                                )
            except asyncio.TimeoutError:
                _log.warning("stream_user_turn: turn timeout for session={}", cc_session_id[:8])
            finally:
                self._pending_turn_done.pop(bot_id, None)
                self._turn_start_ts.pop(bot_id, None)

            yield AdapterEvent(type="assistant_final", bot_id=bot_id)

    async def send_user_input_reply(
        self,
        *,
        bot_id: str,
        session_key: str,
        reply_text: str,
    ) -> None:
        """Relay user's answer to an interactive Claude Code prompt via tmux."""
        _log = logger.bind(component="adapter.claude-code", bot_id=bot_id)
        cc_session_id = _parse_claude_session_id(session_key)
        if not cc_session_id:
            _log.warning("send_user_input_reply: not a claude session, ignoring")
            return
        if self._session_mode == "controller":
            # Controller mode: resolve the pending SDK permission reply
            fut = self._sdk_pending_replies.pop(bot_id, None)
            if fut and not fut.done():
                fut.set_result(reply_text)
                _log.info("SDK: user input reply delivered: len={}", len(reply_text))
            else:
                _log.warning("SDK: no pending reply for bot={}", bot_id)
            return
        tmux_session = await self._get_tmux_session(cc_session_id)
        await tmux_session.send_input(reply_text)
        _log.info("User input reply sent: len={}", len(reply_text))

    async def handle_hook_interactive(self, hook_data: dict) -> dict:
        """Handle an interactive hook callback from a Claude Code TUI session.

        Creates a pending Future, broadcasts user_input_request to the
        frontend, and blocks until the user replies or timeout.
        Returns a dict with 'decision' key for the hook script.
        """
        import uuid as _uuid

        tmux_name = hook_data.get("tmux_name", "")
        hook_event = hook_data.get("hook_event_name", "")
        tool_name = hook_data.get("tool_name", "")
        tool_input = hook_data.get("tool_input", {})

        _log = logger.bind(component="adapter.claude-code.hook", tmux_name=tmux_name)

        bot_id = self._tmux_name_to_bot.get(tmux_name)
        if not bot_id:
            _log.warning("hook interactive: unknown tmux_name={}", tmux_name)
            return {"decision": "allow", "error": "unknown_tmux_name"}

        request_id = f"hook-{_uuid.uuid4().hex[:12]}"
        reply_future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._hook_pending_replies[request_id] = reply_future

        # Build WS payload based on hook event type
        if hook_event == "PermissionRequest":
            if tool_name == "ExitPlanMode":
                plan_summary = tool_input.get("plan", "")
                allowed_prompts = tool_input.get("allowedPrompts", [])
                ws_payload = {
                    "type": "user_input_request",
                    "botId": bot_id,
                    "inputKind": "plan_options",
                    "planSummary": plan_summary,
                    "allowedPrompts": allowed_prompts,
                    "eventKey": request_id,
                }
            else:
                # Permission request for Bash, Edit, MCP, etc.
                description = _format_tool_description(tool_name, tool_input)
                ws_payload = {
                    "type": "user_input_request",
                    "botId": bot_id,
                    "inputKind": "permission",
                    "toolName": tool_name,
                    "toolDescription": description,
                    "eventKey": request_id,
                }
        elif hook_event == "Elicitation":
            questions = hook_data.get("questions", [])
            ws_payload = {
                "type": "user_input_request",
                "botId": bot_id,
                "inputKind": "ask_user",
                "questions": questions,
                "eventKey": request_id,
            }
        else:
            _log.warning("hook interactive: unknown event={}", hook_event)
            self._hook_pending_replies.pop(request_id, None)
            return {"decision": "allow"}

        # Save payload for WS reconnect resend
        self._hook_pending_payloads[request_id] = ws_payload

        # Broadcast to frontend
        if self._ws_broadcast_fn:
            await self._ws_broadcast_fn(bot_id, ws_payload)
            _log.info("hook interactive: broadcast {} for tool={}", hook_event, tool_name)

        # Wait for user reply — timeout matches hook script's curl timeout.
        # The hook script retries on backend restart, so a new Future will be
        # created if this one expires. No artificial "expired" state.
        try:
            reply_text = await asyncio.wait_for(reply_future, timeout=3590.0)
            decision = "deny" if reply_text.lower().strip() in ("deny", "reject", "no") else "allow"
            _log.info("hook interactive: user replied decision={}", decision)
        except asyncio.TimeoutError:
            decision = "deny"
            reply_text = ""
            _log.warning("hook interactive: timeout, defaulting to deny")
        finally:
            self._hook_pending_replies.pop(request_id, None)
            self._hook_pending_payloads.pop(request_id, None)

        # Build hook response
        if hook_event == "PermissionRequest":
            return {
                "decision": decision,
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {"behavior": decision},
                },
            }
        else:
            return {"decision": decision, "reply": reply_text if decision == "allow" else ""}

    async def handle_session_start_hook(self, hook_data: dict) -> dict:
        """Handle SessionStart hook — Claude Code switched to a new JSONL session.

        Updates real_session_id mapping and notifies the SessionWatcher
        to start tracking the new JSONL file.
        """
        tmux_name = hook_data.get("tmux_name", "")
        new_session_id = hook_data.get("session_id", "")
        _log = logger.bind(component="adapter.claude-code.hook")

        if not tmux_name or not new_session_id:
            return {"ok": False, "error": "missing fields"}

        bot_id = self._tmux_name_to_bot.get(tmux_name)
        if not bot_id:
            _log.debug("session-start hook: unknown tmux_name={}", tmux_name)
            return {"ok": False, "error": "unknown_tmux_name"}

        cc_session_id = self._bot_to_session.get(bot_id, "")
        if not cc_session_id:
            return {"ok": False, "error": "no_session"}

        # Update real session ID mapping
        from datetime import datetime
        from datetime import timezone as _tz

        old_real = self._real_session_ids.get(cc_session_id, "")
        self._real_session_ids[cc_session_id] = new_session_id
        self._real_session_bound_ts[cc_session_id] = datetime.now(tz=_tz.utc).strftime("%Y-%m-%dT%H:%M:%S")
        self._persist_session_cwds()

        # Notify watcher
        watcher = self._session_watchers.get(cc_session_id)
        if watcher:
            watcher.on_new_session(new_session_id)
            _log.info(
                "session-start hook: switched {} -> {} for bot={}",
                old_real[:8] if old_real else "(none)",
                new_session_id[:8],
                bot_id,
            )

        return {"ok": True}

    async def handle_slash_command_reply(self, *, bot_id: str, event_key: str, selection: str) -> None:
        """Handle /model or /effort selection from the web UI.

        Observer mode: sends the slash command to Claude Code's tmux TUI.
        Controller mode: updates adapter state and restarts the SDK session
        so the next turn uses the new model/effort via CLI flags.
        """
        _log = logger.bind(component="adapter.claude-code.slash", bot_id=bot_id)
        session_id = self._bot_to_session.get(bot_id, "")
        if not session_id:
            _log.warning("slash reply: no session for bot={}", bot_id)
            return

        # Determine the slash command from eventKey (slash-model-xxx or slash-effort-xxx)
        if "model" in event_key:
            cmd = "/model"
        elif "effort" in event_key:
            cmd = "/effort"
        else:
            _log.warning("slash reply: unknown command in eventKey={}", event_key)
            return

        _log.info("slash reply: {} → selection={}, mode={}", cmd, selection, self._session_mode)

        if self._session_mode == "controller":
            # Controller mode: update adapter state and restart SDK session.
            # The new model/effort will be passed as CLI flags on next spawn.
            if cmd == "/model":
                self._model = selection
                _log.info("controller: model updated to {}", selection)
            elif cmd == "/effort":
                self._controller_effort[bot_id] = selection
                _log.info("controller: effort updated to {} for bot={}", selection, bot_id)

            # Restart SDK session so new flags take effect on next turn
            sdk = self._sdk_sessions.get(session_id)
            if sdk and sdk.is_alive:
                _log.info("controller: restarting SDK session for new {}", cmd)
                await sdk.stop()
                # Session will be re-created with new params on next turn
            return

        # Observer mode: send keystrokes to tmux TUI
        tmux = self._tmux_sessions.get(session_id)
        if not tmux:
            _log.warning("slash reply: no tmux session for {}", session_id[:8])
            return

        from .tmux_session import _run_tmux

        # Step 1: Send the slash command to trigger the TUI selector
        await _run_tmux("send-keys", "-t", tmux._tmux_name, cmd, "Enter")
        await asyncio.sleep(0.5)  # Wait for selector to render

        # Step 2: Type the selection text (type-ahead filter in Claude Code's selector)
        await _run_tmux("send-keys", "-t", tmux._tmux_name, selection)
        await asyncio.sleep(0.2)

        # Step 3: Press Enter to confirm
        await _run_tmux("send-keys", "-t", tmux._tmux_name, "Enter")

    def resolve_hook_reply(self, event_key: str, reply_text: str) -> bool:
        """Resolve a pending hook reply by eventKey. Returns True if found."""
        fut = self._hook_pending_replies.get(event_key)
        if fut and not fut.done():
            fut.set_result(reply_text)
            return True
        return False

    async def resend_pending_hook_requests(self, bot_id: str | None = None) -> int:
        """Resend pending hook interactive requests to the frontend.

        Called on WS reconnect so that permission cards reappear after
        a browser refresh. Returns the number of requests resent.
        """
        count = 0
        for req_id, payload in list(self._hook_pending_payloads.items()):
            if bot_id and payload.get("botId") != bot_id:
                continue
            # Only resend if the Future is still pending
            fut = self._hook_pending_replies.get(req_id)
            if fut and not fut.done() and self._ws_broadcast_fn:
                await self._ws_broadcast_fn(payload["botId"], payload)
                count += 1
        if count:
            logger.bind(component="adapter.claude-code.hook").info(
                "Resent {} pending hook request(s) on reconnect", count
            )
        return count

    async def stream_assistant_output(
        self,
        *,
        bot_id: str,
        text: str,
    ) -> AsyncIterator[AdapterEvent]:
        """Split the completed reply into TTS-friendly chunks."""
        chunks = _chunk_text(text)
        for i, chunk in enumerate(chunks):
            if i < len(chunks) - 1:
                yield AdapterEvent(type="assistant_delta", bot_id=bot_id, text=chunk)
            else:
                yield AdapterEvent(type="assistant_final", bot_id=bot_id, text=chunk)

    async def cancel(self, *, bot_id: str, turn_id: str | None = None) -> bool:
        _log = logger.bind(component="adapter.claude-code")

        # Signal internal cancel events
        for key, evt in self._cancel_events.items():
            evt.set()

        session_id = self._bot_to_session.get(bot_id, "")
        _log.info(
            "cancel: bot_id={}, session_id={}, mode={}",
            bot_id,
            session_id or "(none)",
            self._session_mode,
        )

        if self._session_mode == "controller":
            # Controller mode: interrupt SDK session gracefully
            if session_id:
                sdk = self._sdk_sessions.get(session_id)
                if sdk and sdk.is_alive:
                    _log.info("cancel: interrupting SDK session={}", session_id[:8])
                    await sdk.interrupt()
                else:
                    _log.info("cancel: no active SDK session for {}", session_id[:8])
            return True

        # Observer mode: send Escape to tmux session
        if session_id:
            tmux = self._tmux_sessions.get(session_id)
            if tmux:
                await tmux.send_escape()
            else:
                _log.warning("cancel: tmux session object not found for {}", session_id)
        else:
            _log.warning("cancel: no session_id mapped for bot_id={}", bot_id)

        # Release the pending turn done event so the next stream_user_turn
        # is not blocked waiting for the cancelled turn to complete.
        done_event = self._pending_turn_done.pop(bot_id, None)
        if done_event:
            done_event.set()
            _log.info("cancel: released pending turn done for bot={}", bot_id)

        # Clear tool_active state and notify frontend
        self._watcher_tool_state[bot_id] = False
        if self._ws_broadcast_fn:
            await self._ws_broadcast_fn(
                bot_id,
                {
                    "type": "tool_idle",
                    "botId": bot_id,
                },
            )

        return True

    async def switch_slot(self, *, slot_id: str) -> bool:
        return True

    async def fetch_history(self, *, session_key: str, limit: int = 100) -> list[dict[str, Any]]:
        cc_session_id = _parse_claude_session_id(session_key)
        if not cc_session_id:
            return []

        # Check if TmuxSession has detected the real session ID
        tmux = self._tmux_sessions.get(cc_session_id)

        # Compute cutoff timestamp: only return messages created after
        # this TryVoice bot session started.  This prevents stale history
        # from a resumed Claude Code session leaking into the web UI.
        after_ts = ""
        if tmux and tmux._start_ts > 0:
            import asyncio as _aio
            import time as _time

            wall_start = _time.time() - (_aio.get_event_loop().time() - tmux._start_ts)
            from datetime import datetime, timezone

            after_ts = datetime.fromtimestamp(wall_start, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")

        if tmux and tmux.real_session_id and tmux.real_session_id != cc_session_id:
            real_proj_dir = tmux.jsonl_path.parent if tmux.jsonl_path.exists() else None
            if real_proj_dir:
                return _read_session_jsonl(real_proj_dir, tmux.real_session_id, limit, after_ts=after_ts)

        # Persisted fallback: when after_ts is empty (no live tmux _start_ts —
        # e.g. after backend restart while sessions are still alive), fall back
        # to the persisted binding timestamp so we don't load the entire JSONL.
        # This covers both observer (tmux) and controller (SDK) modes.
        if not after_ts:
            after_ts = self._real_session_bound_ts.get(cc_session_id, "")

        real_claude_id = self._real_session_ids.get(cc_session_id)
        if real_claude_id and not (tmux and tmux.real_session_id):
            cwd = self._session_cwds.get(cc_session_id, "")
            if cwd:
                from .session_scanner import _cwd_to_project_dir_name as _c2p

                proj_dir = Path.home() / ".claude" / "projects" / _c2p(cwd)
                jsonl = proj_dir / f"{real_claude_id}.jsonl"
                if jsonl.exists():
                    return _read_session_jsonl(proj_dir, real_claude_id, limit, after_ts=after_ts)

        # Try cached cwd first
        cwd = self._session_cwds.get(cc_session_id, "")
        if cwd:
            from .session_scanner import _cwd_to_project_dir_name

            proj_dir = Path.home() / ".claude" / "projects" / _cwd_to_project_dir_name(cwd)
            if proj_dir.is_dir():
                return _read_session_jsonl(proj_dir, cc_session_id, limit, after_ts=after_ts)

        # Fallback: scan ALL project dirs for this session's JSONL
        from .session_scanner import _detect_project_dirs

        for proj_dir in _detect_project_dirs():
            jsonl_path = proj_dir / f"{cc_session_id}.jsonl"
            if jsonl_path.exists():
                # Cache for next time
                self._session_cwds[cc_session_id] = str(proj_dir)
                return _read_session_jsonl(proj_dir, cc_session_id, limit, after_ts=after_ts)

        # Last resort: default project dir
        if self._project_dir:
            return _read_session_jsonl(self._project_dir, cc_session_id, limit, after_ts=after_ts)

        return []

    async def resume_session(self, *, session_key: str) -> bool:
        return True

    async def reset_session(self, *, session_key: str) -> bool:
        self._cancel_events.pop(session_key, None)
        cc_session_id = _parse_claude_session_id(session_key)
        if cc_session_id:
            if self._session_mode == "controller":
                # Controller mode: stop SDK session and clear session mapping
                # so the next turn starts a fresh conversation (no --resume).
                sdk = self._sdk_sessions.pop(cc_session_id, None)
                if sdk:
                    await sdk.stop()
                self._real_session_ids.pop(cc_session_id, None)
                self._persist_session_cwds()
                logger.bind(component="adapter.claude-code").info(
                    "reset_session (controller): cleared session mapping for {}", cc_session_id[:8]
                )
            else:
                # Observer mode: send /clear or kill tmux
                tmux_session = self._tmux_sessions.get(cc_session_id)
                if tmux_session and tmux_session.is_alive():
                    # Prefer /clear over kill — keeps tmux alive, avoids restart cost
                    cleared = await tmux_session.send_clear()
                    if not cleared:
                        # CLI not at prompt; fall back to kill + recreate on next turn
                        self._tmux_sessions.pop(cc_session_id, None)
                        await tmux_session.stop()
                else:
                    # Dead or missing — just clean up the reference
                    self._tmux_sessions.pop(cc_session_id, None)
        return True

    async def compact_session(self, *, session_key: str) -> bool:
        """Send /compact to Claude Code to compress conversation context."""
        cc_session_id = _parse_claude_session_id(session_key)
        if not cc_session_id:
            return False
        _log = logger.bind(component="adapter.claude-code")
        if self._session_mode == "controller":
            # Controller mode: send /compact as a regular user message via SDK.
            # Claude Code internally recognises the slash command and performs
            # compaction, same as interactive mode.
            sdk = self._sdk_sessions.get(cc_session_id)
            if not sdk or not sdk.is_alive:
                _log.warning("compact_session(controller): no live SDK session")
                return False
            try:
                _log.info("compact_session(controller): sending /compact via SDK")
                async for msg in sdk.send("/compact"):
                    msg_type = msg.get("type", "")
                    if msg_type == "system" and msg.get("subtype") == "init":
                        new_sid = msg.get("session_id", "")
                        if new_sid:
                            self._real_session_ids[cc_session_id] = new_sid
                            _log.info("compact: session switched to {}", new_sid[:8])
                            watcher = self._session_watchers.get(cc_session_id)
                            if watcher:
                                watcher.on_new_session(new_sid)
                    if msg_type == "result":
                        break
                _log.info("compact_session(controller): done")
                return True
            except Exception as exc:
                _log.error("compact_session(controller) failed: {}", exc)
                return False
        tmux_session = self._tmux_sessions.get(cc_session_id)
        if tmux_session and tmux_session.is_alive():
            return await tmux_session.send_compact()
        return False

    async def poll_events(self, *, session_key: str, limit: int = 30) -> list[dict[str, Any]]:
        return []

    def report_capabilities(self) -> AdapterCapabilities:
        return self._caps

    def slash_commands(self, session_key: str = "") -> list[dict[str, Any]]:
        return [
            {"cmd": "/clear", "label": "会话已重置", "description": "Clear session"},
            {"cmd": "/compact", "label": "上下文已压缩", "description": "Compact conversation"},
        ]

    async def scan_recovering_turns(self) -> list[dict[str, Any]]:
        """Scan tmux sessions for active Claude Code turns after backend restart.

        Lists all ``vs-claude-*`` tmux sessions, checks if Claude is NOT at the
        input prompt (meaning it is actively processing), and cross-references
        with the persisted ``_bot_to_session`` mapping to return turn info.

        Returns list of dicts with keys: bot_id, session_id, tmux_name.
        """
        _log = logger.bind(component="adapter.claude-code")
        try:
            proc = await asyncio.create_subprocess_exec(
                "tmux",
                "list-sessions",
                "-F",
                "#{session_name}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
            all_sessions = stdout.decode().strip().splitlines()
        except Exception:
            return []

        vs_sessions = [s for s in all_sessions if s.startswith("vs-claude-")]
        if not vs_sessions:
            return []

        # Build reverse map: tmux_name_short (session_id[:8]) -> bot_id
        short_id_to_bot: dict[str, tuple[str, str]] = {}
        for bot_id, session_id in self._bot_to_session.items():
            short_id_to_bot[session_id[:8]] = (bot_id, session_id)

        active: list[dict[str, Any]] = []
        for tmux_name in vs_sessions:
            short_id = tmux_name.removeprefix("vs-claude-")
            if short_id not in short_id_to_bot:
                continue

            # Capture the last 10 lines of the tmux pane
            try:
                pane_proc = await asyncio.create_subprocess_exec(
                    "tmux",
                    "capture-pane",
                    "-t",
                    tmux_name,
                    "-p",
                    "-S",
                    "-10",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                pane_stdout, _ = await asyncio.wait_for(
                    pane_proc.communicate(),
                    timeout=5.0,
                )
                pane_text = pane_stdout.decode("utf-8", errors="replace")
            except Exception:
                continue

            # If Claude is at the prompt, the turn is NOT active
            if _is_claude_prompt(pane_text):
                continue

            bot_id, session_id = short_id_to_bot[short_id]
            active.append(
                {
                    "bot_id": bot_id,
                    "session_id": session_id,
                    "tmux_name": tmux_name,
                }
            )
            _log.info(
                "Recovering active turn: bot={}, tmux={}",
                bot_id,
                tmux_name,
            )

        _log.info(
            "scan_recovering_turns: {}/{} tmux sessions have active turns",
            len(active),
            len(vs_sessions),
        )
        return active
