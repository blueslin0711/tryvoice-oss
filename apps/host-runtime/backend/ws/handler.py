"""
WebSocket endpoint handler.

Extracted from the original server.py ``websocket_endpoint`` function
(lines ~1545-2151).  Registers a ``/ws`` route via an APIRouter.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
import traceback
from collections import OrderedDict

import aiohttp
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from loguru import logger

from backend.adapter.registry import get_active_adapter_info
from backend.auth import is_auth_enabled, is_websocket_authenticated
from backend.config import GROQ_WHISPER_MODEL
from backend.history.sync import sync_bot_history
from backend.ops.metrics import ws_connected, ws_disconnected
from backend.protocol.constants import MsgType
from backend.runtime.slot_registry import (
    enrich_slot_fields,
    get_default_slot_id,
    get_slot_name,
    require_slot,
    resolve_slot_id,
)
from backend.session.runtime_orchestrator import RuntimeSessionOrchestrator
from backend.session.turn_executor import (
    _bot_send_locks,
    _preview_text,
)
from backend.voice.stt_registry import get_stt_provider
from backend.voice.vad import VAD_ENABLED, filter_audio_for_stt
from backend.ws.connection_registry import ClientInfo
from backend.ws.manager import (
    broadcast_history_revision,
    get_bot_processing_states,
    registry,
)
from backend.ws.processing import _trim_endword

router = APIRouter()
MAX_PUSH_PROCESSING_AGE_SEC = 600.0
INBOUND_MSG_DEDUP_TTL_SEC = 5 * 60
INBOUND_MSG_DEDUP_MAX = 8000

_inbound_seen_msg: "OrderedDict[str, float]" = OrderedDict()
_inbound_seen_msg_lock = asyncio.Lock()
_session_orchestrator = RuntimeSessionOrchestrator()


def set_runtime_adapter(adapter) -> None:
    """Hot-swap adapter used by runtime orchestrator."""
    _session_orchestrator.set_adapter(adapter)


def get_session_orchestrator():
    """Return the module-level RuntimeSessionOrchestrator instance."""
    return _session_orchestrator


async def _mark_or_reject_duplicate(msg_type: str, bot_id: str, msg_id: str) -> bool:
    """Return True if this inbound message is a duplicate and should be ignored."""
    if not msg_id:
        return False
    now = asyncio.get_running_loop().time()
    dedup_key = f"{msg_type}:{bot_id}:{msg_id}"
    async with _inbound_seen_msg_lock:
        # Fast prune: oldest-first since OrderedDict keeps insertion order.
        while _inbound_seen_msg:
            first_key = next(iter(_inbound_seen_msg))
            if _inbound_seen_msg[first_key] > now:
                break
            _inbound_seen_msg.popitem(last=False)

        expires = _inbound_seen_msg.get(dedup_key)
        if expires and expires > now:
            return True

        _inbound_seen_msg[dedup_key] = now + INBOUND_MSG_DEDUP_TTL_SEC
        _inbound_seen_msg.move_to_end(dedup_key)
        while len(_inbound_seen_msg) > INBOUND_MSG_DEDUP_MAX:
            _inbound_seen_msg.popitem(last=False)
        return False


# ============================================================
# WebSocket endpoint
# ============================================================


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    # Check Control Plane ticket auth (if CP is enabled)
    from backend.control_plane_client.config import is_cp_enabled

    if is_cp_enabled():
        ticket_token = ws.query_params.get("ticket")
        if ticket_token:
            from backend.control_plane_client.token_verifier import verify_connection_ticket

            result = await verify_connection_ticket(ticket_token)
            if not result:
                await ws.close(code=1008, reason="invalid_ticket")
                return
            # Ticket valid — skip legacy password auth
        else:
            # No ticket provided but CP is enabled — require ticket
            await ws.close(code=1008, reason="ticket_required")
            return
    elif is_auth_enabled() and not is_websocket_authenticated(ws):
        await ws.close(code=1008, reason="unauthorized")
        return
    await ws.accept()
    ws_connected()
    conn_id = hashlib.sha1(f"{id(ws)}-{time.time()}".encode()).hexdigest()[:8]
    client_id = ws.query_params.get("client_id", conn_id)
    device_type = ws.query_params.get("device_type", "unknown")

    bot_voices = {}  # {botId: edge_voice_name}
    # Lock for ws.send_json to prevent interleaved writes
    ws_lock = asyncio.Lock()
    # Cache last assistant response per bot to suppress immediate acoustic self-loop.
    recent_bot_replies = {}  # {botId: {"text": str, "ts": float}}

    ws_closed = False
    # Queue for receiving push notifications from history sync loop
    push_queue: asyncio.Queue = asyncio.Queue(maxsize=100)

    current_bot_id = get_default_slot_id()
    stt_language = "en"
    stt_model = GROQ_WHISPER_MODEL
    bot_tts_rates = {}  # per-bot tts rate multiplier string
    background_tasks: set = set()

    def _on_task_done(task: asyncio.Task):
        background_tasks.discard(task)
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            logger.bind(component="ws.handler", conn_id=conn_id).error(
                "Background task exception: {}\n{}",
                exc,
                "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)),
            )

    async def ws_send(msg: dict):
        nonlocal ws_closed
        if ws_closed:
            return
        try:
            payload = enrich_slot_fields(dict(msg))
            async with ws_lock:
                await ws.send_json(payload)
        except Exception:
            pass  # Connection closed, ignore

    # Attach push queue so downstream code can exclude this client from broadcasts
    ws_send.push_queue = push_queue  # type: ignore[attr-defined]

    try:
        info = get_active_adapter_info()
        # Include slash commands for the default bot on initial connect
        _init_slash_cmds: list = []
        try:
            adapter = _session_orchestrator.adapter
            if adapter and hasattr(adapter, "slash_commands"):
                _init_sk = require_slot(current_bot_id).get("sessionKey", "")
                _init_slash_cmds = adapter.slash_commands(_init_sk)
        except Exception:
            pass
        await ws_send(
            {
                "type": MsgType.ADAPTER_STATUS,
                "adapterId": str(info.get("adapterId", "")),
                "supportsStream": bool(info.get("supportsStream", True)),
                "supportsCancel": bool(info.get("supportsCancel", False)),
                "supportsSessionResume": bool(info.get("supportsSessionResume", True)),
                "supportsToolEvents": bool(info.get("supportsToolEvents", False)),
                "degradeHints": list(info.get("degradeHints", [])),
                "syncHints": dict(info.get("syncHints", {})),
                "turnTimeoutHints": dict(info.get("turnTimeoutHints", {})),
                "slashCommands": _init_slash_cmds,
            }
        )
    except Exception as e:
        logger.bind(component="ws.handler").warning("emit adapter_status failed: {}", e)

    async def emit_history_revision(bot_id: str, meta: dict | None):
        if not meta:
            return
        await ws_send(
            {
                "type": MsgType.HISTORY_REVISION,
                "botId": bot_id,
                "revision": int(meta.get("revision", 0)),
                "remoteCount": int(meta.get("count", 0)),
                "maxServerSeq": int(meta.get("maxServerSeq", 0)),
                "changed": bool(meta.get("changed", False)),
                "lastReadSeq": history_store.get_last_read_seq(bot_id),
            }
        )

    # Keepalive ping task
    async def ws_keepalive():
        while not ws_closed:
            try:
                await ws.send_json({"type": MsgType.PING})
            except Exception:
                break
            await asyncio.sleep(10)

    # Push forwarder: forwards history sync notifications to this WS client
    async def ws_push_forwarder():
        while not ws_closed:
            try:
                msg = await asyncio.wait_for(push_queue.get(), timeout=1.0)
                await ws_send(msg)
            except asyncio.TimeoutError:
                continue
            except Exception:
                break

    keepalive_task = asyncio.create_task(ws_keepalive())
    push_forwarder_task = asyncio.create_task(ws_push_forwarder())

    # Register this client for push notifications
    reg_info = ClientInfo(
        conn_id=conn_id,
        client_id=client_id,
        device_type=device_type,
        push_queue=push_queue,
        connected_at=asyncio.get_running_loop().time(),
    )
    await registry.register(reg_info)

    # Push current processing states so reconnecting clients restore status
    try:
        states = get_bot_processing_states()
        for bid, st in states.items():
            if float(st.get("elapsedSec", 0.0)) > MAX_PUSH_PROCESSING_AGE_SEC:
                continue
            await ws_send({"type": MsgType.STATUS, "text": st["status"], "botId": bid})
    except Exception:
        pass

    # Resend pending hook interactive requests (permission cards) on reconnect
    try:
        adapter = _session_orchestrator.adapter
        if hasattr(adapter, "resend_pending_hook_requests"):
            await adapter.resend_pending_hook_requests()
    except Exception:
        pass

    # Import history store at function level to
    # keep the same runtime behaviour as the original closure.
    from backend.app import get_history_store

    history_store = get_history_store()

    async with aiohttp.ClientSession() as _http:
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    data = json.loads(raw)
                except Exception:
                    logger.bind(component="ws.handler").warning("Malformed JSON, ignoring message")
                    continue

                if data.get("type") in {MsgType.SWITCH_BOT, MsgType.SWITCH_SLOT}:
                    requested = data.get("slotId") or data.get("botId")
                    if requested:
                        slot_id = resolve_slot_id(str(requested))
                    else:
                        slot_id = current_bot_id
                    if slot_id:
                        # Mark the OLD bot's messages as read before switching.
                        # Without this, messages the user already saw while
                        # viewing the old bot get counted as unread later.
                        old_bot_id = current_bot_id
                        if old_bot_id and old_bot_id != slot_id:
                            old_max = history_store.get_max_server_seq(old_bot_id)
                            if old_max > 0:
                                history_store.update_last_read_seq(old_bot_id, old_max)
                        current_bot_id = slot_id
                        slot_name = get_slot_name(slot_id)
                        # Mark all messages as read for the switched-to bot
                        max_seq = history_store.get_max_server_seq(slot_id)
                        if max_seq > 0:
                            history_store.update_last_read_seq(slot_id, max_seq)
                        logger.bind(component="ws.handler", bot_id=slot_id).info(
                            "Switched to slot: {} ({})",
                            slot_id,
                            slot_name,
                        )
                        # Resolve slash commands for the switched-to bot
                        _slash_cmds: list = []
                        try:
                            adapter = _session_orchestrator.adapter
                            if hasattr(adapter, "slash_commands"):
                                _sk = require_slot(slot_id).get("sessionKey", "")
                                _slash_cmds = adapter.slash_commands(_sk)
                        except Exception:
                            pass
                        await ws_send(
                            {
                                "type": MsgType.BOT_SWITCHED,
                                "botId": slot_id,
                                "slotId": slot_id,
                                "name": slot_name,
                                "slashCommands": _slash_cmds,
                            }
                        )
                    else:
                        await ws_send(
                            {
                                "type": MsgType.STATUS,
                                "text": "未知 slot，切换失败",
                                "botId": current_bot_id,
                            }
                        )
                    continue

                elif data.get("type") == MsgType.MARK_READ:
                    # Client tells us the user has seen messages up to a given seq
                    mark_bot = data.get("botId") or current_bot_id
                    mark_seq = int(data.get("seq", 0))
                    if mark_bot and mark_seq > 0:
                        history_store.update_last_read_seq(mark_bot, mark_seq)
                    continue

                elif data.get("type") == MsgType.SET_VOICE:
                    requested = data.get("slotId") or data.get("botId")
                    if requested:
                        resolved = resolve_slot_id(str(requested))
                        if not resolved:
                            await ws_send(
                                {
                                    "type": MsgType.STATUS,
                                    "text": "未知 slot，语音设置失败",
                                    "botId": current_bot_id,
                                }
                            )
                            continue
                        bot_id = resolved
                    else:
                        bot_id = current_bot_id
                    voice = data.get("voiceId", "")
                    if voice:
                        bot_voices[bot_id] = voice
                    else:
                        bot_voices.pop(bot_id, None)
                    logger.bind(component="ws.handler", bot_id=bot_id).info(
                        "Voice for {}: {}",
                        bot_id,
                        voice or "default",
                    )
                    await ws_send({"type": MsgType.VOICE_SET, "botId": bot_id, "voiceId": voice})
                    continue

                elif data.get("type") == MsgType.SET_STT_LANGUAGE:
                    stt_language = data.get("language", "en")
                    logger.bind(component="ws.handler").info("STT language set to: {}", stt_language)
                    await ws_send({"type": MsgType.STT_LANGUAGE_SET, "language": stt_language})
                    continue

                elif data.get("type") == MsgType.SET_STT_MODEL:
                    stt_model = data.get("model", GROQ_WHISPER_MODEL)
                    logger.bind(component="ws.handler").info("STT model set to: {}", stt_model)
                    await ws_send({"type": MsgType.STT_MODEL_SET, "model": stt_model})
                    continue

                elif data.get("type") == MsgType.SET_TTS_RATE:
                    requested = data.get("slotId") or data.get("botId")
                    if requested:
                        resolved = resolve_slot_id(str(requested))
                        if not resolved:
                            await ws_send(
                                {
                                    "type": MsgType.STATUS,
                                    "text": "未知 slot，语速设置失败",
                                    "botId": current_bot_id,
                                }
                            )
                            continue
                        bot_id = resolved
                    else:
                        bot_id = current_bot_id
                    rate = str(data.get("rate", "1.0"))
                    bot_tts_rates[bot_id] = rate
                    logger.bind(component="ws.handler", bot_id=bot_id).info("TTS rate for {} set to: {}", bot_id, rate)
                    continue

                elif data.get("type") == MsgType.AUDIO:
                    # Use explicit botId if provided, otherwise current bot
                    requested = data.get("slotId") or data.get("botId")
                    if requested:
                        resolved = resolve_slot_id(str(requested))
                        if not resolved:
                            await ws_send(
                                {
                                    "type": MsgType.STATUS,
                                    "text": "未知 slot，音频请求已忽略",
                                    "botId": current_bot_id,
                                }
                            )
                            continue
                        target_bot_id = resolved
                    else:
                        target_bot_id = current_bot_id
                    msg_id = data.get("msgId", "")
                    if await _mark_or_reject_duplicate("audio", target_bot_id, str(msg_id or "")):
                        logger.bind(component="ws.handler", bot_id=target_bot_id).warning(
                            "Duplicate audio ignored (msgId={})",
                            msg_id,
                        )
                        await ws_send({"type": MsgType.ACK, "msgId": msg_id, "botId": target_bot_id})
                        continue
                    audio_bytes = base64.b64decode(data["data"])
                    logger.bind(component="ws.handler", bot_id=target_bot_id).info(
                        "Received audio: {} bytes",
                        len(audio_bytes),
                    )
                    # Immediate ack so client knows server received it
                    await ws_send({"type": MsgType.ACK, "msgId": msg_id, "botId": target_bot_id})

                    # VAD pre-filter (only when enabled)
                    if VAD_ENABLED:
                        filtered = await filter_audio_for_stt(audio_bytes)
                        if filtered is None:
                            await ws_send(
                                {
                                    "type": MsgType.STATUS,
                                    "text": "没有检测到语音",
                                    "botId": target_bot_id,
                                }
                            )
                            continue
                        audio_bytes = filtered

                    # STT (quick, do inline)
                    await ws_send({"type": MsgType.STATUS, "text": "识别中...", "botId": target_bot_id})
                    try:
                        transcript_text = await get_stt_provider().transcribe(
                            audio_bytes,
                            language=stt_language,
                            model=stt_model,
                        )
                    except Exception as stt_err:
                        logger.bind(component="voice.stt", bot_id=target_bot_id).error("STT failed: {}", stt_err)
                        await ws_send(
                            {
                                "type": MsgType.STATUS,
                                "text": "语音识别失败",
                                "detail": str(stt_err),
                                "botId": target_bot_id,
                            }
                        )
                        continue

                    # Trim end word if wake word mode
                    end_word_raw = data.get("trimEndWord")
                    if end_word_raw and transcript_text:
                        ew = end_word_raw if isinstance(end_word_raw, str) else "我说好了"
                        new_text = _trim_endword(transcript_text, ew)
                        if new_text != transcript_text:
                            logger.bind(component="voice.stt", bot_id=target_bot_id).info(
                                "Trimmed end word (ew='{}'), before='{}', after='{}'",
                                ew,
                                transcript_text,
                                new_text,
                            )
                        transcript_text = new_text

                    if not transcript_text:
                        await ws_send({"type": MsgType.STATUS, "text": "没听清，再说一次？", "botId": target_bot_id})
                        continue

                    logger.bind(component="voice.stt", bot_id=target_bot_id).info("STT: {}", transcript_text)

                    # Spawn background task for this bot
                    task = asyncio.create_task(
                        _session_orchestrator.start_turn(
                            user_text=transcript_text,
                            bot_id=target_bot_id,
                            source="audio",
                            client_msg_id=msg_id,
                            ws_send=ws_send,
                            current_bot_id=current_bot_id,
                            bot_voices=bot_voices,
                            bot_tts_rates=bot_tts_rates,
                            recent_bot_replies=recent_bot_replies,
                            history_store=history_store,
                        )
                    )
                    background_tasks.add(task)
                    task.add_done_callback(_on_task_done)

                elif data.get("type") == MsgType.NEW_SESSION:
                    requested = data.get("slotId") or data.get("botId")
                    if requested:
                        resolved = resolve_slot_id(str(requested))
                        if not resolved:
                            await ws_send(
                                {
                                    "type": MsgType.SESSION_RESET_FAILED,
                                    "botId": current_bot_id,
                                    "error": "unknown slot",
                                }
                            )
                            continue
                        target_bot_id = resolved
                    else:
                        target_bot_id = current_bot_id
                    try:
                        config = require_slot(target_bot_id)
                    except KeyError:
                        await ws_send(
                            {
                                "type": MsgType.SESSION_RESET_FAILED,
                                "botId": target_bot_id,
                                "error": "unknown slot",
                            }
                        )
                        continue
                    logger.bind(component="ws.handler", bot_id=target_bot_id).info("New session requested")
                    lock = _bot_send_locks.setdefault(target_bot_id, asyncio.Lock())
                    if lock.locked():
                        await ws_send(
                            {
                                "type": MsgType.STATUS,
                                "text": f"{config['name']}前面还有一条在处理，重置请求已排队...",
                                "botId": target_bot_id,
                            }
                        )
                    async with lock:
                        # Insert boundary marker before clearing
                        if history_store:
                            try:
                                _bnd_seq, _bnd_ek = history_store.insert_boundary(
                                    bot_id=target_bot_id,
                                    text="会话已重置",
                                    subtype="reset",
                                    session_key=config.get("sessionKey", ""),
                                )
                                await ws_send(
                                    {
                                        "type": MsgType.MESSAGE_SYNC,
                                        "botId": target_bot_id,
                                        "eventKey": _bnd_ek,
                                        "role": "system",
                                        "text": "会话已重置",
                                        "serverSeq": _bnd_seq,
                                    }
                                )
                            except Exception as exc:
                                logger.warning(f"boundary insert failed: {exc}")

                        # Prefer last known remote timestamp as cutoff baseline to avoid
                        # cross-process clock skew issues.
                        reset_cutoff_ts_ms = int(time.time() * 1000)
                        try:
                            prev_msgs, _prev_meta = history_store.list_history(target_bot_id, limit=1)
                            if prev_msgs:
                                prev_ts = _msg_timestamp_ms(prev_msgs[-1])
                                if prev_ts:
                                    reset_cutoff_ts_ms = int(prev_ts) + 1
                        except Exception:
                            # Best-effort only; fallback to wall-clock cutoff.
                            pass
                        adapter = _session_orchestrator.adapter
                        reset_ok = await adapter.reset_session(
                            session_key=config["sessionKey"],
                        )
                        logger.bind(component="ws.handler", bot_id=target_bot_id).info(
                            "New session result: ok={}",
                            reset_ok,
                        )
                        if not reset_ok:
                            err = "new session failed"
                            await ws_send(
                                {
                                    "type": MsgType.SESSION_RESET_FAILED,
                                    "botId": target_bot_id,
                                    "error": err,
                                }
                            )
                            await ws_send(
                                {
                                    "type": MsgType.STATUS,
                                    "text": f"会话重置失败: {err}",
                                    "botId": target_bot_id,
                                }
                            )
                            continue

                        # For adapters without remote history,
                        # skip the sync-wait loop and confirm immediately.
                        adapter_caps = adapter.report_capabilities()
                        if not adapter_caps.supports_remote_history:
                            logger.bind(component="ws.handler", bot_id=target_bot_id).info(
                                "reset confirmed (local adapter, no sync needed)",
                            )
                            await ws_send(
                                {
                                    "type": MsgType.SESSION_RESET_CONFIRMED,
                                    "botId": target_bot_id,
                                    "revision": 0,
                                    "remoteCount": 0,
                                }
                            )
                            await ws_send(
                                {
                                    "type": MsgType.STATUS,
                                    "text": "会话已重置",
                                    "botId": target_bot_id,
                                }
                            )
                            continue

                        # Apply a per-bot cutoff immediately so old shared-session
                        # reset propagation can be observed reliably.
                        from backend.history.sync import set_bot_reset_cutoff_ts_ms

                        set_bot_reset_cutoff_ts_ms(target_bot_id, reset_cutoff_ts_ms)

                        sync_meta = None
                        reset_ready = False
                        last_reset_probe = ""
                        for attempt in range(1, 9):
                            sync_meta = await sync_bot_history(target_bot_id, wait_if_locked=True)
                            if sync_meta:
                                boundary_seen = bool(sync_meta.get("resetBoundarySeen"))
                                cutoff_matched = bool(sync_meta.get("resetCutoffMatched"))
                                raw_remote = int(sync_meta.get("rawRemoteCount", 0))
                                window_remote = int(sync_meta.get("windowRemoteCount", 0))
                                remote_empty = raw_remote == 0
                                window_empty = window_remote == 0
                                reset_ready = cutoff_matched or remote_empty or (window_empty and attempt >= 2)
                                last_reset_probe = (
                                    f"attempt={attempt} boundary={boundary_seen} "
                                    f"cutoffMatched={cutoff_matched} rawRemote={raw_remote} "
                                    f"windowRemote={window_remote} "
                                    f"canonical={int(sync_meta.get('count', 0))}"
                                )
                                if reset_ready:
                                    break
                            if attempt < 8:
                                await asyncio.sleep(0.3)

                        if not sync_meta:
                            await ws_send(
                                {
                                    "type": MsgType.SESSION_RESET_FAILED,
                                    "botId": target_bot_id,
                                    "error": "history sync failed after reset",
                                }
                            )
                            await ws_send(
                                {
                                    "type": MsgType.STATUS,
                                    "text": "会话重置后同步失败，请重试",
                                    "botId": target_bot_id,
                                }
                            )
                            continue
                        if not reset_ready:
                            logger.bind(component="ws.handler", bot_id=target_bot_id).warning(
                                "reset boundary not observed after /new; probe={}",
                                last_reset_probe or "none",
                            )
                            await ws_send(
                                {
                                    "type": MsgType.SESSION_RESET_FAILED,
                                    "botId": target_bot_id,
                                    "error": "reset boundary not observed after /new",
                                }
                            )
                            await ws_send(
                                {
                                    "type": MsgType.STATUS,
                                    "text": "会话重置确认超时，请重试",
                                    "botId": target_bot_id,
                                }
                            )
                            continue
                        logger.bind(component="ws.handler", bot_id=target_bot_id).info(
                            "reset confirmed with cutoff={} {}",
                            reset_cutoff_ts_ms,
                            last_reset_probe,
                        )
                        await ws_send(
                            {
                                "type": MsgType.SESSION_RESET_CONFIRMED,
                                "botId": target_bot_id,
                                "revision": int(sync_meta.get("revision", 0)),
                                "remoteCount": int(sync_meta.get("count", 0)),
                            }
                        )
                        await emit_history_revision(target_bot_id, sync_meta)
                        if sync_meta and sync_meta.get("changed"):
                            await broadcast_history_revision(target_bot_id, sync_meta)
                        await ws_send(
                            {
                                "type": MsgType.STATUS,
                                "text": "会话已重置（历史已保留）",
                                "botId": target_bot_id,
                            }
                        )

                elif data.get("type") == MsgType.COMPACT_SESSION:
                    target_bot_id = current_bot_id
                    requested = data.get("slotId") or data.get("botId")
                    if requested:
                        resolved = resolve_slot_id(str(requested))
                        if resolved:
                            target_bot_id = resolved
                    try:
                        config = require_slot(target_bot_id)
                    except KeyError:
                        await ws_send(
                            {
                                "type": MsgType.COMPACT_FAILED,
                                "botId": target_bot_id,
                                "error": "unknown slot",
                            }
                        )
                        continue
                    logger.bind(component="ws.handler", bot_id=target_bot_id).info("Compact session requested")
                    adapter = _session_orchestrator.adapter
                    compact_ok = await adapter.compact_session(
                        session_key=config["sessionKey"],
                    )
                    if compact_ok:
                        await ws_send(
                            {
                                "type": MsgType.COMPACT_CONFIRMED,
                                "botId": target_bot_id,
                            }
                        )
                        # Insert boundary marker after successful compaction
                        if history_store:
                            try:
                                _bnd_seq, _bnd_ek = history_store.insert_boundary(
                                    bot_id=target_bot_id,
                                    text="上下文已压缩",
                                    subtype="compact",
                                    session_key=config.get("sessionKey", ""),
                                )
                                await ws_send(
                                    {
                                        "type": MsgType.MESSAGE_SYNC,
                                        "botId": target_bot_id,
                                        "eventKey": _bnd_ek,
                                        "role": "system",
                                        "text": "上下文已压缩",
                                        "serverSeq": _bnd_seq,
                                    }
                                )
                            except Exception as exc:
                                logger.warning(f"boundary insert failed: {exc}")
                    else:
                        await ws_send(
                            {
                                "type": MsgType.COMPACT_FAILED,
                                "botId": target_bot_id,
                                "error": "compact failed — session not ready",
                            }
                        )

                elif data.get("type") == MsgType.TEXT:
                    requested = data.get("slotId") or data.get("botId")
                    if requested:
                        resolved = resolve_slot_id(str(requested))
                        if not resolved:
                            await ws_send(
                                {
                                    "type": MsgType.STATUS,
                                    "text": "未知 slot，文本请求已忽略",
                                    "botId": current_bot_id,
                                }
                            )
                            continue
                        target_bot_id = resolved
                    else:
                        target_bot_id = current_bot_id
                    text = data.get("text", "").strip()
                    if not text:
                        continue
                    msg_id = data.get("msgId", "")
                    if await _mark_or_reject_duplicate("text", target_bot_id, str(msg_id or "")):
                        logger.bind(component="ws.handler", bot_id=target_bot_id).warning(
                            "Duplicate text ignored (msgId={}, text={})",
                            msg_id,
                            _preview_text(text, 100),
                        )
                        await ws_send({"type": MsgType.ACK, "msgId": msg_id, "botId": target_bot_id})
                        continue
                    logger.bind(component="ws.handler", bot_id=target_bot_id).info(
                        "Received text: {}",
                        _preview_text(text, 180),
                    )
                    await ws_send({"type": MsgType.ACK, "msgId": msg_id, "botId": target_bot_id})

                    task = asyncio.create_task(
                        _session_orchestrator.start_turn(
                            user_text=text,
                            bot_id=target_bot_id,
                            source="text",
                            client_msg_id=msg_id,
                            ws_send=ws_send,
                            current_bot_id=current_bot_id,
                            bot_voices=bot_voices,
                            bot_tts_rates=bot_tts_rates,
                            recent_bot_replies=recent_bot_replies,
                            history_store=history_store,
                        )
                    )
                    background_tasks.add(task)
                    task.add_done_callback(_on_task_done)

                elif data.get("type") == MsgType.QUERY_STATUS:
                    # Client requests current processing states (e.g. after visibility change)
                    states = get_bot_processing_states()
                    for bid, st in states.items():
                        if float(st.get("elapsedSec", 0.0)) > MAX_PUSH_PROCESSING_AGE_SEC:
                            continue
                        await ws_send({"type": MsgType.STATUS, "text": st["status"], "botId": bid})

                elif data.get("type") == MsgType.QUERY_ACTIVE_TURNS:
                    turns = await _session_orchestrator.get_active_turns_summary()
                    await ws_send(
                        {
                            "type": MsgType.ACTIVE_TURNS,
                            "turns": turns,
                        }
                    )

                elif data.get("type") == MsgType.CANCEL_TURN:
                    requested = data.get("slotId") or data.get("botId")
                    if requested:
                        resolved = resolve_slot_id(str(requested))
                        if not resolved:
                            await ws_send(
                                {
                                    "type": MsgType.STATUS,
                                    "text": "未知 slot，取消失败",
                                    "botId": current_bot_id,
                                }
                            )
                            continue
                        target_bot_id = resolved
                    else:
                        target_bot_id = current_bot_id
                    turn_id = str(data.get("turnId", "") or "")
                    reason = str(data.get("reason", "user") or "user")
                    cancel_meta: dict = {}
                    try:
                        cancel_meta = await _session_orchestrator.request_cancel(
                            bot_id=target_bot_id,
                            turn_id=turn_id,
                            reason=reason,
                            ws_send=ws_send,
                        )
                    except Exception as cancel_exc:
                        logger.bind(component="ws.handler", conn_id=conn_id).error(
                            "cancel_turn failed: {}",
                            cancel_exc,
                        )
                        cancel_meta = {
                            "ok": False,
                            "active": False,
                            "supportsCancel": False,
                            "adapterResult": False,
                            "mode": "error",
                            "reason": str(cancel_exc),
                        }
                    await ws_send(
                        {
                            "type": MsgType.CANCEL_ACK,
                            "botId": target_bot_id,
                            "turnId": cancel_meta.get("turnId", turn_id),
                            "ok": bool(cancel_meta.get("ok", False)),
                            "active": bool(cancel_meta.get("active", False)),
                            "supportsCancel": bool(cancel_meta.get("supportsCancel", False)),
                            "adapterResult": bool(cancel_meta.get("adapterResult", False)),
                            "mode": str(cancel_meta.get("mode", "tts_only_stop")),
                            "latencyMs": int(cancel_meta.get("latencyMs", 0)),
                            "reason": str(cancel_meta.get("reason", "")),
                        }
                    )
                    # Insert boundary when generation was actually cancelled
                    if history_store and cancel_meta.get("mode") == "generation_cancelled":
                        try:
                            _cancel_sk = require_slot(target_bot_id).get("sessionKey", "")
                            _bnd_seq, _bnd_ek = history_store.insert_boundary(
                                bot_id=target_bot_id,
                                text="用户已取消生成",
                                subtype="cancel",
                                session_key=_cancel_sk,
                            )
                            await ws_send(
                                {
                                    "type": MsgType.MESSAGE_SYNC,
                                    "botId": target_bot_id,
                                    "eventKey": _bnd_ek,
                                    "role": "system",
                                    "text": "用户已取消生成",
                                    "serverSeq": _bnd_seq,
                                }
                            )
                        except Exception as exc:
                            logger.warning(f"boundary insert failed: {exc}")

                elif data.get("type") == MsgType.USER_INPUT_REPLY:
                    reply_bot_id = str(data.get("botId", ""))
                    reply_text = str(data.get("replyText", "")).strip()
                    event_key = str(data.get("eventKey", ""))
                    if reply_bot_id and reply_text:
                        try:
                            adapter = _session_orchestrator.adapter
                            # Check if this is a hook reply (eventKey starts with "hook-")
                            if event_key.startswith("hook-") and hasattr(adapter, "resolve_hook_reply"):
                                if adapter.resolve_hook_reply(event_key, reply_text):
                                    logger.bind(component="ws.handler").info(
                                        "Resolved hook reply: eventKey={}", event_key[:20]
                                    )
                                else:
                                    logger.bind(component="ws.handler").warning(
                                        "No pending hook for eventKey={}", event_key[:20]
                                    )
                            elif event_key.startswith("slash-") and hasattr(adapter, "handle_slash_command_reply"):
                                # Slash command reply (/model, /effort) → tmux keystroke sequence
                                await adapter.handle_slash_command_reply(
                                    bot_id=reply_bot_id,
                                    event_key=event_key,
                                    selection=reply_text,
                                )
                                logger.bind(component="ws.handler").info(
                                    "Slash command reply: eventKey={} selection={}", event_key[:25], reply_text
                                )
                            else:
                                config = require_slot(reply_bot_id)
                                session_key = config.get("sessionKey", "")
                                if hasattr(adapter, "send_user_input_reply"):
                                    await adapter.send_user_input_reply(
                                        bot_id=reply_bot_id,
                                        session_key=session_key,
                                        reply_text=reply_text,
                                    )
                                    logger.bind(component="ws.handler", bot_id=reply_bot_id).info(
                                        "Relayed user input reply: len={}", len(reply_text)
                                    )
                                else:
                                    logger.bind(component="ws.handler").warning(
                                        "Adapter does not support send_user_input_reply"
                                    )
                        except Exception:
                            logger.bind(component="ws.handler").exception("Failed to relay user input reply")
                    else:
                        logger.bind(component="ws.handler").warning(
                            "Invalid user_input_reply: botId={}, textLen={}",
                            reply_bot_id,
                            len(reply_text),
                        )

                elif data.get("type") == MsgType.LOG_BATCH:
                    from backend.ws.log_handler import handle_log_batch

                    await handle_log_batch(data.get("entries", []))

        except WebSocketDisconnect:
            ws_disconnected()
            ws_closed = True
            keepalive_task.cancel()
            push_forwarder_task.cancel()
            await registry.unregister(push_queue)
            # Don't cancel background tasks - let them finish
            # Responses will be in session history, client syncs on reconnect
        except Exception as e:
            logger.bind(component="ws.handler", conn_id=conn_id).error(
                "WS handler error (conn={}): {}\n{}",
                conn_id,
                e,
                traceback.format_exc(),
            )
            logger.bind(crash=True, component="crash.websocket").error(
                "WS handler crash (conn={}): {}",
                conn_id,
                e,
            )
            ws_disconnected()
            ws_closed = True
            keepalive_task.cancel()
            push_forwarder_task.cancel()
            await registry.unregister(push_queue)


# ============================================================
# Internal helpers (used by new_session handler)
# ============================================================


def _msg_timestamp_ms(msg: dict) -> int | None:
    """Extract unix-millisecond timestamp from a message dict."""
    import re

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
