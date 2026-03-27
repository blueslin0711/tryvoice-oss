"""Scan for active Claude Code terminal sessions.

Detects sessions by finding ``claude`` processes attached to a TTY,
resolving their working directory to a ``~/.claude/projects/`` folder,
and picking the most recently modified JSONL file in that folder.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from loguru import logger

IS_WINDOWS = sys.platform == "win32"

from backend.adapter_sdk.config_types import BotInfo  # noqa: E402

# Sessions modified within this window are considered "active"
DEFAULT_ACTIVE_MINUTES = 60


def derive_stable_bot_id(project_dir: str) -> str:
    """Derive a stable, human-readable bot_id from a Claude project directory.

    The encoded dir name uses ``-`` for ``/`` and ``.``, so ``--`` marks a
    hidden-directory boundary (e.g. ``/.openclaw/`` → ``--openclaw-``).

    Examples:
      ~/.claude/projects/-Users-foo                                → "claude-home"
      ~/.claude/projects/-Users-foo-my-project                     → "claude-my-project"
      ~/.claude/projects/-Users-foo--openclaw-workspace-tryvoice   → "claude-tryvoice"
      ~/.claude/projects/-Users-foo--proj--worktrees-space-1       → "claude-space-1"
    """
    dir_name = Path(project_dir).name
    home = str(Path.home())
    home_encoded = home.replace("/", "-").replace(".", "-")

    if IS_WINDOWS:
        home_encoded = home.replace("\\", "-").replace("/", "-").replace(".", "-")
        if len(home_encoded) >= 2 and home_encoded[1] == ":":
            home_encoded = home_encoded[0] + home_encoded[2:]

    # Exact home dir
    if dir_name == home_encoded:
        return "claude-home"

    # Project under home: extract last meaningful path segment
    if dir_name.startswith(home_encoded):
        suffix = dir_name[len(home_encoded) :]
        if not suffix or suffix == "-":
            return "claude-home"

        if "--" in suffix:
            # Has hidden-dir boundaries — split on -- to get path segments
            # e.g. "--openclaw-workspace-tryvoice" → ["openclaw-workspace-tryvoice"]
            # e.g. "--proj--worktrees-space-1" → ["proj", "worktrees-space-1"]
            parts = [p for p in suffix.split("--") if p]
            if not parts:
                return "claude-home"
            # Take last -- delimited part, then take last - segment
            last_part = parts[-1]
            sub_parts = [p for p in last_part.split("-") if p]
            if sub_parts:
                # For worktrees like "worktrees-space-1", keep last 2 if first is "worktrees"
                if len(sub_parts) >= 2 and sub_parts[0] == "worktrees":
                    return f"claude-{'-'.join(sub_parts[1:])}"
                return f"claude-{sub_parts[-1]}"
            return f"claude-{last_part}"
        else:
            # No hidden dir boundary — suffix is like "-my-project"
            # This is a direct subdirectory of home; keep as-is for readability
            leaf = suffix.lstrip("-")
            return f"claude-{leaf}" if leaf else "claude-home"

    # Fallback: use dir_name tail
    return f"claude-{dir_name[-12:]}"


# Cache: project_dir path → original cwd (populated by _find_live_claude_sessions)
_project_dir_to_cwd: dict[str, str] = {}


def _detect_project_dirs() -> list[Path]:
    """Find all Claude Code project directories under ~/.claude/projects/."""
    claude_projects = Path.home() / ".claude" / "projects"
    if not claude_projects.is_dir():
        return []
    return [d for d in claude_projects.iterdir() if d.is_dir()]


def _session_topic(jsonl_path: Path) -> str:
    """Extract a short topic from the last meaningful user message in a session."""
    import re

    last_topic = ""
    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("type") != "user":
                    continue
                msg = d.get("message", {})
                content = msg.get("content", "")
                if isinstance(content, list):
                    text_parts = [c.get("text", "") for c in content if c.get("type") == "text"]
                    text = " ".join(text_parts).strip()
                elif isinstance(content, str):
                    text = content.strip()
                else:
                    continue
                # Strip XML tags (system reminders, command caveats, etc.)
                cleaned = re.sub(r"<[^>]+>", "", text).strip()
                if not cleaned:
                    continue
                # Take first line, clean up
                first_line = cleaned.split("\n")[0].strip()
                first_line = first_line.lstrip("#").strip()
                if first_line:
                    last_topic = first_line[:40] + ("..." if len(first_line) > 40 else "")
    except Exception:
        pass
    return last_topic


def _project_dir_display_name(project_dir: str) -> str:
    """Convert a Claude project dir path to a short display name.

    Uses the live process cwd stored during scanning for accurate reversal,
    falling back to heuristic decoding of the project dir name.

    ``~/.claude/projects/-Users-tryailab``
        → ``~``
    ``~/.claude/projects/-Users-tryailab--openclaw-workspace-tryvoice-apps-host-runtime``
        → ``tryvoice/apps/host-runtime``
    """
    # Check if we cached the original cwd for this project dir
    cwd = _project_dir_to_cwd.get(project_dir)
    if cwd:
        home = str(Path.home())
        _sep = "\\" if IS_WINDOWS else "/"
        cwd_norm = cwd.replace("\\", "/")
        home_norm = home.replace("\\", "/")
        if cwd_norm == home_norm:
            return "~"
        if cwd_norm.startswith(home_norm + "/"):
            rel = cwd_norm[len(home_norm) + 1 :]
        else:
            rel = cwd_norm
        # Show last 3 path segments for brevity
        parts = rel.split("/")
        if len(parts) <= 3:
            return rel
        return "/".join(parts[-3:])

    # Fallback: decode from dir name
    dir_name = Path(project_dir).name
    home = str(Path.home())
    home_encoded = home.replace("/", "-").replace(".", "-")
    if dir_name == home_encoded:
        return "~"
    if dir_name.startswith(home_encoded):
        suffix = dir_name[len(home_encoded) :]
        # Reverse encoding: -- was /., - was /
        # Restore by replacing -- with /. first, then - with /
        restored = suffix.replace("--", "/.").replace("-", "/").lstrip("/")
        parts = restored.split("/")
        parts = [p for p in parts if p]
        if len(parts) <= 3:
            return "/".join(parts)
        return "/".join(parts[-3:])
    return dir_name


def _cwd_to_project_dir_name(cwd: str) -> str:
    """Convert a working directory path to Claude's project dir naming convention.

    UNIX:    ``/Users/foo/my-project`` → ``-Users-foo-my-project``
    Windows: ``C:\\Users\\foo\\project`` → ``C-Users-foo-project``
    """
    if IS_WINDOWS:
        # Normalize backslashes to forward slashes, strip trailing colon from drive
        cwd = cwd.replace("\\", "/")
        if len(cwd) >= 2 and cwd[1] == ":":
            cwd = cwd[0] + cwd[2:]  # "C:/Users" → "C/Users"
    return cwd.replace("/", "-").replace(".", "-")


def _find_live_claude_sessions() -> list[dict[str, Any]]:
    """Find claude processes and resolve their project dirs.

    Dispatches to platform-specific implementation:
    - UNIX: uses ``ps`` + ``lsof``
    - Windows: uses ``psutil``

    Returns list of dicts with keys: pid, cwd, project_dir.
    """
    if IS_WINDOWS:
        return _find_live_claude_sessions_windows()
    return _find_live_claude_sessions_unix()


def _find_live_claude_sessions_unix() -> list[dict[str, Any]]:
    """UNIX implementation: find claude processes via ps + lsof."""
    # Step 1: find claude PIDs (terminal or VS Code extension — no TTY filter)
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid,comm"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception as e:
        logger.debug(f"ps failed: {e}")
        return []

    claude_pids: list[str] = []
    for line in result.stdout.splitlines()[1:]:  # skip header
        parts = line.strip().split(None, 1)
        if len(parts) < 2:
            continue
        pid, comm = parts[0], parts[1]
        # Match "claude" at the end of the comm path (handles full paths like
        # /Users/.../native-binary/claude from VS Code extension)
        basename = comm.rsplit("/", 1)[-1].rstrip("+")
        if basename != "claude":
            continue
        claude_pids.append(pid)

    if not claude_pids:
        return []

    # Step 2: get cwd for each PID via lsof
    projects_base = Path.home() / ".claude" / "projects"
    live: list[dict[str, Any]] = []

    for pid in claude_pids:
        try:
            lsof_result = subprocess.run(
                ["lsof", "-a", "-d", "cwd", "-p", pid, "-Fn"],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except Exception:
            continue

        cwd = ""
        for lsof_line in lsof_result.stdout.splitlines():
            if lsof_line.startswith("n/"):
                cwd = lsof_line[1:]  # strip leading 'n'
                break
        if not cwd:
            continue

        # Map cwd to project dir
        dir_name = _cwd_to_project_dir_name(cwd)
        project_dir = projects_base / dir_name
        if not project_dir.is_dir():
            continue

        _project_dir_to_cwd[str(project_dir)] = cwd
        live.append(
            {
                "pid": pid,
                "cwd": cwd,
                "project_dir": str(project_dir),
            }
        )

    return live


def _find_live_claude_sessions_windows() -> list[dict[str, Any]]:
    """Windows implementation: find claude processes via psutil."""
    try:
        import psutil
    except ImportError:
        logger.warning("psutil not installed; cannot scan for Claude processes on Windows")
        return []

    projects_base = Path.home() / ".claude" / "projects"
    live: list[dict[str, Any]] = []

    for proc in psutil.process_iter(["pid", "name", "cwd"]):
        try:
            info = proc.info
            name = (info.get("name") or "").lower()
            if name not in ("claude.exe", "claude"):
                continue
            cwd = info.get("cwd")
            if not cwd:
                continue
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

        dir_name = _cwd_to_project_dir_name(cwd)
        project_dir = projects_base / dir_name
        if not project_dir.is_dir():
            continue

        _project_dir_to_cwd[str(project_dir)] = cwd
        live.append(
            {
                "pid": str(info["pid"]),
                "cwd": cwd,
                "project_dir": str(project_dir),
            }
        )

    return live


def scan_active_sessions(
    *,
    active_minutes: int = DEFAULT_ACTIVE_MINUTES,
    max_results: int = 10,
) -> list[BotInfo]:
    """Scan for active Claude Code sessions.

    Primary: detect running ``claude`` terminal processes and map them to
    their most recently modified session JSONL.

    Fallback: if no live processes are detected, fall back to scanning
    recently modified JSONL files (within *active_minutes*).

    Returns BotInfo list sorted by most recently modified first.
    """
    live_processes = _find_live_claude_sessions()

    sessions: list[dict[str, Any]] = []
    seen_session_ids: set[str] = set()

    # Primary: sessions from live terminal processes.
    # Multiple processes may share the same project dir (e.g. two claude
    # terminals both started from ~/).  Count processes per project dir
    # and pick that many of the most-recently-modified JSONLs.
    from collections import Counter

    proc_counts: Counter[str] = Counter()
    for proc in live_processes:
        proc_counts[proc["project_dir"]] += 1

    for project_dir_str, count in proc_counts.items():
        project_dir = Path(project_dir_str)
        # Collect all JSONL files sorted by mtime descending
        jsonl_files: list[tuple[float, Path]] = []
        for jsonl_file in project_dir.glob("*.jsonl"):
            try:
                st = jsonl_file.stat()
            except OSError:
                continue
            # Skip near-empty sessions (e.g. VS Code creates JSONL with
            # only file-history-snapshot entries and no actual conversation)
            if st.st_size < 1024:
                continue
            jsonl_files.append((st.st_mtime, jsonl_file))
        jsonl_files.sort(reverse=True)

        # Pick top N files matching the number of live processes.
        # Iterate beyond [:count] so filtered entries don't reduce the result.
        found = 0
        for mtime, jsonl_file in jsonl_files:
            if found >= count:
                break
            session_id = jsonl_file.stem
            if session_id in seen_session_ids:
                continue
            seen_session_ids.add(session_id)
            sessions.append(
                {
                    "session_id": session_id,
                    "path": str(jsonl_file),
                    "project_dir": project_dir_str,
                    "modified": mtime,
                    "size_bytes": jsonl_file.stat().st_size,
                    "is_running": True,
                    "is_fallback": False,
                }
            )
            found += 1

    # Fallback: if no live processes found, use mtime-based detection
    if not sessions:
        cutoff = time.time() - (active_minutes * 60)
        for project_dir in _detect_project_dirs():
            for jsonl_file in project_dir.glob("*.jsonl"):
                try:
                    stat = jsonl_file.stat()
                except OSError:
                    continue
                session_id = jsonl_file.stem
                if stat.st_mtime < cutoff or session_id in seen_session_ids:
                    continue
                seen_session_ids.add(session_id)
                sessions.append(
                    {
                        "session_id": session_id,
                        "path": str(jsonl_file),
                        "project_dir": str(project_dir),
                        "modified": stat.st_mtime,
                        "size_bytes": stat.st_size,
                        "is_running": False,
                        "is_fallback": True,
                    }
                )

    # Sort by most recently modified first
    sessions.sort(key=lambda s: s["modified"], reverse=True)
    sessions = sessions[:max_results]

    logger.info(
        f"scan_active_sessions: {len(sessions)} session(s) "
        f"({sum(1 for s in sessions if s['is_running'])} with live terminal)"
    )

    # Build display names: "dir_name #N" when multiple sessions share a dir
    from collections import Counter

    dir_counts: Counter[str] = Counter()
    _dir_seq: dict[str, int] = {}
    for s in sessions:
        dir_counts[s["project_dir"]] += 1
    dir_cur: dict[str, int] = {}
    for s in sessions:
        d = s["project_dir"]
        dir_cur[d] = dir_cur.get(d, 0) + 1
        base = _project_dir_display_name(d)
        topic = _session_topic(Path(s["path"]))
        if topic:
            s["display_name"] = f"{base} · {topic}"
        elif dir_counts[d] > 1:
            s["display_name"] = f"{base} #{dir_cur[d]}"
        else:
            s["display_name"] = base

    # Build BotInfo list with unique bot_ids: base_id + session UUID suffix
    result: list[BotInfo] = []
    for s in sessions:
        base_id = derive_stable_bot_id(s["project_dir"])
        # Append session UUID prefix to make each instance unique
        stable_id = f"{base_id}-{s['session_id'][:6]}"
        result.append(
            BotInfo(
                bot_id=stable_id,
                name=s["display_name"],
                session_key=f"claude:{s['session_id']}",
                metadata={
                    "path": s["path"],
                    "project_dir": s["project_dir"],
                    "session_id": s["session_id"],
                    "size": s["size_bytes"],
                    "is_running": s["is_running"],
                    "is_fallback": s.get("is_fallback", False),
                },
            )
        )
    return result
