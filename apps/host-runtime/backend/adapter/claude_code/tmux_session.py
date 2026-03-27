"""Persistent Claude Code TUI session via tmux + JSONL file watching.

Manages a tmux session running ``claude --resume <session_id>`` and
monitors the session JSONL file for incremental assistant replies.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import sys
from pathlib import Path
from typing import Any

from loguru import logger

_LOG_COMPONENT = "adapter.claude-code.tmux"


def _generate_hook_settings(
    output_dir: Path,
    tmux_name: str,
    hook_port: int,
) -> Path:
    """Generate a Claude Code settings file with interactive forwarding hooks.

    Returns the path to the generated settings JSON file.
    """
    hooks_dir = Path.home() / ".tryvoice" / "hooks"
    hook_script = hooks_dir / "interactive-forward.sh"
    session_start_script = hooks_dir / "session-start-forward.sh"
    settings = {
        "hooks": {
            "SessionStart": [
                {
                    "matcher": "",
                    "hooks": [
                        {
                            "type": "command",
                            "command": str(session_start_script),
                            "timeout": 10,
                        }
                    ],
                }
            ],
            "PermissionRequest": [
                {
                    "matcher": "",
                    "hooks": [
                        {
                            "type": "command",
                            "command": str(hook_script),
                            "timeout": 3600,
                        }
                    ],
                }
            ],
            "Elicitation": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": str(hook_script),
                            "timeout": 3600,
                        }
                    ],
                }
            ],
        }
    }
    # Ensure hook scripts are deployed
    hooks_dir.mkdir(parents=True, exist_ok=True)
    import shutil

    bundled_script = Path(__file__).parent / "hooks" / "interactive-forward.sh"
    if bundled_script.exists():
        shutil.copy2(bundled_script, hook_script)
        hook_script.chmod(0o755)

    # Deploy session-start hook script
    session_start_bundled = Path(__file__).parent / "hooks" / "session-start-forward.sh"
    if session_start_bundled.exists():
        shutil.copy2(session_start_bundled, session_start_script)
        session_start_script.chmod(0o755)

    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{tmux_name}.json"
    path.write_text(json.dumps(settings, indent=2))
    return path


def _is_queue_session(jsonl_path: Path) -> bool:
    """Check if a JSONL file is a transient queue-operation session.

    Claude Code creates these when a user message arrives while the CLI is
    busy with tool calls.  They are short-lived (typically 2-6 messages)
    and should not replace the main conversation JSONL for tracking.
    """
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            first_line = f.readline()
            if first_line:
                return json.loads(first_line).get("type") == "queue-operation"
    except Exception:
        pass
    return False


async def _run_tmux(*args: str, timeout: float = 10.0) -> tuple[str, int]:
    """Run a tmux subcommand and return (stdout, returncode)."""
    cmd = ["tmux", *args]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        out = stdout.decode("utf-8", errors="replace").rstrip("\n")
        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace").strip()
            if err:
                # Log at WARNING for session-lifecycle commands, DEBUG for others
                lvl = "WARNING" if args[0] in ("new-session", "kill-session", "kill-server") else "DEBUG"
                _log = logger.bind(component=_LOG_COMPONENT)
                _log.log(lvl, "tmux {} rc={} stderr: {}", args[0], proc.returncode, err)
        return out, proc.returncode or 0
    except asyncio.TimeoutError:
        logger.bind(component=_LOG_COMPONENT).warning("tmux cmd timeout: {}", cmd)
        return "", 1
    except FileNotFoundError:
        logger.bind(component=_LOG_COMPONENT).error("tmux binary not found")
        return "", 127


def _is_claude_prompt(pane_text: str) -> bool:
    """Check if the tmux pane shows Claude's input prompt."""
    # Claude TUI prompt patterns: "❯ " or "> " at end, or the box drawing chars
    for line in pane_text.splitlines():
        stripped = line.strip()
        if stripped.endswith("❯") or stripped == "❯":
            return True
        if "? for shortcuts" in stripped:
            return True
    return False


class TmuxSession:
    """Manage a persistent Claude Code TUI session via tmux + JSONL watching."""

    def __init__(
        self,
        *,
        session_id: str,
        cli_path: str,
        cwd: str,
        env: dict[str, str],
        jsonl_path: Path,
        is_new: bool = False,
        claimed_ids: set[str] | None = None,
        persisted_real_session_id: str | None = None,
        on_real_session_id_changed: Any = None,
        on_organic_session_changed: Any = None,
    ) -> None:
        self.session_id = session_id
        self.cli_path = cli_path
        self.cwd = cwd
        self.env = env
        self.jsonl_path = jsonl_path
        self._is_new = is_new  # True = fresh session (no --resume)

        self._tmux_name = f"vs-claude-{session_id[:8]}"
        self._file_pos: int = 0
        self._pre_existing_jsonls: set[str] = set()  # snapshot before Claude starts
        self._log = logger.bind(component=_LOG_COMPONENT)
        self._ready = False
        self._ready_poll_task: asyncio.Task | None = None
        self.real_session_id: str | None = None  # populated after new session starts
        self._persisted_real_session_id = persisted_real_session_id
        self._on_real_session_id_changed = on_real_session_id_changed
        self._on_organic_session_changed = on_organic_session_changed
        self._send_clear_in_progress = False
        self._start_ts: float = 0.0  # set in start(), used to filter JSONL files
        # Shared set (owned by adapter) of JSONL session IDs already claimed by
        # other TmuxSession instances.  Used by _detect_real_session_id() to
        # avoid two new sessions grabbing the same JSONL file when they share a
        # project directory and start close together.
        self._claimed_ids: set[str] = claimed_ids if claimed_ids is not None else set()
        self._waiting_for_user = False
        self._pending_questions: list[dict] = []  # AskUserQuestion questions for send_input
        self._input_sent_for_turn = False
        self._bot_id = ""  # set externally by adapter
        self._tmux_dead = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_jsonl_growth_ts: float = 0.0  # wall-clock time when JSONL last grew
        self._last_jsonl_size: int = 0  # last known JSONL file size
        self._pid_detected: bool = False  # True if real_session_id was found via PID (deterministic)
        self._started_once: bool = False  # True after first start(); restart uses real_session_id

    def _set_real_session_id(self, new_id: str) -> None:
        """Set real_session_id and notify the adapter for persistence."""
        self.real_session_id = new_id
        if self._on_real_session_id_changed:
            try:
                self._on_real_session_id_changed(self.session_id, new_id)
            except Exception:
                pass

    @property
    def is_waiting_for_input(self) -> bool:
        """True when the Claude session is blocked waiting for user input."""
        return self._waiting_for_user

    async def start(self) -> None:
        """Create a tmux session and launch ``claude --resume``.

        If a tmux session with the same name already exists and shows the
        Claude prompt (ready state), it is reused instead of being killed
        and recreated.  This allows fast backend restarts during development
        without waiting for Claude to reload session history.

        Does NOT block until Claude is ready — call ``_ensure_ready()``
        or let ``send_text()`` handle the ready-wait.
        """
        # Try to reuse an existing tmux session that survived a backend restart.
        _, has_rc = await _run_tmux("has-session", "-t", self._tmux_name)
        if has_rc == 0:
            pane_out, _ = await _run_tmux(
                "capture-pane",
                "-t",
                self._tmux_name,
                "-p",
                "-S",
                "-10",
            )
            if _is_claude_prompt(pane_out):
                # Existing session is alive and Claude is at the prompt — reuse it.
                # Use hook file (deterministic) to find the current session ID,
                # NOT mtime directory scan which can pick up another bot's JSONL.
                hook_sid = self._detect_session_id_from_hook()
                if hook_sid and hook_sid != (self.real_session_id or self.session_id):
                    from .session_scanner import _cwd_to_project_dir_name

                    project_dir_name = _cwd_to_project_dir_name(self.cwd)
                    hook_jsonl = Path.home() / ".claude" / "projects" / project_dir_name / f"{hook_sid}.jsonl"
                    if hook_jsonl.exists() and not _is_queue_session(hook_jsonl):
                        self._log.info(
                            "Reuse: hook file says session switched: {} → {}",
                            (self.real_session_id or self.session_id)[:8],
                            hook_sid[:8],
                        )
                        if self.real_session_id:
                            self._claimed_ids.discard(self.real_session_id)
                        self._set_real_session_id(hook_sid)
                        self._claimed_ids.add(hook_sid)
                        self.jsonl_path = hook_jsonl
                if self.jsonl_path.exists():
                    self._file_pos = self.jsonl_path.stat().st_size
                self._ready = True
                self._log.info(
                    "TmuxSession reused (already ready): name={}, session={}, jsonl={}",
                    self._tmux_name,
                    self.session_id[:8],
                    self.jsonl_path.stem[:8] if self.jsonl_path.exists() else "none",
                )
                self._loop = asyncio.get_running_loop()
                self._tmux_dead = False
                return

            # Session exists but Claude is not at the prompt (e.g. still
            # loading or stuck).  Kill it and start fresh below.
            self._log.info(
                "TmuxSession exists but not ready, recreating: name={}",
                self._tmux_name,
            )

        # Kill any leftover session with the same name
        await _run_tmux("kill-session", "-t", self._tmux_name)

        # Set history-limit BEFORE creating the session so the initial pane
        # inherits the larger buffer.  tmux's history-limit only applies to
        # panes created *after* the option is set — setting it after
        # new-session leaves the existing pane at the global default (2000).
        await _run_tmux("set-option", "-g", "history-limit", "50000")

        # Create detached session
        _, rc = await _run_tmux(
            "new-session",
            "-d",
            "-s",
            self._tmux_name,
            "-x",
            "220",
            "-y",
            "50",
        )
        if rc != 0:
            raise RuntimeError(f"Failed to create tmux session {self._tmux_name}")
        # Enable mouse scroll wheel to enter copy mode automatically (tmux scrollback)
        await _run_tmux("set-option", "-t", self._tmux_name, "mouse", "on")
        # Prevent mouse drag-end from exiting copy mode (default: copy-selection-and-cancel)
        # so users can scroll up, select text, and copy without jumping back to bottom.
        # Use copy-pipe-no-clear to also send selection to system clipboard via pbcopy.
        await _run_tmux(
            "bind-key",
            "-T",
            "copy-mode",
            "MouseDragEnd1Pane",
            "send-keys",
            "-X",
            "copy-pipe-no-clear",
            "pbcopy",
        )
        await _run_tmux(
            "bind-key",
            "-T",
            "copy-mode-vi",
            "MouseDragEnd1Pane",
            "send-keys",
            "-X",
            "copy-pipe-no-clear",
            "pbcopy",
        )
        # Single-click in copy mode clears the selection highlight (like
        # normal Terminal.app) without exiting copy mode, so the user stays
        # at the current scroll position and can continue browsing.
        await _run_tmux(
            "bind-key",
            "-T",
            "copy-mode",
            "MouseDown1Pane",
            "send-keys",
            "-X",
            "clear-selection",
        )
        await _run_tmux(
            "bind-key",
            "-T",
            "copy-mode-vi",
            "MouseDown1Pane",
            "send-keys",
            "-X",
            "clear-selection",
        )

        # Unset env vars that prevent nested Claude Code
        for key in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "ANTHROPIC_API_KEY"):
            await _run_tmux("set-environment", "-t", self._tmux_name, "-u", key)
        # Set TryVoice identity env var so SessionStart hook can write
        # the session ID to a known location for deterministic tracking.
        await _run_tmux("set-environment", "-t", self._tmux_name, "TRYVOICE_TMUX_NAME", self._tmux_name)

        # Record current JSONL file size so we skip historical content
        if self.jsonl_path.exists():
            self._file_pos = self.jsonl_path.stat().st_size

        # Snapshot existing JSONL files BEFORE launching Claude so
        # _detect_real_session_id can identify which file is truly new.
        if self._is_new:
            from .session_scanner import _cwd_to_project_dir_name

            proj_dir = Path.home() / ".claude" / "projects" / _cwd_to_project_dir_name(self.cwd)
            if proj_dir.is_dir():
                self._pre_existing_jsonls = {p.name for p in proj_dir.glob("*.jsonl")}
            self._log.info(
                "Pre-existing JSONL snapshot: {} files in {}",
                len(self._pre_existing_jsonls),
                proj_dir,
            )

        # Launch claude inside tmux.
        # Unset vars in the shell itself (tmux set-environment only affects new panes,
        # not the shell that inherited env from the parent backend process).
        hook_port = int(os.getenv("PORT", "7860"))
        # Detect whether backend runs HTTPS (cert exists) so hook scripts
        # use the correct scheme.
        _cert = Path.home() / ".tryvoice" / "cert.pem"
        _key = Path.home() / ".tryvoice" / "key.pem"
        hook_scheme = "https" if (_cert.exists() and _key.exists()) else "http"
        settings_dir = Path.home() / ".tryvoice" / "hook-settings"
        settings_path = _generate_hook_settings(settings_dir, self._tmux_name, hook_port)

        unset_cmd = (
            "unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ACCESS_TOKEN ANTHROPIC_API_KEY"
            f" && export TRYVOICE_TMUX_NAME={shlex.quote(self._tmux_name)}"
            f" TRYVOICE_HOOK_PORT={shlex.quote(str(hook_port))}"
            f" TRYVOICE_HOOK_SCHEME={shlex.quote(hook_scheme)}"
        )
        # --permission-mode default lets hooks handle permission decisions
        # instead of auto-accepting edits.
        perm_flag = "--permission-mode default"
        settings_flag = f"--settings {shlex.quote(str(settings_path))}"
        if self._is_new:
            # New session: start fresh claude (no --resume with non-existent ID)
            claude_cmd = f"{shlex.quote(self.cli_path)} {perm_flag} {settings_flag}"
        else:
            # Use real session ID if available (from previous start or persistence).
            # After the first start, prefer the live real_session_id over the
            # potentially stale persisted one so crash-recovery resumes the
            # correct conversation.
            if self._started_once and self.real_session_id:
                resume_id = self.real_session_id
            else:
                resume_id = self._persisted_real_session_id or self.session_id
            claude_cmd = f"{shlex.quote(self.cli_path)} --resume {resume_id} {perm_flag} {settings_flag}"
        await _run_tmux(
            "send-keys",
            "-t",
            self._tmux_name,
            f"{unset_cmd} && cd {shlex.quote(self.cwd)} && {claude_cmd}",
            "Enter",
        )

        self._ready = False
        self._started_once = True
        self._start_ts = asyncio.get_event_loop().time()

        # Cancel any stale poll task from a previous start()
        if self._ready_poll_task and not self._ready_poll_task.done():
            self._ready_poll_task.cancel()
        self._ready_poll_task = asyncio.create_task(self._poll_until_ready())

        self._loop = asyncio.get_running_loop()
        self._tmux_dead = False

        # Log tmux server PID for crash correlation
        try:
            svr_pid_out, _ = await _run_tmux("display-message", "-p", "#{pid}")
            self._tmux_server_pid = svr_pid_out.strip()
        except Exception:
            self._tmux_server_pid = "unknown"

        self._log.info(
            "TmuxSession launched: name={}, session={}, cwd={}, tmux_server_pid={}",
            self._tmux_name,
            self.session_id[:8],
            self.cwd,
            self._tmux_server_pid,
        )

    async def _check_ready(self) -> bool:
        """Non-blocking check if Claude TUI prompt is visible.

        Also auto-confirms the 'trust this folder' safety dialog so
        pre-warmed sessions don't stall waiting for interactive input.
        """
        if self._ready:
            return True
        out, _ = await _run_tmux(
            "capture-pane",
            "-t",
            self._tmux_name,
            "-p",
            "-S",
            "-10",
        )
        # Auto-confirm the "trust this folder" safety prompt.
        # Claude Code uses an Ink TUI interactive select — just press Enter
        # to confirm the default-highlighted "Yes, I trust this folder" option.
        if "I trust this folder" in out or "Is this a project you created" in out:
            await _run_tmux("send-keys", "-t", self._tmux_name, "Enter")
            return False
        if _is_claude_prompt(out):
            self._ready = True
            return True
        return False

    async def _poll_until_ready(self) -> None:
        """Background task: poll _check_ready until Claude prompt appears.

        Handles the trust-this-folder safety dialog so pre-warmed sessions
        don't stall waiting for interactive input that never comes.
        Runs for up to 60 seconds after start().
        """
        for _ in range(60):
            await asyncio.sleep(1.0)
            try:
                if await self._check_ready():
                    self._log.info("TmuxSession ready (background poll): {}", self._tmux_name)
                    # For new sessions, detect the real session ID from JSONL
                    if self._is_new:
                        self._detect_real_session_id()
                    return
            except Exception as exc:
                self._log.debug("_poll_until_ready error: {}", exc)
        self._log.warning("TmuxSession did not become ready within 60s: {}", self._tmux_name)

    def _detect_real_session_id(self) -> str | None:
        """For new sessions, find the real JSONL by querying the Claude Code process.

        Claude Code writes its session ID to ``~/.claude/sessions/<PID>.json``.
        We find the PID of the Claude Code process inside our tmux pane, then
        read its session file to get the exact JSONL filename.  This is
        deterministic and immune to cross-session confusion.
        """
        if self.real_session_id:
            return self.real_session_id

        # Try persisted real_session_id from a previous TryVoice run.
        # This covers the case where TryVoice restarts and the hook file
        # points to a queue-operation session (which we filter out).
        if self._persisted_real_session_id:
            from .session_scanner import _cwd_to_project_dir_name as _cwd2pdn

            pdir = Path.home() / ".claude" / "projects" / _cwd2pdn(self.cwd)
            persisted_path = pdir / f"{self._persisted_real_session_id}.jsonl"
            if persisted_path.exists() and not _is_queue_session(persisted_path):
                self._set_real_session_id(self._persisted_real_session_id)
                self._claimed_ids.add(self._persisted_real_session_id)
                self.jsonl_path = persisted_path
                # Skip existing content — history sync handles old entries.
                # Starting from 0 would re-stream everything as new cards.
                self._file_pos = persisted_path.stat().st_size
                self._log.info(
                    "Restored session ID from persistence: {} → {}",
                    self.session_id[:8],
                    self._persisted_real_session_id[:8],
                )
                self._persisted_real_session_id = None  # consumed
                return self.real_session_id

        from .session_scanner import _cwd_to_project_dir_name

        project_dir_name = _cwd_to_project_dir_name(self.cwd)
        project_dir = Path.home() / ".claude" / "projects" / project_dir_name
        if not project_dir.is_dir():
            self._log.debug("Project dir not found for new session: {}", project_dir)
            return None

        try:
            # --- Primary method: hook file (most reliable) ---
            # TryVoice SessionStart hook writes session info to a known path.
            # Do NOT filter by _is_queue_session here: the hook is
            # deterministic and a queue-operation first line does not mean
            # the session is transient (Claude Code may prepend queue ops
            # to a normal conversation JSONL).
            session_id = self._detect_session_id_from_hook()
            if session_id:
                jsonl_path = project_dir / f"{session_id}.jsonl"
                if jsonl_path.exists():
                    self._set_real_session_id(session_id)
                    self._claimed_ids.add(session_id)
                    self.jsonl_path = jsonl_path
                    # Skip existing content — history sync handles old entries.
                    self._file_pos = jsonl_path.stat().st_size
                    self._pid_detected = True  # Hook is equally deterministic
                    self._log.info(
                        "Detected session ID via hook: {} → {}",
                        self.session_id[:8],
                        session_id[:8],
                    )
                    return session_id

            # --- Secondary method: PID → session file ---
            # Same rationale: PID detection is deterministic, skip queue filter.
            session_id = self._detect_session_id_from_pid()
            if session_id:
                jsonl_path = project_dir / f"{session_id}.jsonl"
                if jsonl_path.exists():
                    self._set_real_session_id(session_id)
                    self._claimed_ids.add(session_id)
                    self.jsonl_path = jsonl_path
                    # Skip existing content — history sync handles old entries.
                    self._file_pos = jsonl_path.stat().st_size
                    self._pid_detected = True
                    self._log.info(
                        "Detected session ID via PID: {} → {}",
                        self.session_id[:8],
                        session_id[:8],
                    )
                    return session_id

            # --- Fallback: scan directory (for cases where session file
            #     doesn't exist yet or Claude Code version differs) ---
            import time as _time

            wall_start = _time.time() - (asyncio.get_event_loop().time() - self._start_ts)
            candidates = [
                p
                for p in project_dir.glob("*.jsonl")
                if p.stat().st_mtime >= wall_start - 2.0 and p.stem not in self._claimed_ids
            ]
            if not candidates:
                return None
            new_files = [p for p in candidates if p.name not in self._pre_existing_jsonls and not _is_queue_session(p)]
            if new_files:
                newest = min(new_files, key=lambda p: abs(p.stat().st_mtime - wall_start))
            else:
                return None  # Don't guess from pre-existing files
            real_id = newest.stem
            self._set_real_session_id(real_id)
            self._claimed_ids.add(real_id)
            self.jsonl_path = newest
            # Skip existing content — history sync handles old entries.
            self._file_pos = newest.stat().st_size if newest.exists() else 0
            self._log.info(
                "Detected session ID via directory scan (fallback): {} → {}",
                self.session_id[:8],
                real_id[:8],
            )
            return real_id
        except Exception as exc:
            self._log.warning("_detect_real_session_id error: {}", exc)
            return None

    def _detect_session_id_from_hook(self) -> str | None:
        """Read session ID from TryVoice SessionStart hook output file.

        The hook writes to ~/.tryvoice/claude-sessions/<tmux-name>.json
        on every SessionStart event (startup, /clear, compaction, resume).
        This is the most reliable method — fully deterministic and survives
        all Claude Code session changes.
        """
        import json as _json

        try:
            hook_file = Path.home() / ".tryvoice" / "claude-sessions" / f"{self._tmux_name}.json"
            if not hook_file.exists():
                return None
            data = _json.loads(hook_file.read_text())
            sid = data.get("sessionId")
            if sid:
                self._log.debug("Hook file: {} → sessionId={}", self._tmux_name, sid[:8])
            return sid
        except Exception:
            return None

    def _detect_session_id_from_pid(self) -> str | None:
        """Read the Claude Code session ID from ~/.claude/sessions/<PID>.json.

        Claude Code writes this file at startup with {pid, sessionId, cwd}.
        We find the PID by looking at the child process of our tmux pane.
        """
        import json as _json
        import subprocess

        try:
            # Get the shell PID from tmux pane
            out = subprocess.check_output(
                ["tmux", "list-panes", "-t", self._tmux_name, "-F", "#{pane_pid}"],
                text=True,
                timeout=5,
            ).strip()
            if not out:
                return None
            pane_pid = out.splitlines()[0]

            # Find child process (Claude Code) of the shell
            children = (
                subprocess.check_output(
                    ["pgrep", "-P", pane_pid],
                    text=True,
                    timeout=5,
                )
                .strip()
                .splitlines()
            )
            if not children:
                return None

            # Check each child for a session file
            sessions_dir = Path.home() / ".claude" / "sessions"
            for child_pid in children:
                session_file = sessions_dir / f"{child_pid.strip()}.json"
                if session_file.exists():
                    data = _json.loads(session_file.read_text())
                    sid = data.get("sessionId")
                    if sid:
                        self._log.debug(
                            "Found session file: PID={} → sessionId={}",
                            child_pid.strip(),
                            sid[:8],
                        )
                        return sid
            return None
        except Exception:
            return None

    async def _has_attached_client(self) -> bool:
        """Check if any terminal client is already attached to this tmux session."""
        try:
            out, _ = await _run_tmux(
                "list-clients",
                "-t",
                self._tmux_name,
                "-F",
                "#{client_name}",
            )
            return bool(out.strip())
        except Exception:
            return False

    async def open_terminal_window(self) -> None:
        """Open a visible terminal window attached to this tmux session.

        Idempotent — skips if a client is already attached.
        macOS:   opens a new Terminal.app window via osascript.
        Windows: no-op (tmux is not available on Windows).
        Linux:   tries xterm as a best-effort fallback.
        """
        if await self._has_attached_client():
            self._log.info("open_terminal_window: client already attached to {}", self._tmux_name)
            return
        attach_cmd = f"tmux attach -t {shlex.quote(self._tmux_name)}"
        try:
            if sys.platform == "darwin":
                script = f'tell application "Terminal" to do script "{attach_cmd}"'
                proc = await asyncio.create_subprocess_exec(
                    "osascript",
                    "-e",
                    script,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5.0)
                if proc.returncode != 0:
                    err = stderr.decode("utf-8", errors="replace").strip()
                    self._log.warning(
                        "open_terminal_window osascript failed (rc={}): {}",
                        proc.returncode,
                        err,
                    )
                else:
                    self._log.info("open_terminal_window: opened Terminal.app for {}", self._tmux_name)
            elif sys.platform.startswith("linux"):
                # Best-effort: try xterm; silently skip if not installed
                proc = await asyncio.create_subprocess_exec(
                    "xterm",
                    "-e",
                    attach_cmd,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            # Windows: tmux is not available; skip
        except Exception as exc:
            self._log.warning("open_terminal_window failed: {}", exc)

    async def _send_text_to_tmux(self, text: str) -> None:
        """Send text to tmux pane via paste-buffer."""
        # Exit copy-mode if active
        in_mode, _ = await _run_tmux(
            "display-message",
            "-t",
            self._tmux_name,
            "-p",
            "#{pane_in_mode}",
        )
        if in_mode.strip() == "1":
            await _run_tmux("send-keys", "-t", self._tmux_name, "-X", "cancel")
            await asyncio.sleep(0.1)

        await _run_tmux("set-buffer", "--", text)
        await _run_tmux("paste-buffer", "-p", "-t", self._tmux_name)
        paste_delay = min(0.5, 0.15 + len(text) / 5000)
        await asyncio.sleep(paste_delay)
        await _run_tmux("send-keys", "-t", self._tmux_name, "Enter")
        self._log.info("Sent to tmux {}: {}", self._tmux_name, text[:80] + ("..." if len(text) > 80 else ""))

    async def send_text(self, text: str) -> None:
        """Send text to tmux and wait for Claude to be ready.

        The SessionWatcher handles all JSONL output detection and WS push.
        """
        ready_start = asyncio.get_event_loop().time()
        ready_ceiling = ready_start + 120.0
        while not await self._check_ready():
            if asyncio.get_event_loop().time() >= ready_ceiling:
                raise TimeoutError("Claude TUI never became ready within 120s")
            await asyncio.sleep(5.0)

        await self._send_text_to_tmux(text)

    async def send_input(self, text: str) -> None:
        """Send user input to Claude Code TUI for interactive prompts.

        Claude Code's AskUserQuestion uses Ink TUI with keyboard navigation:
        - Single-select: Up/Down to highlight, Enter to confirm
        - Multi-select: Up/Down to navigate, Space to toggle, Tab to submit

        We translate the selected option labels from the web UI into the
        corresponding key sequences based on _pending_questions metadata.
        """
        if self._input_sent_for_turn:
            self._log.warning("Input already sent for this prompt, ignoring duplicate")
            return
        self._input_sent_for_turn = True
        self._log.info("Sending user input: len={}, pending_questions={}", len(text), len(self._pending_questions))

        answers = [a.strip() for a in text.split("\n") if a.strip()]

        if self._pending_questions and answers:
            await self._send_ask_user_keys(answers)
        else:
            # Fallback: just type text + Enter (for free-text questions)
            await _run_tmux("send-keys", "-t", self._tmux_name, "-l", text)
            await asyncio.sleep(0.2)
            await _run_tmux("send-keys", "-t", self._tmux_name, "Enter")

        self._pending_questions = []
        self._log.info("Sent input to tmux {}", self._tmux_name)

    async def _send_ask_user_keys(self, answers: list[str]) -> None:
        """Translate selected option labels into TUI key sequences.

        For each question in _pending_questions:
        - Find which option index the user selected
        - Send Down-arrow keys to navigate to that option
        - For single-select: press Enter to confirm
        - For multi-select: press Space to toggle, then Tab to submit
        """
        for q_idx, question in enumerate(self._pending_questions):
            options = question.get("options", [])
            is_multi = question.get("multiSelect", False)

            if not options:
                # Free-text question: type answer + Enter
                answer = answers[q_idx] if q_idx < len(answers) else ""
                if answer:
                    await _run_tmux("send-keys", "-t", self._tmux_name, "-l", answer)
                    await asyncio.sleep(0.2)
                    await _run_tmux("send-keys", "-t", self._tmux_name, "Enter")
                    await asyncio.sleep(0.5)
                continue

            # Find answer labels for this question
            # answers[q_idx] may contain comma-separated labels for multi-select
            answer_text = answers[q_idx] if q_idx < len(answers) else ""
            selected_labels = [label.strip() for label in answer_text.split(",")] if answer_text else []

            if is_multi:
                # Multi-select: navigate to each selected option, press Space to toggle
                for opt_idx, opt in enumerate(options):
                    if opt.get("label") in selected_labels:
                        # Navigate to this option (Down from current position)
                        for _ in range(opt_idx):
                            await _run_tmux("send-keys", "-t", self._tmux_name, "Down")
                            await asyncio.sleep(0.05)
                        # Toggle selection
                        await _run_tmux("send-keys", "-t", self._tmux_name, "Space")
                        await asyncio.sleep(0.1)
                        # Navigate back to top for next selection
                        for _ in range(opt_idx):
                            await _run_tmux("send-keys", "-t", self._tmux_name, "Up")
                            await asyncio.sleep(0.05)
                # Submit multi-select with Tab
                await _run_tmux("send-keys", "-t", self._tmux_name, "Tab")
                await asyncio.sleep(0.5)
            else:
                # Single-select: navigate to selected option, press Enter
                target_idx = 0
                for opt_idx, opt in enumerate(options):
                    if opt.get("label") in selected_labels:
                        target_idx = opt_idx
                        break
                for _ in range(target_idx):
                    await _run_tmux("send-keys", "-t", self._tmux_name, "Down")
                    await asyncio.sleep(0.05)
                await _run_tmux("send-keys", "-t", self._tmux_name, "Enter")
                await asyncio.sleep(0.5)

    def _refresh_jsonl_path(self) -> None:
        """Verify JSONL path still matches the tmux session's actual conversation.

        After a backend restart with tmux reuse, the claude process may have
        started a new conversation session (new JSONL file).  We detect this
        by checking the real_session_id or, for known sessions, confirming the
        existing file is still being written to.

        IMPORTANT: we must NOT blindly pick the newest JSONL in the project
        directory — multiple Claude Code sessions can share the same project
        dir, and picking the wrong file would return another session's replies.
        """
        import time as _time

        # Track file growth to detect stale JSONL
        if self.jsonl_path.exists():
            current_size = self.jsonl_path.stat().st_size
            if current_size > self._last_jsonl_size:
                self._last_jsonl_size = current_size
                self._last_jsonl_growth_ts = _time.time()
            elif self._last_jsonl_growth_ts == 0.0:
                # First check — initialize without marking as stale
                self._last_jsonl_size = current_size
                self._last_jsonl_growth_ts = _time.time()

        if self.real_session_id:
            project_dir = self.jsonl_path.parent
            expected = project_dir / f"{self.real_session_id}.jsonl"
            if expected.exists() and expected != self.jsonl_path:
                self._log.info(
                    "JSONL path corrected to match session ID: {} → {}",
                    self.jsonl_path.stem[:8],
                    expected.stem[:8],
                )
                self.jsonl_path = expected
                # Skip existing content — history sync handles old entries.
                self._file_pos = expected.stat().st_size if expected.exists() else 0

            # Check if the current JSONL has stopped growing — Claude Code
            # may have started a new conversation (compaction, /clear, etc.).
            #
            # Strategy (ordered by reliability):
            # 1. Re-query PID session file — catches cases where Claude Code
            #    updates the session file on /clear or compaction
            # 2. Find newer unclaimed JSONL in same project dir — catches
            #    cases where session file is NOT updated (known Claude Code
            #    behavior with /clear)
            stale_threshold = 30.0  # seconds without growth
            now = _time.time()
            stale_age = now - self._last_jsonl_growth_ts if self._last_jsonl_growth_ts > 0 else -1
            if stale_age > stale_threshold:
                # Strategy 1: hook file (updated on /clear, compaction, etc.)
                new_sid = self._detect_session_id_from_hook()
                if not new_sid or new_sid == self.real_session_id:
                    # Strategy 2: PID session file
                    new_sid = self._detect_session_id_from_pid()
                if new_sid and new_sid != self.real_session_id:
                    new_path = project_dir / f"{new_sid}.jsonl"
                    if new_path.exists() and not _is_queue_session(new_path):
                        self._log.info(
                            "Session changed (hook/PID): {} → {}",
                            self.real_session_id[:8],
                            new_sid[:8],
                        )
                        self._claimed_ids.discard(self.real_session_id)
                        self._set_real_session_id(new_sid)
                        self._claimed_ids.add(new_sid)
                        self.jsonl_path = new_path
                        # Skip existing content — history sync handles old entries.
                        self._file_pos = new_path.stat().st_size if new_path.exists() else 0
                        self._last_jsonl_size = 0
                        self._last_jsonl_growth_ts = now
                        # (variable removed — switching is signalled by the block below)
                        if not self._send_clear_in_progress and self._bot_id and self._on_organic_session_changed:
                            try:
                                self._on_organic_session_changed(self.session_id, self._bot_id)
                            except Exception:
                                pass
                    elif new_path.exists():
                        self._log.debug(
                            "Skipping queue-operation session from hook/PID: {}",
                            new_sid[:8],
                        )
            return

        # For new sessions without real_session_id yet: Claude creates the
        # JSONL only after the first message is sent.  Try to detect it now
        # using the start timestamp to avoid picking another session's file.
        if self._is_new:
            detected = self._detect_real_session_id()
            if detected:
                self._log.info("JSONL detected during refresh: {}", detected[:8])

    def _find_newer_jsonl(self, project_dir: Path) -> Path | None:
        """Find a JSONL file in project_dir that is newer than the current one.

        Only returns a file if it has been modified MORE RECENTLY than the
        current JSONL and is not claimed by another TmuxSession.
        """
        try:
            current_mtime = self.jsonl_path.stat().st_mtime if self.jsonl_path.exists() else 0
            candidates = [
                p
                for p in project_dir.glob("*.jsonl")
                if p.stat().st_mtime > current_mtime
                and p.stem not in self._claimed_ids
                and p != self.jsonl_path
                and not _is_queue_session(p)
            ]
            if not candidates:
                return None
            # Return the most recently modified candidate
            return max(candidates, key=lambda p: p.stat().st_mtime)
        except Exception:
            return None

    def _find_jsonl_born_after(self, project_dir: Path, born_after: float) -> Path | None:
        """Find a JSONL file in project_dir that was CREATED after born_after.

        Uses file birth time (st_birthtime on macOS) to distinguish truly new
        files from old files that were merely modified. This prevents grabbing
        an unrelated session's JSONL that happened to be written to recently.
        """

        try:
            candidates = []
            for p in project_dir.glob("*.jsonl"):
                if p.stem in self._claimed_ids or p == self.jsonl_path:
                    continue
                st = p.stat()
                # st_birthtime on macOS, st_ctime on Linux (creation or metadata change)
                birth = getattr(st, "st_birthtime", st.st_ctime)
                if birth > born_after:
                    candidates.append((p, birth))
            if not candidates:
                return None
            # Return the most recently created candidate
            return max(candidates, key=lambda x: x[1])[0]
        except Exception:
            return None

    def _message_in_current_jsonl(self, text: str) -> bool:
        """Check if text appears in the current JSONL file (last 10 lines)."""
        try:
            if not self.jsonl_path.exists():
                return False
            import json as _json

            with open(self.jsonl_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            for line in lines[-10:]:
                try:
                    d = _json.loads(line)
                    if d.get("type") == "user":
                        content = d.get("message", {}).get("content", "")
                        if isinstance(content, str) and text[:50] in content:
                            return True
                except Exception:
                    continue
            return False
        except Exception:
            return False

    def _find_jsonl_containing_text(self, project_dir: Path, text: str) -> Path | None:
        """Find a JSONL in project_dir whose last entries contain the given text.

        Only checks recently modified files (mtime within last 30s) to
        avoid scanning old files. This is a targeted search, not a broad scan.
        """
        import json as _json
        import time as _time

        try:
            cutoff = _time.time() - 30
            for p in project_dir.glob("*.jsonl"):
                if p.stem in self._claimed_ids or p == self.jsonl_path:
                    continue
                if p.stat().st_mtime < cutoff:
                    continue
                # Read last 10 lines
                with open(p, "r", encoding="utf-8") as f:
                    lines = f.readlines()[-10:]
                for line in lines:
                    try:
                        d = _json.loads(line)
                        if d.get("type") == "user":
                            content = d.get("message", {}).get("content", "")
                            if isinstance(content, str) and text[:50] in content:
                                return p
                    except Exception:
                        continue
            return None
        except Exception:
            return None

    async def send_escape(self) -> bool:
        """Send Escape key to the Claude Code TUI to interrupt generation.

        Returns True if the key was sent, False on error.
        """
        try:
            await _run_tmux("send-keys", "-t", self._tmux_name, "Escape")
            self._log.info("Sent Escape to tmux {}", self._tmux_name)
            return True
        except Exception as exc:
            self._log.warning("send_escape failed: {}", exc)
            return False

    async def check_claude_process_alive(self) -> bool:
        """Check if the claude CLI process is still running inside this tmux pane."""
        try:
            # Get the pane's current foreground process
            stdout, rc = await _run_tmux(
                "display-message",
                "-t",
                self._tmux_name,
                "-p",
                "#{pane_pid}",
            )
            pane_pid = stdout.strip()
            if not pane_pid:
                return False
            # Check if any descendant of the pane shell is a claude process
            proc = await asyncio.create_subprocess_exec(
                "pgrep",
                "-P",
                pane_pid,
                "-f",
                "claude",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
            return proc.returncode == 0 and bool(stdout_bytes.strip())
        except Exception:
            return True  # Assume alive on error (conservative)

    async def restart_claude(self) -> None:
        """Restart the claude CLI process inside the existing tmux pane."""
        self._log.warning("Restarting claude in tmux {}", self._tmux_name)
        # The pane's shell is still alive; just re-run the claude command
        await self.start()

    async def send_clear(self) -> bool:
        """Send /clear to Claude Code CLI to reset conversation context.

        Returns True if the command was sent successfully, False if the
        session is not ready after interrupt attempt.
        """
        if not self._ready:
            # CLI busy — interrupt current turn first, then send /clear
            self._log.info("send_clear: CLI busy, sending Escape first")
            await self.send_escape()
            # Wait for prompt to reappear after interrupt
            for _ in range(10):  # up to 5s
                await asyncio.sleep(0.5)
                if await self._check_ready():
                    break
            if not self._ready:
                self._log.warning("send_clear: CLI still not ready after interrupt")
                return False
        try:
            self._send_clear_in_progress = True
            await _run_tmux("send-keys", "-t", self._tmux_name, "/clear", "Enter")
            self._log.info("Sent /clear to tmux {}", self._tmux_name)
            # Wait briefly for /clear to take effect and prompt to reappear
            self._ready = False
            for _ in range(10):  # up to 5s
                await asyncio.sleep(0.5)
                if await self._check_ready():
                    break
            # /clear creates a new Claude Code session with a new JSONL file.
            # Re-detect the session ID so the watcher tracks the correct file.
            # The SessionStart hook should have updated the hook file by now.
            old_real = self.real_session_id
            new_real = self._detect_real_session_id()
            if new_real and new_real != old_real:
                self._log.info(
                    "send_clear: session switched {} → {}",
                    old_real[:8] if old_real else "(none)",
                    new_real[:8],
                )
            elif self.jsonl_path.exists():
                # Fallback: same session or detection failed — reset file pos
                self._file_pos = self.jsonl_path.stat().st_size
            return True
        except Exception as exc:
            self._log.warning("send_clear failed: {}", exc)
            return False
        finally:
            self._send_clear_in_progress = False

    async def send_compact(self) -> bool:
        """Send /compact to Claude Code CLI to compress conversation context.

        Returns True if the command was sent successfully, False if the
        session is not ready after interrupt attempt.
        """
        if not self._ready:
            self._log.info("send_compact: CLI busy, sending Escape first")
            await self.send_escape()
            for _ in range(10):  # up to 5s
                await asyncio.sleep(0.5)
                if await self._check_ready():
                    break
            if not self._ready:
                self._log.warning("send_compact: CLI still not ready after interrupt")
                return False
        try:
            await _run_tmux("send-keys", "-t", self._tmux_name, "/compact", "Enter")
            self._log.info("Sent /compact to tmux {}", self._tmux_name)
            self._ready = False
            for _ in range(10):  # up to 5s
                await asyncio.sleep(0.5)
                if await self._check_ready():
                    break
            # /compact creates a new session with a new JSONL file.
            # Re-detect session ID so watcher tracks the correct file.
            old_real = self.real_session_id
            new_real = self._detect_real_session_id()
            if new_real and new_real != old_real:
                self._log.info(
                    "send_compact: session switched {} → {}",
                    old_real[:8] if old_real else "(none)",
                    new_real[:8],
                )
            return True
        except Exception as exc:
            self._log.warning("send_compact failed: {}", exc)
            return False

    async def stop(self) -> None:
        """Stop the tmux session."""
        if self._ready_poll_task and not self._ready_poll_task.done():
            self._ready_poll_task.cancel()
            self._ready_poll_task = None
        await _run_tmux("kill-session", "-t", self._tmux_name)
        self._log.info("TmuxSession stopped: {}", self._tmux_name)

    def is_alive(self) -> bool:
        """Check if the tmux session exists (synchronous check via subprocess)."""
        import subprocess

        try:
            result = subprocess.run(
                ["tmux", "has-session", "-t", self._tmux_name],
                capture_output=True,
                timeout=5,
            )
            return result.returncode == 0
        except Exception:
            return False
