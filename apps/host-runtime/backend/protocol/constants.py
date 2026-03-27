"""TryVoice Wire Protocol v1 — constants and message type enum."""

from __future__ import annotations

PROTOCOL_VERSION = "1.0"


class MsgType:
    """All wire message type strings used between Client and Host Runtime.

    Naming convention: the string value matches the existing ad-hoc keys
    so that the protocol upgrade is wire-compatible with current clients.
    """

    # ── Client → Server ──────────────────────────────────────────────
    TEXT = "text"
    AUDIO = "audio"
    SWITCH_BOT = "switch_bot"
    SET_VOICE = "set_voice"
    SET_TTS_RATE = "set_tts_rate"
    NEW_SESSION = "new_session"
    COMPACT_SESSION = "compact_session"
    SET_STT_LANGUAGE = "set_stt_language"
    SET_STT_MODEL = "set_stt_model"
    QUERY_STATUS = "query_status"
    CANCEL_TURN = "cancel_turn"
    USER_INPUT_REPLY = "user_input_reply"

    MARK_READ = "mark_read"

    # ── Client → Server (logging) ────────────────────────────────────
    LOG_BATCH = "log:batch"

    # Also accept "switch_slot" as alias for "switch_bot"
    SWITCH_SLOT = "switch_slot"

    # ── Server → Client ──────────────────────────────────────────────
    PING = "ping"
    ACK = "ack"
    ADAPTER_STATUS = "adapter_status"
    STATUS = "status"
    BOT_SWITCHED = "bot_switched"
    VOICE_SET = "voice_set"
    STT_LANGUAGE_SET = "stt_language_set"
    STT_MODEL_SET = "stt_model_set"
    TRANSCRIPT = "transcript"
    INTERMEDIATE_STEP = "intermediate_step"
    RESPONSE_CHUNK = "response_chunk"
    RESPONSE_COMPLETE = "response_complete"
    RESPONSE = "response"
    AUDIO_CHUNK = "audio_chunk"
    AUDIO_COMPLETE = "audio_complete"
    SPEAK = "speak"
    HISTORY_REVISION = "history_revision"
    MESSAGE_SYNC = "message_sync"
    SESSION_RESET_CONFIRMED = "session_reset_confirmed"
    SESSION_RESET_FAILED = "session_reset_failed"
    SESSION_RESET_DETECTED = "session_reset_detected"
    COMPACT_CONFIRMED = "compact_confirmed"
    COMPACT_FAILED = "compact_failed"
    TURN_STATE = "turn_state"
    TURN_CANCELLED = "turn_cancelled"
    CANCEL_ACK = "cancel_ack"
    AGENT_STARTED = "agent_started"
    USER_INPUT_REQUEST = "user_input_request"

    # ── Client → Server (active turn query) ───────────────────────────
    QUERY_ACTIVE_TURNS = "query_active_turns"

    # ── Server → Client (active turn response) ────────────────────────
    ACTIVE_TURNS = "active_turns"
