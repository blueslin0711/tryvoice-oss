// Shared TypeScript types for the entire frontend

// Bot/slot runtime configuration.
// BOT_IDS is populated at runtime from the server via bootstrapSlots().
export const BOT_IDS: string[] = [];

export function setRuntimeBotIds(ids: string[]): string[] {
  const normalized = Array.from(new Set((ids || []).map((v) => String(v || '').trim()).filter(Boolean)));
  BOT_IDS.splice(0, BOT_IDS.length, ...normalized);
  return [...BOT_IDS];
}

export function getRuntimeBotIds(): string[] {
  return [...BOT_IDS];
}

export type BotId = string;

// Message model
export type MessageStatus = 'pending' | 'streaming' | 'confirmed';
export type DeliveryStatus = '' | 'sending' | 'sent' | 'delivered' | 'processing' | 'agent_processing' | 'replied' | 'failed';

export type ContentKind = 'result' | 'thinking' | 'tool_call' | 'intermediate';

export interface ChatMessage {
  role: string;
  text: string;
  ttsText: string;
  ts: string;
  eventKey: string;
  intermediate: boolean;
  contentKind: ContentKind;
  status: MessageStatus;
  deliveryStatus: DeliveryStatus;
  clientMsgId: string;
  _seq: number;
  _createdAt: number;
  serverSeq: number | null;
  messageId: string | null;
  sourceChannel: string;
}

// Input modes
export type InputMode = 'ptt' | 'wakeword';

// Scroll ownership
export type ScrollOwnership = 'AUTO' | 'MANUAL';

// WebSocket client → server messages
export interface WsTextMessage {
  type: 'text';
  text: string;
  botId: string;
  msgId: string;
}

export interface WsAudioMessage {
  type: 'audio';
  data: string;
  botId: string;
  msgId: string;
  trimEndWord?: string;
}

export interface WsSwitchBotMessage {
  type: 'switch_bot';
  botId: string;
}

export interface WsSetVoiceMessage {
  type: 'set_voice';
  botId: string;
  voiceId: string;
}

export interface WsSetTtsRateMessage {
  type: 'set_tts_rate';
  botId: string;
  rate: string;
}

export interface WsNewSessionMessage {
  type: 'new_session';
  botId: string;
}

export type WsClientMessage =
  | WsTextMessage
  | WsAudioMessage
  | WsSwitchBotMessage
  | WsSetVoiceMessage
  | WsSetTtsRateMessage
  | WsNewSessionMessage;

// WebSocket server → client messages
export interface WsServerMessage {
  type: string;
  [key: string]: unknown;
}

// Outbox entry
export interface OutboxEntry {
  msgId: string;
  type: 'text' | 'audio';
  botId: string;
  text: string;
  audioB64: string;
  trimEndWord: string;
  status: 'queued' | 'sent' | 'acked' | 'failed';
  retryCount: number;
  createdAt: number;
}

// Server history response
export interface ServerHistoryMessage {
  role: string;
  text: string;
  ttsText?: string;
  ts?: string;
  eventKey?: string;
  serverSeq?: number | null;
  messageId?: string | null;
  sourceChannel?: string;
  contentKind?: string;
  intermediate?: boolean;
}

export interface HistoryResponse {
  messages?: ServerHistoryMessage[];
  notModified?: boolean;
  hasMore?: boolean;
  minServerSeq?: number | null;
  maxServerSeq?: number | null;
  sync?: {
    historyRevision?: number;
    maxServerSeq?: number;
    lastError?: string;
  };
}

// Settings sync keys
export const SYNC_KEYS = [
  'avatars', 'voices', 'ttsRates', 'volume', 'fontSize',
  'inputMode', 'textReplyEnabled', 'sttLang', 'sttModel',
  'wakeLock', 'endWord', 'cancelWord', 'wwEngine', 'wwAllowBargeIn', 'wwMicAec',
  'wwMapping', 'pvSensitivity', 'pvEndword', 'pvCancelword', 'theme', 'autoRead',
  'announceVoice',
  'granularity',
  'displayGranularity', 'ttsGranularity',
] as const;

export const STORAGE_KEY = 'tryvoice_';
export const STORAGE_KEY_LEGACY = 'openclaw_voice_chat_';

// Audio player state
export type PlayerState = 'idle' | 'playing' | 'paused';

// Wakeword engine
export type WakewordEngine = 'picovoice' | 'openwakeword' | 'sherpa-onnx-kws';
