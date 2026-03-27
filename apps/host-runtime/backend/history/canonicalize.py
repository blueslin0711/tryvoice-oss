"""Canonical history conversion — filter and normalize raw agent session
history into display-ready events."""

from __future__ import annotations

import hashlib
import json
import re

from loguru import logger

from backend.adapter.contract import DELIVERY_MIRROR_PROVIDERS
from backend.history.message_utils import msg_content_text
from backend.runtime.slot_registry import list_slots

_SESSIONS_SEND_NAMES = frozenset(
    {
        "sessions_send",
        "sessions.send",
        "session_send",
        "session.send",
        "sessions/send",
    }
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SILENT_REPLY_SENTINELS = {
    "NO_REPLY",
    "REPLY_SKIP",
    "ANNOUNCE_SKIP",
    "HEARTBEAT_OK",
}
_RESET_USER_COMMANDS = {"/new", "/reset", "/clear"}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _preview_text(text: str, max_len: int = 120) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())[:max_len]


def _history_tail_preview(msgs: list[dict], limit: int = 3) -> list[dict]:
    out = []
    n = max(1, int(limit))
    for m in msgs[-n:]:
        role = str(m.get("role", ""))
        ts = str(m.get("timestamp", "") or m.get("ts", "") or m.get("source_ts", ""))
        text = m.get("text_display")
        if text is None:
            text = m.get("text")
        if text is None:
            text = msg_content_text(m)
        out.append(
            {
                "role": role,
                "ts": ts,
                "text": _preview_text(str(text), 90),
            }
        )
    return out


def _msg_timestamp_ms(msg: dict) -> int | None:
    raw = str(msg.get("timestamp", "") or msg.get("ts", "") or "").strip()
    if not raw:
        return None
    # Timestamps are usually unix milliseconds in string form.
    if re.fullmatch(r"\d{10,16}", raw):
        try:
            return int(raw)
        except Exception:
            return None
    return None


def _is_reset_user_boundary_text(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    tl = t.lower()
    if tl in _RESET_USER_COMMANDS:
        return True
    if tl.startswith("a new session was started via"):
        return True
    # Claude Code wraps slash commands in XML tags, e.g.:
    # <command-name>/clear</command-name> <command-message>clear</command-message> ...
    for cmd in _RESET_USER_COMMANDS:
        if f"<command-name>{cmd}</command-name>" in tl:
            return True
    return False


def _is_reset_assistant_greeting_text(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    tl = t.lower()
    # Keep this as visible first line of a fresh session in Web UI.
    return tl.startswith("✅ new session started") or tl.startswith("new session started")


def _slice_history_after_last_reset(
    msgs: list[dict],
    reset_cutoff_ts_ms: int | None = None,
) -> tuple[list[dict], dict]:
    """Slice raw session history to the latest reset boundary.

    Priority:
    1) Last explicit user reset marker (/new, /reset, gateway reset text)
    2) Last assistant reset greeting ("✅ New session started ...")
    3) Optional per-bot cutoff timestamp from the current reset flow
    """
    last_user_boundary_idx = -1
    last_assistant_greeting_idx = -1
    for idx, m in enumerate(msgs):
        txt = (msg_content_text(m) or "").strip()
        if not txt:
            continue
        if _is_reset_user_boundary_text(txt):
            # Some gateways may report synthetic reset markers with non-user roles.
            last_user_boundary_idx = idx
            continue
        if _is_reset_assistant_greeting_text(txt):
            last_assistant_greeting_idx = idx

    start_idx = 0
    boundary_seen = False
    boundary_kind = ""
    if last_user_boundary_idx >= 0:
        # Drop the reset command itself, keep everything after it.
        start_idx = last_user_boundary_idx + 1
        boundary_seen = True
        boundary_kind = "user-reset-marker"
    elif last_assistant_greeting_idx >= 0:
        # Include assistant greeting as the first message in a fresh session.
        start_idx = last_assistant_greeting_idx
        boundary_seen = True
        boundary_kind = "assistant-reset-greeting"

    cutoff_ts = None
    cutoff_idx = -1
    cutoff_matched = False
    if reset_cutoff_ts_ms is not None:
        try:
            cutoff_ts = int(reset_cutoff_ts_ms)
        except Exception:
            cutoff_ts = None
    if cutoff_ts is not None and cutoff_ts > 0:
        for idx, m in enumerate(msgs):
            ts = _msg_timestamp_ms(m)
            if ts is None:
                continue
            if ts >= cutoff_ts:
                cutoff_idx = idx
                cutoff_matched = True
                break
        if cutoff_matched:
            if cutoff_idx > start_idx:
                start_idx = cutoff_idx
        else:
            # During reset propagation, avoid showing old conversation.
            start_idx = len(msgs)

    start_idx = max(0, min(start_idx, len(msgs)))
    sliced = msgs[start_idx:]
    return sliced, {
        "resetBoundarySeen": boundary_seen,
        "resetBoundaryKind": boundary_kind,
        "resetBoundaryIndex": (last_user_boundary_idx if last_user_boundary_idx >= 0 else last_assistant_greeting_idx),
        "sliceStartIndex": start_idx,
        "resetCutoffTsMs": int(cutoff_ts or 0),
        "resetCutoffMatched": cutoff_matched,
        "resetCutoffIndex": cutoff_idx,
    }


def _normalize_display_text(role: str, text: str) -> str:
    out = (text or "").strip()
    if not out:
        return ""
    if role == "user":
        # Strip "Conversation info (untrusted metadata):" envelope.
        # The actual user text follows after the closing ``` fence.
        m = re.match(
            r"Conversation info \(untrusted metadata\):\s*```[^`]*```\s*\n*(.*)",
            out,
            re.DOTALL,
        )
        if m:
            out = m.group(1).strip()
        # Strip [media attached: ...] references (Telegram shows the image itself)
        out = re.sub(r"\[media attached:[^\]]*\]", "", out).strip()
        # Legacy: strip old voice-message prefix if still present in history
        out = re.sub(r"^\[语音消息[^\]]*\]\s*", "", out).strip()
        return out
    if role == "assistant":
        out = re.sub(r"\n?MEDIA:.*", "", out).strip()
        idx = out.find("\n\n🎤")
        if idx > 0:
            out = out[:idx]
        idx = out.find("\n\n⌨️")
        if idx > 0:
            out = out[:idx]
        return out.strip()
    return out


def _is_announce_step_user_text(text: str) -> bool:
    raw = (text or "").strip().lower()
    if not raw:
        return False
    collapsed = re.sub(r"[^a-z0-9]+", "", raw)
    # Gateway/system synthetic announce turn that should never be shown as user input.
    return collapsed.startswith("agenttoagentannouncestep")


def _is_inter_session_announce(msg: dict, text: str) -> bool:
    """Drop inter-session turns that are system-level (agent-to-agent announce),
    but keep normal inter-session messages (e.g. voice-chat user input)."""
    prov = msg.get("provenance")
    if not isinstance(prov, dict):
        return False
    if str(prov.get("kind", "")).strip().lower() != "inter_session":
        return False
    # Only hide announce-step injections, show everything else
    return _is_announce_step_user_text(text)


def _history_event_key(msg: dict, role: str, raw_text: str) -> str:
    origin_id = str(msg.get("id", "") or "")
    # Stable UUID → use directly as event key (no hashing needed).
    # IDs starting with "cc-" are random fallbacks (no uuid in JSONL entry).
    if origin_id and not origin_id.startswith("cc-"):
        return origin_id
    # Fallback: legacy full-payload hash for entries without stable IDs.
    remote_id = origin_id or str(msg.get("timestamp", "") or msg.get("ts", ""))
    payload = json.dumps(msg, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    base = f"{remote_id}|{role}|{raw_text}|{payload}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()


def _is_system_user_message(text: str) -> bool:
    """Messages injected by the agent gateway that are not real user input."""
    t = (text or "").strip()
    if not t:
        return True
    tl = t.lower()
    if tl in _RESET_USER_COMMANDS:
        return True
    # Claude Code wraps slash commands in XML tags, e.g.:
    # <command-name>/clear</command-name> <command-message>clear</command-message> ...
    for cmd in _RESET_USER_COMMANDS:
        if f"<command-name>{cmd}</command-name>" in tl:
            return True
    # Claude Code local-command caveat wrapping slash commands
    if t.startswith("<local-command-caveat>"):
        return True
    # /new or /reset session start prompt
    if tl.startswith("a new session was started via"):
        return True
    # System exec-failure notifications
    if t.startswith("System:"):
        return True
    # Image-handling instruction injected as user message
    if t.startswith("To send an image back, prefer the message tool"):
        return True
    # Periodic heartbeat check prompt injected by ralph-loop / cron
    if tl.startswith("read heartbeat.md"):
        return True
    return False


def _is_delivery_mirror(msg: dict) -> bool:
    """Check if a message is a delivery-mirror echo."""
    if str(msg.get("model", "")) == "delivery-mirror":
        return True
    if str(msg.get("provider", "")) in DELIVERY_MIRROR_PROVIDERS and str(msg.get("model", "")).startswith("delivery"):
        return True
    return False


def _is_system_assistant_message(msg: dict, text: str) -> bool:
    """Assistant messages that are system-level and not real replies."""
    t = (text or "").strip()
    if not t:
        return True
    # Keep "✅ New session started · model: ..." as a visible new-session greeting.
    # Delivery-mirror: some are real content (user messages echoed back,
    # agent replies), some are system noise.  We keep them and re-classify
    # in the main filter loop instead of blanket-dropping here.
    # (Removed blanket delivery-mirror filter — see _to_canonical_history)
    return False


def _is_inter_session_forward(msg: dict) -> bool:
    """Inter-session messages injected by another agent (not voice-chat user input).

    NOTE: With unified session keys (Web + Telegram share the same session),
    Telegram user messages are routed through the main agent via sessions_send,
    giving them provenance kind=inter_session and sourceSessionKey containing
    "main:main".  We must NOT drop these — they are legitimate user input.
    Announce steps and system messages are already filtered by earlier checks
    (_is_announce_step_user_text, _is_inter_session_announce, _is_system_user_message).
    """
    prov = msg.get("provenance")
    if not isinstance(prov, dict):
        return False
    if str(prov.get("kind", "")).strip().lower() != "inter_session":
        return False
    source_tool = str(prov.get("sourceTool", ""))
    # If it's an announce step via sessions_send, drop it
    if source_tool.strip() in _SESSIONS_SEND_NAMES and _is_announce_step_user_text(msg_content_text(msg)):
        return True
    return False


def _to_canonical_history(msgs: list[dict]) -> list[dict]:
    """Convert raw agent session history to canonical events.

    Mirrors the Telegram delivery logic:
    - Only include assistant messages with stopReason != "toolUse"
      (intermediate tool-call steps are never delivered to Telegram)
    - Strip gateway metadata from user messages
    - Skip system-injected messages (/new prompts, exec failures, etc.)
    """
    canonical: list[dict] = []
    drop_assistant_until_next_user = False
    # Track recent assistant reply texts for mirror-echo detection
    _recent_assistant_texts: set[str] = set()
    # NOTE: Case 1 (text-only user dedup) removed — mirror messages appear as
    # bot messages in Telegram, so gateway never re-ingests them as user input.
    # The old global _seen_user_texts set was incorrectly dropping legitimate
    # repeated user messages (e.g. "你是谁" sent days apart).
    # Bot name prefixes used by Telegram mirror (e.g. "川川: ", "川2: ")
    _slot_names = [str(s.get("name") or s.get("slotId") or "").strip() for s in list_slots()]
    _slot_names = [n for n in _slot_names if n]
    _mirror_bot_prefixes = tuple(f"{name}: " for name in _slot_names)
    # Mirror user-message prefixes
    _mirror_user_prefixes = ("🎤 ", "⌨️ ")
    for _msg_idx, m in enumerate(msgs):
        role = str(m.get("role", ""))
        if role not in ("user", "assistant"):
            continue
        raw_text = (msg_content_text(m) or "").strip()
        if not raw_text:
            continue

        # --- Diagnostic: log every message entering the filter pipeline ---
        _diag_ts = str(m.get("timestamp", "") or m.get("ts", "") or "")
        _diag_model = str(m.get("model", ""))
        _diag_provider = str(m.get("provider", ""))
        _diag_prov = m.get("provenance")
        _diag_prov_kind = str(_diag_prov.get("kind", "")) if isinstance(_diag_prov, dict) else ""
        _diag_prov_src = str(_diag_prov.get("sourceSessionKey", ""))[:60] if isinstance(_diag_prov, dict) else ""
        _diag_stop = str(m.get("stopReason", ""))
        logger.debug(
            f"[canonical][{_msg_idx}] ENTER role={role} ts={_diag_ts} "
            f"model={_diag_model} prov_kind={_diag_prov_kind} prov_src={_diag_prov_src} "
            f"stop={_diag_stop} drop_asst={drop_assistant_until_next_user} "
            f"text={raw_text[:80]}"
        )

        # --- Delivery-mirror reclassification ---
        # After compaction, delivery-mirror messages may be the only trace
        # of user messages and agent replies.  Reclassify them:
        #   - "🎤 ..." or text without bot-name prefix → user message
        #   - "川X: ..." prefix → assistant reply echo (may duplicate the real reply)
        if role == "assistant" and _is_delivery_mirror(m):
            _bot_prefixes = _mirror_bot_prefixes
            if raw_text.startswith(_bot_prefixes):
                for pfx in _bot_prefixes:
                    if raw_text.startswith(pfx):
                        raw_text = raw_text[len(pfx) :]
                        break
                if any(c["role"] == "assistant" and c["text_raw"].rstrip() == raw_text.rstrip() for c in canonical):
                    logger.debug(f"[canonical][{_msg_idx}] DROP dm-bot-dedup")
                    continue
                logger.debug(f"[canonical][{_msg_idx}] RECLASS dm-bot→asst-kept")
            elif raw_text.startswith("🎤 "):
                role = "user"
                raw_text = raw_text[2:].strip()
                logger.debug(f"[canonical][{_msg_idx}] RECLASS dm-voice→user")
            else:
                role = "user"
                logger.debug(f"[canonical][{_msg_idx}] RECLASS dm-other→user")

        # --- Assistant filtering ---
        if role == "assistant":
            stop_reason = str(m.get("stopReason", ""))
            if stop_reason == "toolUse":
                logger.debug(f"[canonical][{_msg_idx}] DROP asst-toolUse")
                continue
            if drop_assistant_until_next_user:
                logger.debug(f"[canonical][{_msg_idx}] DROP asst-drop-flag")
                continue
            if _is_system_assistant_message(m, raw_text):
                logger.debug(f"[canonical][{_msg_idx}] DROP asst-system")
                continue

        # --- User filtering ---
        if role == "user":
            drop_assistant_until_next_user = False
            if _is_announce_step_user_text(raw_text):
                logger.debug(f"[canonical][{_msg_idx}] DROP user-announce")
                drop_assistant_until_next_user = True
                continue
            if _is_inter_session_announce(m, raw_text):
                logger.debug(f"[canonical][{_msg_idx}] DROP user-inter-announce")
                drop_assistant_until_next_user = True
                continue
            if _is_inter_session_forward(m):
                logger.debug(f"[canonical][{_msg_idx}] DROP user-inter-fwd prov={_diag_prov_kind}|{_diag_prov_src}")
                drop_assistant_until_next_user = True
                continue
            if _is_system_user_message(raw_text):
                logger.debug(f"[canonical][{_msg_idx}] DROP user-system")
                drop_assistant_until_next_user = True
                continue
            # --- Mirror echo detection ---
            # Cases 2-4 detect structurally identifiable echoes (bot-name
            # prefix matching assistant text, or user text matching assistant
            # text).  Case 1 (text-only user dedup) was removed because mirror
            # messages appear as bot messages in Telegram — the gateway never
            # re-ingests them as user input, so the "echo" premise was false.
            _stripped = raw_text.strip()
            _is_mirror_echo = False

            # Case 2: user message with bot-name prefix = mirror of assistant reply
            if not _is_mirror_echo:
                for _bp in _mirror_bot_prefixes:
                    if _stripped.startswith(_bp):
                        _echo_text = _stripped[len(_bp) :].strip()
                        if _echo_text in _recent_assistant_texts:
                            _is_mirror_echo = True
                            break
                        if any(_echo_text and at.startswith(_echo_text[:60]) for at in _recent_assistant_texts):
                            _is_mirror_echo = True
                            break

            # Case 3: user message whose text exactly matches a recent assistant reply
            if not _is_mirror_echo and _stripped in _recent_assistant_texts:
                _is_mirror_echo = True

            # Case 4: user message matches assistant text with truncation
            if not _is_mirror_echo:
                for at in _recent_assistant_texts:
                    if len(_stripped) > 30 and at.startswith(_stripped[:80]):
                        _is_mirror_echo = True
                        break

            if _is_mirror_echo:
                logger.debug(f"[canonical] Skipping mirror-echo user message: {_stripped[:60]}")
                drop_assistant_until_next_user = True
                continue
            else:
                # Debug: log user messages that start with mirror prefixes but weren't detected
                if _stripped.startswith(_mirror_user_prefixes) or _stripped.startswith(_mirror_bot_prefixes):
                    logger.debug(f"[canonical] Kept user msg (not echo): {_stripped[:60]}")

        # --- Common filtering ---
        if raw_text in _SILENT_REPLY_SENTINELS:
            logger.debug(f"[canonical][{_msg_idx}] DROP sentinel: {raw_text[:30]}")
            continue
        display_text = _normalize_display_text(role, raw_text)
        if not display_text:
            logger.debug(f"[canonical][{_msg_idx}] DROP empty-display")
            continue
        logger.debug(f"[canonical][{_msg_idx}] KEEP role={role} display={display_text[:60]}")
        source_ts = str(m.get("timestamp", "") or m.get("ts", "") or "")
        payload_json = json.dumps(m, ensure_ascii=False)
        from backend.mirror import classify_source_channel

        source_channel = classify_source_channel(m)
        canonical.append(
            {
                "event_key": _history_event_key(m, role, raw_text),
                "role": role,
                "text_raw": raw_text,
                "text_display": display_text,
                "source_ts": source_ts,
                "payload_json": payload_json,
                "source_channel": source_channel,
            }
        )
        # Track texts for mirror-echo detection
        if role == "assistant":
            _recent_assistant_texts.add(display_text.strip())
            if len(_recent_assistant_texts) > 50:
                _recent_assistant_texts.pop()
        elif role == "user":
            pass  # no per-user-text tracking needed (Case 1 removed)
    return canonical
