"""
Turn executor: core business logic for processing a user turn.

Extracted from ``ws/processing.py`` (process_bot_message) and
``ws/handler.py`` (_poll_intermediate_steps, _bot_send_locks) so that
the session layer no longer depends on the ws transport layer.

Dependency direction:
  session/ -> adapter/, runtime/, history/, voice/, services  (allowed)
  ws/ -> session/                                              (allowed)
  session/ -> ws/                                              (FORBIDDEN)
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import re
import time
import uuid

import aiohttp
from loguru import logger

from backend.adapter.registry import get_default_adapter
from backend.config import (
    AZURE_SPEECH_KEY,
)
from backend.history.message_utils import msg_content_text
from backend.history.sync import sync_bot_history
from backend.mirror import get_mirror_manager
from backend.protocol.constants import MsgType
from backend.runtime.slot_registry import require_slot
from backend.runtime.state import (
    broadcast_bot_event,
    broadcast_history_revision,
    set_bot_processing,
)
from backend.voice.tts_registry import get_tts_provider
from backend.voice.tts_utils import clean_for_tts

# ============================================================
# Module-level adapter (hot-swappable)
# ============================================================

_adapter = get_default_adapter()


def set_runtime_adapter(adapter) -> None:
    """Hot-swap active adapter used by the processing pipeline."""
    global _adapter
    _adapter = adapter


# ============================================================
# Per-bot send locks (serialise gateway calls for the same bot)
# ============================================================

_bot_send_locks: dict[str, asyncio.Lock] = {}


# ============================================================
# Helper functions
# ============================================================


def _preview_text(text: str, max_len: int = 120) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())[:max_len]


def _chunk_for_stream(text: str, min_chars: int = 60, hard_limit: int = 200) -> list[str]:
    """Split text into stream-friendly chunks using soft-break only.

    All punctuation is treated as a soft break — a chunk is only flushed
    when the buffer has accumulated at least *min_chars* characters AND
    the current character is a break character.  Segments that exceed
    *hard_limit* without encountering any break are force-split.
    """
    src = (text or "").strip()
    if not src:
        return []

    soft_breaks = set("\n\u3002\uff01\uff1f!?\uff1b;,\uff0c\u3001 ")

    chunks: list[str] = []
    buf: list[str] = []

    for ch in src:
        buf.append(ch)
        if len(buf) >= min_chars and ch in soft_breaks:
            seg = "".join(buf).strip()
            if seg:
                chunks.append(seg)
            buf.clear()

    if buf:
        seg = "".join(buf).strip()
        if seg:
            chunks.append(seg)

    # Force-split segments that exceed the hard limit.
    out: list[str] = []
    for seg in chunks:
        if len(seg) <= hard_limit:
            out.append(seg)
            continue
        for i in range(0, len(seg), hard_limit):
            part = seg[i : i + hard_limit].strip()
            if part:
                out.append(part)

    # Merge tiny trailing fragments to avoid choppy playback.
    merged: list[str] = []
    for seg in out:
        if merged and len(seg) <= 3:
            merged[-1] += seg
        else:
            merged.append(seg)
    return merged


# ============================================================
# Intermediate step polling
# ============================================================


async def _poll_intermediate_steps(
    bot_id: str,
    session_key: str,
    adapter,
    stop_event: asyncio.Event,
    trace_id: str,
    *,
    ws_send,  # callable
    start_ts_ms: int,
    activity_monitor=None,
):
    """Poll adapter for intermediate toolUse assistant messages
    and push them to the Web frontend in real-time."""

    seen_ts: set[str] = set()
    step_seq = 0  # persistent counter for intermediate step eventKeys
    # Guardrail: only surface intermediate steps created AFTER this request started.
    # Prevents leaking old toolUse messages from yesterday.
    start_ts_ms = int(start_ts_ms)
    cutoff_ts_ms = max(0, start_ts_ms - 1500)  # allow small clock jitter
    poll_interval = 1.5  # seconds - balanced between responsiveness and gateway load
    poll_count = 0
    logger.info(f"[{trace_id}] intermediate polling started")
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=poll_interval)
            break  # stop_event was set
        except asyncio.TimeoutError:
            pass  # time to poll
        poll_count += 1
        try:
            msgs = await adapter.poll_events(
                session_key=session_key,
                limit=30,
            )
            # Signal activity: adapter responded to poll (even if no new steps)
            if activity_monitor is not None:
                activity_monitor.signal()
            new_intermediate = 0
            for m in msgs:
                ts_raw = m.get("timestamp", "") or m.get("ts", "") or m.get("source_ts", "")
                ts = str(ts_raw)
                if ts in seen_ts:
                    continue
                # Only accept messages newer than this request's start time.
                try:
                    ts_ms = int(ts_raw)
                except (TypeError, ValueError):
                    ts_ms = 0
                if ts_ms and ts_ms < cutoff_ts_ms:
                    continue
                seen_ts.add(ts)
                role = m.get("role", "")
                stop_reason = str(m.get("stopReason", ""))
                if role != "assistant" or stop_reason != "toolUse":
                    continue
                # Prefer top-level 'text' field (gateway API populates it),
                # fallback to extracting from content array
                text = str(m.get("text", "")).strip()
                if not text:
                    text = msg_content_text(m).strip()
                if not text:
                    continue
                new_intermediate += 1
                step_seq += 1
                step_event_key = hashlib.sha1(f"{trace_id}|step|{step_seq}".encode("utf-8")).hexdigest()
                logger.info(f"[{trace_id}] intermediate step #{step_seq}: {_preview_text(text, 100)}")
                await ws_send(
                    {
                        "type": MsgType.INTERMEDIATE_STEP,
                        "text": text,
                        "botId": bot_id,
                        "eventKey": step_event_key,
                        "contentKind": "intermediate",
                    }
                )
            # Log roles of all messages for debugging
            roles_summary = [(m.get("role", "?"), str(m.get("stopReason", ""))) for m in msgs[-5:]]
            if poll_count <= 5 or new_intermediate > 0 or poll_count % 10 == 0:
                logger.info(
                    f"[{trace_id}] poll #{poll_count}: {len(msgs)} msgs,"
                    f" {new_intermediate} new intermediate, tail={roles_summary}"
                )
        except Exception as e:
            logger.warning(f"[{trace_id}] intermediate poll error: {e}")
    logger.info(f"[{trace_id}] intermediate polling stopped after {poll_count} polls")


# ============================================================
# Streaming turn helper (LLM→TTS interleaved)
# ============================================================


async def _process_streaming_turn(
    *,
    adapter,
    bot_id: str,
    bot_name: str,
    session_key: str,
    user_text: str,
    source: str,
    trace_id: str,
    client_msg_id: str,
    ws_send,
    current_bot_id: str,
    bot_voices: dict,
    bot_tts_rates: dict,
    recent_bot_replies: dict,
    history_store,
    config: dict,
    task_http,
):
    """Process a turn via adapter.stream_user_turn().

    The SessionWatcher handles JSONL reading, canonical_store persistence,
    and message_sync WS push.  This function only manages turn lifecycle
    (FSM transitions), mirrors, and TTS.
    """
    user_icon = "\U0001f3a4" if source == "audio" else "\u2328\ufe0f"
    get_mirror_manager().enqueue(
        bot_id=bot_id,
        account_id=config["accountId"],
        event_key=hashlib.sha1(f"{trace_id}|user".encode("utf-8")).hexdigest(),
        message_text=f"{user_icon} {user_text}",
    )

    _exclude_q = getattr(ws_send, "push_queue", None)
    full_reply_parts: list[str] = []
    _use_azure = bool(AZURE_SPEECH_KEY)
    _skip_tts = (bot_id != current_bot_id) or _use_azure
    _voice = bot_voices.get(bot_id)
    rate = bot_tts_rates.get(bot_id, "1.0")
    sent_any_audio = False

    # Azure streaming chunking buffer
    _azure_buf: list[str] = []
    _AZURE_MIN_CHARS = 60
    _azure_soft_breaks = set("\n\u3002\uff01\uff1f!?\uff1b;,\uff0c\u3001 ")
    _azure_speak_seq = 0

    async def _flush_azure_speak(force: bool = False) -> None:
        nonlocal _azure_speak_seq
        text = clean_for_tts("".join(_azure_buf).strip())
        _azure_buf.clear()
        if not text:
            return
        _azure_speak_seq += 1
        await ws_send(
            {
                "type": MsgType.SPEAK,
                "text": text,
                "botId": bot_id,
                "streaming": True,
            }
        )

    # Adapters with a watcher (e.g. Claude Code) push message_sync via the
    # watcher with real serverSeq/timestamp.  For adapters WITHOUT a watcher,
    # the turn_executor must send message_sync for non-result content.
    _adapter_caps_pre = (
        adapter.capabilities_for(session_key) if hasattr(adapter, "capabilities_for") else adapter.report_capabilities()
    )
    _watcher_handles_display = bool(getattr(_adapter_caps_pre, "has_watcher", False))
    _stream_step_idx = 0

    try:
        async for evt in adapter.stream_user_turn(
            bot_id=bot_id,
            session_key=session_key,
            text=user_text,
            timeout_seconds=0,  # orchestrator watchdog controls lifetime
            client_msg_id=client_msg_id,
        ):
            if evt.type == "assistant_delta":
                chunk_text = evt.text
                if not chunk_text:
                    continue
                ck = getattr(evt, "content_kind", "result") or "result"
                # For adapters without a watcher, forward non-result events
                # as message_sync so the frontend can display them.
                if ck != "result":
                    if not _watcher_handles_display:
                        _stream_step_idx += 1
                        _step_key = hashlib.sha1(f"{trace_id}|stream-step|{ck}|{_stream_step_idx}".encode()).hexdigest()
                        await ws_send(
                            {
                                "type": MsgType.MESSAGE_SYNC,
                                "text": chunk_text,
                                "botId": bot_id,
                                "eventKey": _step_key,
                                "contentKind": ck,
                                "role": "assistant",
                                "intermediate": True,
                            }
                        )
                    continue
                full_reply_parts.append(chunk_text)
                # TTS streaming for controller mode
                if _use_azure and bot_id == current_bot_id:
                    for ch in chunk_text:
                        _azure_buf.append(ch)
                        if len(_azure_buf) >= _AZURE_MIN_CHARS and ch in _azure_soft_breaks:
                            await _flush_azure_speak()
                elif not _skip_tts:
                    tts_text = clean_for_tts(chunk_text)
                    if tts_text:
                        try:
                            audio = await get_tts_provider().synthesize(tts_text, voice=_voice, rate=rate)
                            if audio:
                                sent_any_audio = True
                                audio_b64 = base64.b64encode(audio).decode()
                                await ws_send({"type": MsgType.AUDIO_CHUNK, "data": audio_b64, "botId": bot_id})
                        except Exception as e:
                            logger.warning(f"[{trace_id}] streaming TTS chunk error: {e}")

            elif evt.type == "assistant_final":
                # Turn complete — collect any final text
                chunk_text = evt.text
                full_reply = evt.payload.get("full_reply", "") if evt.payload else ""
                if not full_reply:
                    if chunk_text:
                        full_reply_parts.append(chunk_text)
                    full_reply = "".join(full_reply_parts)

    except Exception as e:
        logger.error(f"[{trace_id}] streaming turn error: {e}")

    # Flush any remaining Azure TTS buffer
    if _azure_buf:
        await _flush_azure_speak(force=True)

    raw_reply = "".join(full_reply_parts) if full_reply_parts else ""
    display_reply = re.sub(r"\n?MEDIA:.*", "", raw_reply).strip()

    # Adapters with their own watcher (e.g. Claude Code SessionWatcher) handle
    # history sync, message_sync push, and serverSeq assignment independently.
    # The streaming sync below is only needed for adapters WITHOUT a watcher
    # (e.g. OpenClaw) that rely on turn_executor for message confirmation.
    _adapter_caps = (
        adapter.capabilities_for(session_key) if hasattr(adapter, "capabilities_for") else adapter.report_capabilities()
    )
    if not _adapter_caps.has_watcher:
        user_event_key = hashlib.sha1(f"{trace_id}|user".encode("utf-8")).hexdigest()
        try:
            sync_meta = await sync_bot_history(bot_id, task_http, wait_if_locked=True)
            assigned_seqs = (sync_meta or {}).get("assignedSeqs", {})

            # If streaming produced no reply (WS events not received), recover
            # the assistant reply from the just-synced history.
            if not display_reply:
                try:
                    from backend.app import get_history_store

                    _store = get_history_store()
                    _rows = _store._load_filtered_rows_for_bot(
                        _store._conn.cursor(),
                        bot_id,
                    )
                    if _rows:
                        for _r in reversed(_rows):
                            if _r["role"] == "assistant" and _r["text"].strip():
                                display_reply = _r["text"].strip()
                                break
                except Exception:
                    pass

            # Send confirmed user message_sync (clientMsgId reconciles pending msg)
            user_server_seq = assigned_seqs.get(user_event_key)
            if user_server_seq is not None:
                await ws_send(
                    {
                        "type": MsgType.MESSAGE_SYNC,
                        "text": user_text,
                        "botId": bot_id,
                        "eventKey": user_event_key,
                        "role": "user",
                        "serverSeq": user_server_seq,
                        "clientMsgId": client_msg_id,
                    }
                )

            await _emit_history_revision(ws_send, bot_id, sync_meta)
            if sync_meta and sync_meta.get("changed"):
                await broadcast_history_revision(bot_id, sync_meta, exclude=_exclude_q)
        except Exception as exc:
            logger.warning(f"[{trace_id}] streaming turn history sync failed: {exc}")

    # Mirror + TTS + recent_bot_replies use display_reply (may have been
    # recovered from sync above).
    recent_bot_replies[bot_id] = {
        "text": display_reply,
        "ts": asyncio.get_running_loop().time(),
    }
    if display_reply:
        get_mirror_manager().enqueue(
            bot_id=bot_id,
            account_id=config["accountId"],
            event_key=hashlib.sha1(f"{trace_id}|assistant|mirror".encode("utf-8")).hexdigest(),
            message_text=display_reply,
        )

    # Send TTS for the complete reply (non-streaming fallback)
    if display_reply and not sent_any_audio:
        if not _use_azure and not _skip_tts:
            await ws_send({"type": MsgType.SPEAK, "text": display_reply, "botId": bot_id})
        elif not _use_azure:
            await ws_send({"type": MsgType.SPEAK, "text": display_reply, "botId": bot_id})

    await ws_send({"type": MsgType.AUDIO_COMPLETE, "botId": bot_id})
    await set_bot_processing(bot_id, "")


# ============================================================
# Non-streaming turn helper (original path)
# ============================================================


async def _process_non_streaming_turn(
    *,
    adapter,
    bot_id: str,
    bot_name: str,
    session_key: str,
    user_text: str,
    source: str,
    trace_id: str,
    client_msg_id: str,
    ws_send,
    current_bot_id: str,
    bot_voices: dict,
    bot_tts_rates: dict,
    recent_bot_replies: dict,
    history_store,
    config: dict,
    task_http,
    activity_monitor=None,
):
    """Original non-streaming turn processing path."""
    _exclude_q = getattr(ws_send, "push_queue", None)
    # Start intermediate step polling in parallel with adapter send.
    intermediate_stop = asyncio.Event()
    start_ts_ms = int(time.time() * 1000)
    intermediate_task = asyncio.create_task(
        _poll_intermediate_steps(
            bot_id,
            session_key,
            adapter,
            intermediate_stop,
            trace_id,
            ws_send=ws_send,
            start_ts_ms=start_ts_ms,
            activity_monitor=activity_monitor,
        )
    )
    logger.info(f"[{trace_id}] intermediate task created, starting adapter send_user_turn")

    try:
        reply = await adapter.send_user_turn(
            bot_id=bot_id,
            session_key=session_key,
            text=user_text,
            timeout_seconds=0,  # no adapter-level deadline; orchestrator watchdog controls lifetime
        )
    finally:
        # Stop intermediate polling and clean up its HTTP session
        intermediate_stop.set()
        try:
            await asyncio.wait_for(intermediate_task, timeout=2)
        except (asyncio.TimeoutError, Exception):
            intermediate_task.cancel()

    user_icon = "\U0001f3a4" if source == "audio" else "\u2328\ufe0f"
    get_mirror_manager().enqueue(
        bot_id=bot_id,
        account_id=config["accountId"],
        event_key=hashlib.sha1(f"{trace_id}|user".encode("utf-8")).hexdigest(),
        message_text=f"{user_icon} {user_text}",
    )

    if not reply:
        sync_meta = await sync_bot_history(bot_id, task_http, wait_if_locked=True)
        await _emit_history_revision(ws_send, bot_id, sync_meta)
        if sync_meta and sync_meta.get("changed"):
            await broadcast_history_revision(bot_id, sync_meta, exclude=_exclude_q)
        timeout_event_key = hashlib.sha1(f"{trace_id}|timeout".encode("utf-8")).hexdigest()
        timeout_text = f"{bot_name}暂时没拿到回复（可能超时），请重试一次"
        timeout_msg = {
            "type": MsgType.RESPONSE,
            "text": timeout_text,
            "botId": bot_id,
            "ts": str(int(time.time() * 1000)),
            "eventKey": timeout_event_key,
            "status": "confirmed",
            "persisted": True,
            "timeout": True,
        }
        await ws_send(timeout_msg)
        await broadcast_bot_event(timeout_msg, exclude=_exclude_q)
        await set_bot_processing(bot_id, "")
        return

    display_reply = re.sub(r"\n?MEDIA:.*", "", reply).strip()
    cleaned = clean_for_tts(reply)
    logger.info(f"[{trace_id}] Reply: {display_reply}")
    if display_reply:
        get_mirror_manager().enqueue(
            bot_id=bot_id,
            account_id=config["accountId"],
            event_key=hashlib.sha1(f"{trace_id}|assistant|mirror".encode("utf-8")).hexdigest(),
            message_text=display_reply,
        )

    assistant_event_key = hashlib.sha1(f"{trace_id}|assistant".encode("utf-8")).hexdigest()

    # Sync history so canonical_store has the message with a serverSeq
    recent_bot_replies[bot_id] = {
        "text": display_reply,
        "ts": asyncio.get_running_loop().time(),
    }
    sync_meta = await sync_bot_history(bot_id, task_http, wait_if_locked=True)

    assigned_seqs = (sync_meta or {}).get("assignedSeqs", {})
    assistant_server_seq = assigned_seqs.get(assistant_event_key)

    # Send via message_sync (unified path — replaces response_chunk + response_complete)
    await ws_send(
        {
            "type": MsgType.MESSAGE_SYNC,
            "text": display_reply,
            "botId": bot_id,
            "eventKey": assistant_event_key,
            "role": "assistant",
            "serverSeq": assistant_server_seq,
        }
    )
    await broadcast_bot_event(
        {
            "type": MsgType.RESPONSE,
            "text": display_reply,
            "botId": bot_id,
            "eventKey": assistant_event_key,
            "ts": str(int(time.time() * 1000)),
            "status": "confirmed",
            "persisted": True,
        },
        exclude=_exclude_q,
    )

    await _emit_history_revision(ws_send, bot_id, sync_meta)
    if sync_meta and sync_meta.get("changed"):
        await broadcast_history_revision(bot_id, sync_meta, exclude=_exclude_q)

    # TTS: When Azure Speech is configured, chunk the reply and send
    # each chunk as a separate SPEAK message for browser-direct synthesis.
    # Otherwise, fall back to server-side Edge TTS.
    _skip_tts = bot_id != current_bot_id
    if AZURE_SPEECH_KEY:
        if display_reply:
            tts_text = clean_for_tts(display_reply)
            if tts_text:
                speak_chunks = _chunk_for_stream(tts_text)
                for seg in speak_chunks:
                    seg = seg.strip()
                    if seg:
                        await ws_send({"type": MsgType.SPEAK, "text": seg, "botId": bot_id, "streaming": True})
        await ws_send({"type": MsgType.AUDIO_COMPLETE, "botId": bot_id})
        await set_bot_processing(bot_id, "")
    elif _skip_tts:
        _tts_text = cleaned or display_reply
        if _tts_text:
            await ws_send({"type": MsgType.SPEAK, "text": _tts_text, "botId": bot_id})
        await ws_send({"type": MsgType.AUDIO_COMPLETE, "botId": bot_id})
        await set_bot_processing(bot_id, "")
    else:
        _voice = bot_voices.get(bot_id)
        rate = bot_tts_rates.get(bot_id, "1.0")
        try:
            if cleaned:
                await ws_send({"type": MsgType.STATUS, "text": "\u751f\u6210\u8bed\u97f3...", "botId": bot_id})
                tts_chunks = _chunk_for_stream(cleaned)
                if not tts_chunks:
                    tts_chunks = [cleaned]
                sent_any_audio = False
                for seg in tts_chunks:
                    part = seg.strip()
                    if not part:
                        continue
                    audio = await get_tts_provider().synthesize(part, voice=_voice, rate=rate)
                    if not audio:
                        continue
                    sent_any_audio = True
                    audio_b64 = base64.b64encode(audio).decode()
                    await ws_send({"type": MsgType.AUDIO_CHUNK, "data": audio_b64, "botId": bot_id})
                if not sent_any_audio:
                    await ws_send({"type": MsgType.SPEAK, "text": cleaned, "botId": bot_id})
            elif display_reply:
                await ws_send({"type": MsgType.SPEAK, "text": display_reply, "botId": bot_id})
        except Exception as e:
            logger.error(f"[{bot_id}] TTS error: {e}")
            fallback = cleaned or display_reply
            if fallback:
                await ws_send({"type": MsgType.SPEAK, "text": fallback, "botId": bot_id})
        finally:
            await ws_send({"type": MsgType.AUDIO_COMPLETE, "botId": bot_id})
            await set_bot_processing(bot_id, "")


# ============================================================
# Core processing function
# ============================================================


async def process_bot_message(
    user_text: str,
    bot_id: str,
    source: str,
    client_msg_id: str,
    ws_send,  # callable to send WS messages
    current_bot_id: str,
    bot_voices: dict,
    bot_tts_rates: dict,
    recent_bot_replies: dict,
    history_store,  # CanonicalHistoryStore
    activity_monitor=None,
):
    """Process a user message for a specific bot (runs as independent task).

    This was originally the ``process_message`` closure inside
    ``websocket_endpoint``.  All previously captured variables are now
    passed as explicit parameters.
    """
    config = require_slot(bot_id)
    bot_name = config["name"]
    session_key = config["sessionKey"]
    trace_id = f"{bot_id}:{source}:{uuid.uuid4().hex[:12]}"
    adapter = _adapter
    # Originating client's push queue — excluded from broadcasts to prevent duplicates
    _exclude_q = getattr(ws_send, "push_queue", None)
    logger.info(
        f"[{trace_id}] inbound source={source} bot={bot_id} "
        f"sessionKey={session_key} text={_preview_text(user_text, 180)}"
    )

    # Send user transcript to frontend (tagged with botId + stable eventKey for dedup)
    user_event_key = hashlib.sha1(f"{trace_id}|user".encode("utf-8")).hexdigest()
    transcript_msg = {
        "type": MsgType.TRANSCRIPT,
        "text": user_text,
        "botId": bot_id,
        "source": source,
        "eventKey": user_event_key,
    }
    if client_msg_id:
        transcript_msg["clientMsgId"] = client_msg_id
    await ws_send(transcript_msg)
    await broadcast_bot_event(transcript_msg, exclude=_exclude_q)
    await set_bot_processing(bot_id, f"{bot_name}\u601d\u8003\u4e2d...", trace_id)
    await ws_send({"type": MsgType.STATUS, "text": f"{bot_name}\u601d\u8003\u4e2d...", "botId": bot_id})

    # Get reply from bot session
    try:
        async with aiohttp.ClientSession() as task_http:
            lock = _bot_send_locks.setdefault(bot_id, asyncio.Lock())
            if lock.locked():
                queued_text = f"{bot_name}前面还有一条在处理，已排队..."
                await ws_send({"type": MsgType.STATUS, "text": queued_text, "botId": bot_id})
            async with lock:
                logger.info(f"[{trace_id}] processing message")

                # Notify client that adapter is about to process
                if client_msg_id:
                    await ws_send(
                        {
                            "type": MsgType.AGENT_STARTED,
                            "botId": bot_id,
                            "clientMsgId": client_msg_id,
                        }
                    )

                # Check if the adapter for THIS session_key supports streaming turn
                caps = (
                    adapter.capabilities_for(session_key)
                    if hasattr(adapter, "capabilities_for")
                    else adapter.report_capabilities()
                )
                _use_streaming_turn = bool(getattr(caps, "supports_streaming_turn", False)) and hasattr(
                    adapter, "stream_user_turn"
                )

                if _use_streaming_turn:
                    # ═══════════════════════════════════════════════
                    # Streaming LLM→TTS path: interleave text + TTS
                    # ═══════════════════════════════════════════════
                    await _process_streaming_turn(
                        adapter=adapter,
                        bot_id=bot_id,
                        bot_name=bot_name,
                        session_key=session_key,
                        user_text=user_text,
                        source=source,
                        trace_id=trace_id,
                        client_msg_id=client_msg_id,
                        ws_send=ws_send,
                        current_bot_id=current_bot_id,
                        bot_voices=bot_voices,
                        bot_tts_rates=bot_tts_rates,
                        recent_bot_replies=recent_bot_replies,
                        history_store=history_store,
                        config=config,
                        task_http=task_http,
                    )
                else:
                    # ═══════════════════════════════════════════════
                    # Original non-streaming path (unchanged)
                    # ═══════════════════════════════════════════════
                    await _process_non_streaming_turn(
                        adapter=adapter,
                        bot_id=bot_id,
                        bot_name=bot_name,
                        session_key=session_key,
                        user_text=user_text,
                        source=source,
                        trace_id=trace_id,
                        client_msg_id=client_msg_id,
                        ws_send=ws_send,
                        current_bot_id=current_bot_id,
                        bot_voices=bot_voices,
                        bot_tts_rates=bot_tts_rates,
                        recent_bot_replies=recent_bot_replies,
                        history_store=history_store,
                        config=config,
                        task_http=task_http,
                        activity_monitor=activity_monitor,
                    )

    except asyncio.CancelledError:
        logger.info(f"[{bot_id}] Process cancelled")
        await ws_send({"type": MsgType.TURN_CANCELLED, "botId": bot_id, "mode": "generation_cancelled"})
        await set_bot_processing(bot_id, "")
    except Exception as e:
        logger.error(f"[{bot_id}] Process error: {e}")
        await ws_send({"type": MsgType.RESPONSE, "text": f"\u5904\u7406\u51fa\u9519: {e}", "botId": bot_id})
        await set_bot_processing(bot_id, "")  # clear on error too


# ============================================================
# Internal helpers
# ============================================================


async def _emit_history_revision(ws_send, bot_id: str, meta: dict | None):
    """Send history revision notification to one WS client."""
    if not meta:
        return
    from backend.app import get_history_store

    await ws_send(
        {
            "type": MsgType.HISTORY_REVISION,
            "botId": bot_id,
            "revision": int(meta.get("revision", 0)),
            "remoteCount": int(meta.get("count", 0)),
            "maxServerSeq": int(meta.get("maxServerSeq", 0)),
            "changed": bool(meta.get("changed", False)),
            "lastReadSeq": get_history_store().get_last_read_seq(bot_id),
        }
    )
