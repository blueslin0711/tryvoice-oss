"""TryVoice Wire Protocol v1 — typed message definitions.

Each class is a TypedDict describing the JSON shape sent over WebSocket.
They are **not** enforced at runtime — they serve as documentation and
type-checking aid for both backend and any future codegen for clients.
"""

from __future__ import annotations

from typing import List

from typing_extensions import NotRequired, TypedDict

# ═══════════════════════════════════════════════════════════════════
# Client → Server
# ═══════════════════════════════════════════════════════════════════


class TextInput(TypedDict):
    type: str  # "text"
    text: str
    botId: str
    msgId: str


class AudioInput(TypedDict):
    type: str  # "audio"
    data: str  # base64-encoded audio bytes
    botId: str
    msgId: str
    trimEndWord: NotRequired[str]


class SwitchSlot(TypedDict):
    type: str  # "switch_bot" | "switch_slot"
    botId: NotRequired[str]
    slotId: NotRequired[str]


class SetVoice(TypedDict):
    type: str  # "set_voice"
    botId: str
    voiceId: str


class SetTTSRate(TypedDict):
    type: str  # "set_tts_rate"
    botId: str
    rate: str


class NewSession(TypedDict):
    type: str  # "new_session"
    botId: str


class SetSTTLanguage(TypedDict):
    type: str  # "set_stt_language"
    language: str


class SetSTTModel(TypedDict):
    type: str  # "set_stt_model"
    model: str


class QueryStatus(TypedDict):
    type: str  # "query_status"


class CancelTurn(TypedDict):
    type: str  # "cancel_turn"
    botId: str
    turnId: NotRequired[str]
    reason: NotRequired[str]


# ═══════════════════════════════════════════════════════════════════
# Server → Client
# ═══════════════════════════════════════════════════════════════════


class Ack(TypedDict):
    type: str  # "ack"
    msgId: str
    botId: str


class AdapterStatus(TypedDict):
    type: str  # "adapter_status"
    adapterId: str
    supportsStream: bool
    supportsCancel: bool
    supportsSessionResume: bool
    supportsToolEvents: bool
    degradeHints: List[str]


class Status(TypedDict):
    type: str  # "status"
    text: str
    botId: str


class SlotSwitched(TypedDict):
    type: str  # "bot_switched"
    botId: str
    slotId: str
    name: str


class VoiceSet(TypedDict):
    type: str  # "voice_set"
    botId: str
    voiceId: str


class STTLanguageSet(TypedDict):
    type: str  # "stt_language_set"
    language: str


class STTModelSet(TypedDict):
    type: str  # "stt_model_set"
    model: str


class Transcript(TypedDict):
    type: str  # "transcript"
    text: str
    botId: str
    source: str  # "audio" | "text"
    eventKey: str
    clientMsgId: NotRequired[str]


class IntermediateStep(TypedDict):
    type: str  # "intermediate_step"
    text: str
    botId: str
    eventKey: str
    contentKind: NotRequired[str]  # "result" | "thinking" | "tool_call" | "intermediate"


class ResponseChunk(TypedDict):
    type: str  # "response_chunk"
    text: str
    botId: str
    contentKind: NotRequired[str]  # "result" | "thinking" | "tool_call" | "intermediate"


class ResponseComplete(TypedDict):
    type: str  # "response_complete"
    text: str
    botId: str
    eventKey: str
    clientMsgId: NotRequired[str]


class Response(TypedDict):
    type: str  # "response"
    text: str
    botId: str
    ts: NotRequired[str]
    eventKey: NotRequired[str]
    status: NotRequired[str]
    persisted: NotRequired[bool]
    timeout: NotRequired[bool]


class AudioChunk(TypedDict):
    type: str  # "audio_chunk"
    data: str  # base64-encoded audio
    botId: str


class AudioComplete(TypedDict):
    type: str  # "audio_complete"
    botId: str


class Speak(TypedDict):
    type: str  # "speak"
    text: str
    botId: str


class HistoryRevision(TypedDict):
    type: str  # "history_revision"
    botId: str
    revision: int
    remoteCount: int
    maxServerSeq: int
    changed: bool


class SessionResetConfirmed(TypedDict):
    type: str  # "session_reset_confirmed"
    botId: str
    revision: int
    remoteCount: int


class SessionResetFailed(TypedDict):
    type: str  # "session_reset_failed"
    botId: str
    error: str


class TurnState(TypedDict):
    type: str  # "turn_state"
    botId: str
    state: str
    turnId: str
    attempts: int
    lastError: str


class TurnCancelled(TypedDict):
    type: str  # "turn_cancelled"
    botId: str
    turnId: NotRequired[str]
    mode: str


class CancelAck(TypedDict):
    type: str  # "cancel_ack"
    botId: str
    turnId: str
    ok: bool
    active: bool
    supportsCancel: bool
    adapterResult: bool
    mode: str
    latencyMs: int
    reason: str
