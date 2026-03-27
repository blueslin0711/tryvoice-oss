// Shared app-level state (replaces global variables from app.js)

import { bus } from '../core/event-bus';
import { createLogger } from '../logging/logger';
import { BOT_IDS, STORAGE_KEY } from '../core/types';
import { getTurnTimeoutHints } from '../network/ws-dispatcher';

const log = createLogger('ui.mic-state');
import type { BotId, InputMode, WakewordEngine } from '../core/types';
import { t, setLocale } from '../i18n';
import { micState as _micStateRef } from '../state/mic-state';
import { botTurnState as _botTurnStateRef } from '../state/bot-turn-state';
import { remoteAgentState as _remoteAgentStateRef } from '../state/remote-agent-state';
import { syncDisplay } from '../state/state-projection';

// Bot names (mutable, synced from server)
let _botNames: Record<string, string> = {};
export function getBotNames(): Record<string, string> { return _botNames; }
export function setBotNames(names: Record<string, string>): void { _botNames = { ..._botNames, ...names }; }

// Bot name suffixes (e.g. tmux session short ID) — not user-editable
const _botSuffixes: Record<string, string> = {};
export function getBotSuffixes(): Record<string, string> { return _botSuffixes; }
export function setBotSuffix(botId: string, suffix: string): void { _botSuffixes[botId] = suffix; }
export function getBotDisplayName(botId: string): string {
  const name = _botNames[botId] || botId;
  const suffix = _botSuffixes[botId];
  return suffix ? `${name} (${suffix})` : name;
}

// Current active bot
let _currentBotId: string = 'main';
export function getCurrentBotId(): string { return _currentBotId; }
export function setCurrentBotId(id: string): void { _currentBotId = id; }

// Unread counts
const _unreadCount: Record<string, number> = {};
BOT_IDS.forEach(id => _unreadCount[id] = 0);
export function getUnreadCount(botId: string): number { return _unreadCount[botId] || 0; }
export function setUnreadCount(botId: string, count: number): void { _unreadCount[botId] = count; }

// Server-authoritative last-read pointer per bot.
// Populated from history_revision WS messages; persists across restarts.
// -1 = not yet received from server (first history_revision sets it).
const _lastReadSeq: Record<string, number> = {};
BOT_IDS.forEach(id => { _lastReadSeq[id] = -1; });
export function getLastReadSeq(botId: string): number { return _lastReadSeq[botId] ?? -1; }
export function setLastReadSeq(botId: string, seq: number): void { _lastReadSeq[botId] = seq; }

// Legacy botSeenCount — kept for compatibility with _finalizeStream and
// addBotMsg paths that still increment it.  Will be removed once all
// unread tracking is fully seq-based.
const _botSeenAssistantCount: Record<string, number> = {};
BOT_IDS.forEach(id => { _botSeenAssistantCount[id] = -1; });
export function getBotSeenCount(botId: string): number { return _botSeenAssistantCount[botId] ?? -1; }
export function setBotSeenCount(botId: string, count: number): void { _botSeenAssistantCount[botId] = count; }

// Per-bot status text
const _botStatus: Record<string, string> = {};
export function getBotStatus(botId: string): string { return _botStatus[botId] || ''; }
export function setBotStatus(botId: string, text: string): void { _botStatus[botId] = text; }

// Per-bot slash commands (populated from backend via WS)
const _slashCommands: Record<string, Array<{ cmd: string; desc: string; label?: string }>> = {};
export function setSlashCommands(botId: string, cmds: Array<{ cmd: string; desc: string; label?: string }>): void {
  _slashCommands[botId] = cmds;
}
export function getSlashCommands(botId: string): Array<{ cmd: string; desc: string; label?: string }> {
  return _slashCommands[botId] || [];
}

// Per-bot mic state with processing timeout
export type BotMicState = '' | 'recording' | 'processing' | 'speaking';

// Reason sub-state — constrained per micState
type IdleReason = 'default' | 'stopped_reading' | 'not_heard' | 'too_short'
  | 'cancelled' | 'reset_done' | 'reset_failed' | 'reset_timeout'
  | 'sync_failed' | 'echo_suspected' | 'no_mic' | 'mic_denied'
  | 'new_text_turn';
type RecordingReason = 'ptt' | 'wakeword';
type ProcessingReason = 'processing' | 'recognizing' | 'thinking' | 'generating';
type SpeakingReason = 'speaking';
export type StatusReason = IdleReason | RecordingReason | ProcessingReason | SpeakingReason;

// Whitelist of legal transitions (excluding reset-to-idle which is always allowed)
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  '':          ['recording', 'processing'],
  'recording': ['processing'],
  'processing': ['speaking'],
  'speaking':  [],
};

const _botMicState: Record<string, string> = {};
const _botProcessingTimers: Record<string, ReturnType<typeof setTimeout> | null> = {};
function getProcessingTimeoutMs(): number {
  const hints = getTurnTimeoutHints();
  return hints.processingTimeoutMs || 180_000;
}
const _botSpeakingTimers: Record<string, ReturnType<typeof setTimeout> | null> = {};
const SPEAKING_TIMEOUT_MS = 120_000;
// Per-bot turn cancellation flag (set by interruptBot, cleared by ws-dispatcher on turn end)
const _turnCancelled: Record<string, boolean> = {};
BOT_IDS.forEach(id => { _botMicState[id] = ''; _botProcessingTimers[id] = null; _botSpeakingTimers[id] = null; _turnCancelled[id] = false; });
export function getBotMicState(botId: string): string { return _botMicState[botId] || ''; }
export function setBotMicState(botId: string, state: BotMicState, reason?: StatusReason): void {
  const prev = _botMicState[botId] || '';
  // No-op if already in the requested state AND no reason change
  if (prev === state && reason === undefined) return;
  if (prev !== state) {
    // Reset to idle is always allowed via this path
    if (state !== '') {
      const allowed = ALLOWED_TRANSITIONS[prev];
      if (!allowed || !allowed.includes(state)) {
        log.warn('Blocked mic state transition', { bot_id: botId, from: prev, to: state });
        return;
      }
    }
  }
  log.info('setBotMicState', { botId, state, reason: reason || defaultReasonFor(state) });
  _botMicState[botId] = state;
  _botStatusReason[botId] = reason || defaultReasonFor(state);
  // Manage processing timeout
  if (_botProcessingTimers[botId]) {
    clearTimeout(_botProcessingTimers[botId]!);
    _botProcessingTimers[botId] = null;
  }
  if (state === 'processing') {
    _botProcessingTimers[botId] = setTimeout(() => {
      // Auto-reset to idle if stuck in processing beyond configured timeout
      if (_botMicState[botId] === 'processing') {
        log.info('processing timer fired', { botId });
        _botMicState[botId] = '';
        _botStatus[botId] = '';
        _botStatusReason[botId] = 'default';
        bus.emit('bot:processing-timeout', botId);
      }
    }, getProcessingTimeoutMs());
  }
  // Manage speaking timeout
  if (_botSpeakingTimers[botId]) {
    clearTimeout(_botSpeakingTimers[botId]!);
    _botSpeakingTimers[botId] = null;
  }
  if (state === 'speaking') {
    _botSpeakingTimers[botId] = setTimeout(() => {
      if (_botMicState[botId] === 'speaking') {
        log.info('speaking timer fired', { botId });
        _botMicState[botId] = '';
        _botStatus[botId] = '';
        _botStatusReason[botId] = 'default';
        bus.emit('bot:speaking-timeout', botId);
      }
    }, SPEAKING_TIMEOUT_MS);
  }
  syncStatusDisplay(botId);
}
const TRANSIENT_REASONS: Record<string, () => string> = {
  stopped_reading: () => t('status.stopped_reading'),
  not_heard: () => t('status.not_heard'),
  too_short: () => t('status.recording_too_short'),
  cancelled: () => t('status.cancelled'),
  reset_done: () => t('status.reset_done'),
  reset_failed: () => t('status.reset_failed'),
  reset_timeout: () => t('status.reset_timeout'),
  sync_failed: () => t('status.sync_failed'),
  echo_suspected: () => t('status.echo_suspected'),
  no_mic: () => t('status.no_mic_permission'),
  mic_denied: () => t('status.no_mic_permission'),
};

export function resetBotToIdle(botId: string, reason?: IdleReason): void {
  _botMicState[botId] = '';
  _botStatus[botId] = '';
  _botStatusReason[botId] = reason || 'default';
  // Clear transient reason after 2.5s to stay in sync with status-bar's revert timer
  if (reason && reason in TRANSIENT_REASONS) {
    setTimeout(() => {
      if (_botStatusReason[botId] === reason) {
        _botStatusReason[botId] = 'default';
      }
    }, 2500);
  }
  if (_botProcessingTimers[botId]) {
    clearTimeout(_botProcessingTimers[botId]!);
    _botProcessingTimers[botId] = null;
  }
  if (_botSpeakingTimers[botId]) {
    clearTimeout(_botSpeakingTimers[botId]!);
    _botSpeakingTimers[botId] = null;
  }
  syncStatusDisplay(botId);
}

// Turn cancellation
export function isTurnCancelled(botId: string): boolean { return _turnCancelled[botId] || false; }
export function clearTurnCancelled(botId: string): void { _turnCancelled[botId] = false; }

// Single entry point for all user-initiated interrupts
export function interruptBot(botId: string, reason: IdleReason = 'default'): void {
  const wasBusy = _botTurnStateRef.get(botId) !== 'idle';
  _turnCancelled[botId] = true;
  clearDeferredReads();
  // Layer 1: cancel mic if recording for this bot
  if (_micStateRef.isActive && _micStateRef.context?.botId === botId) {
    _micStateRef.cancelRecording();
  }
  // Layer 2 + 3: reset turn and agent state
  _botTurnStateRef.resetToIdle(botId, reason);
  _remoteAgentStateRef.resetToIdle(botId);
  bus.emit('interrupt:stop-audio');
  // Notify server to cancel ongoing processing
  if (wasBusy) {
    import('../network/ws-client').then(wsModule => {
      wsModule.send({ type: 'cancel_turn', botId });
    }).catch(() => {});
  }
  resetBotToIdle(botId, reason);
}

// Stop audio and reset display for a bot WITHOUT cancelling its turn.
// Used when switching bots — we want background processing to continue.
export function quietResetBot(botId: string): void {
  clearDeferredReads();
  bus.emit('interrupt:stop-audio');
  resetBotToIdle(botId);
}

// Per-bot status reason (sub-state within micState)
const _botStatusReason: Record<string, string> = {};
BOT_IDS.forEach(id => { _botStatusReason[id] = 'default'; });
export function getBotStatusReason(botId: string): string { return _botStatusReason[botId] || 'default'; }

function defaultReasonFor(state: BotMicState): StatusReason {
  switch (state) {
    case 'recording': return 'ptt';
    case 'processing': return 'processing';
    case 'speaking': return 'speaking';
    default: return 'default';
  }
}

// Map (micState, reason) to i18n key for status text
function statusTextFor(state: BotMicState, reason: StatusReason): string {
  if (state === '') {
    switch (reason) {
      case 'stopped_reading': return t('status.stopped_reading');
      case 'not_heard': return t('status.not_heard');
      case 'too_short': return t('status.recording_too_short');
      case 'cancelled': return t('status.cancelled');
      case 'reset_done': return t('status.reset_done');
      case 'reset_failed': return t('status.reset_failed');
      case 'reset_timeout': return t('status.reset_timeout');
      case 'sync_failed': return t('status.sync_failed');
      case 'echo_suspected': return t('status.echo_suspected');
      case 'no_mic': case 'mic_denied': return t('status.no_mic_permission');
      default: return defaultStatusText();
    }
  }
  if (state === 'recording') {
    return reason === 'wakeword' ? t('status.listening') : t('status.listening');
  }
  if (state === 'processing') {
    switch (reason) {
      case 'recognizing': return t('status.recognizing');
      case 'thinking': return t('status.thinking');
      case 'generating': return t('status.generating');
      default: return t('status.processing');
    }
  }
  if (state === 'speaking') return t('status.speaking');
  return defaultStatusText();
}

// Classify server status text into a processing reason
export function classifyServerStatus(rawTxt: string): ProcessingReason | null {
  const txt = rawTxt.replace(/\s+/g, '');
  if (txt.includes('思考中')) return 'thinking';
  if (txt.includes('生成语音') || txt.includes('生成回复') || txt.includes('生成中') || txt.includes('生成')) return 'generating';
  if (txt.includes('识别中')) return 'recognizing';
  if (txt.includes('处理中') || txt.includes('还在处理') || txt.includes('已排队') || txt.includes('前面还有一条在处理')) return 'processing';
  return null;
}

// Wakeword initialization overlay — overrides normal status text during init
let _initOverlay: string | null = null;
export function getInitOverlay(): string | null { return _initOverlay; }
export function setInitOverlay(text: string | null): void {
  _initOverlay = text;
  bus.emit('ui:init-overlay-change');
}

// Per-bot server status text — non-processing status from WS
const _serverStatusText: Record<string, string | null> = {};
export function getServerStatusText(botId: string): string | null { return _serverStatusText[botId] ?? null; }
export function setServerStatusText(botId: string, text: string | null): void {
  _serverStatusText[botId] = text;
  bus.emit('ui:server-status-change');
}

// Sync status display for a bot — delegates to projection layer
export function syncStatusDisplay(botId: string): void {
  syncDisplay(botId, getCurrentBotId(), defaultStatusText());
}

// Per-bot stream state
const _botStreamState: Record<string, { key: string; el: HTMLElement | null; responseDone: boolean; audioDone: boolean; finalText?: string; eventKey?: string } | null> = {};
BOT_IDS.forEach(id => _botStreamState[id] = null);
export function getBotStreamState(botId: string) { return _botStreamState[botId]; }
export function setBotStreamState(botId: string, state: typeof _botStreamState[string]): void { _botStreamState[botId] = state; }

export function ensureRuntimeBotState(botIds: string[]): void {
  for (const id of botIds) {
    if (!(id in _unreadCount)) _unreadCount[id] = 0;
    if (!(id in _botStatus)) _botStatus[id] = '';
    if (!(id in _botMicState)) _botMicState[id] = '';
    if (!(id in _botProcessingTimers)) _botProcessingTimers[id] = null;
    if (!(id in _botSpeakingTimers)) _botSpeakingTimers[id] = null;
    if (!(id in _botStatusReason)) _botStatusReason[id] = 'default';
    if (!(id in _botStreamState)) _botStreamState[id] = null;
    if (!(id in _turnCancelled)) _turnCancelled[id] = false;
    if (!(id in _botSeenAssistantCount)) _botSeenAssistantCount[id] = -1;
    if (!(id in _botNames)) _botNames[id] = id;
  }
  const first = botIds[0] || '';
  if (first && !botIds.includes(_currentBotId)) {
    _currentBotId = first;
  }
}

// Input mode — always start with PTT on page load; user can switch to wakeword manually
let _inputMode: InputMode = 'ptt';
export function getInputMode(): InputMode { return _inputMode; }
export function setInputMode(mode: InputMode): void { _inputMode = mode; bus.emit('ui:input-mode', mode); }

// Auto-read
let _autoReadEnabled = (() => {
  try { return localStorage.getItem(STORAGE_KEY + 'autoRead') !== '0'; } catch (_e) { return true; }
})();
export function isAutoReadEnabled(): boolean { return _autoReadEnabled; }
export function setAutoReadEnabled(v: boolean): void { _autoReadEnabled = v; }

// Text reply
let _textReplyEnabled = (() => {
  try { const v = localStorage.getItem(STORAGE_KEY + 'textReplyEnabled'); return v === null ? true : v === '1'; } catch (_e) { return true; }
})();
export function isTextReplyEnabled(): boolean { return _textReplyEnabled; }
export function setTextReplyEnabled(v: boolean): void { _textReplyEnabled = v; }

// Recording state
let _isRecording = false;
let _wakeWordRecording = false;
export function isRecordingActive(): boolean { return _isRecording || _wakeWordRecording; }
export function setIsRecording(v: boolean): void { _isRecording = v; }
export function isWakeWordRecording(): boolean { return _wakeWordRecording; }
export function setWakeWordRecording(v: boolean): void { _wakeWordRecording = v; }

// Voice selections
const _botVoiceSelections: Record<string, string> = (() => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY + 'voices') || '{}'); } catch (_e) { return {}; }
})();
export function getBotVoiceSelections(): Record<string, string> { return _botVoiceSelections; }
export function setBotVoiceSelection(botId: string, voiceId: string): void { _botVoiceSelections[botId] = voiceId; }

// TTS rates
const _botTtsRates: Record<string, string> = (() => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY + 'ttsRates') || '{}'); } catch (_e) { return {}; }
})();
export function getBotTtsRates(): Record<string, string> { return _botTtsRates; }
export function setBotTtsRate(botId: string, rate: string): void { _botTtsRates[botId] = rate; }

// Avatars
const _botAvatars: Record<string, string> = (() => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY + 'avatars') || '{}'); } catch (_e) { return {}; }
})();
export function getBotAvatars(): Record<string, string> { return _botAvatars; }
export function setBotAvatar(botId: string, url: string): void { _botAvatars[botId] = url; }

// Wakeword engine
const _VALID_WW_ENGINES: WakewordEngine[] = ['picovoice', 'openwakeword', 'sherpa-onnx-kws'];
let _wwEngine: WakewordEngine = (() => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY + 'wwEngine') || 'openwakeword';
    return _VALID_WW_ENGINES.includes(stored as WakewordEngine)
      ? (stored as WakewordEngine)
      : 'openwakeword';
  } catch (_e) { return 'openwakeword'; }
})();
export function getWwEngine(): WakewordEngine { return _wwEngine; }
export function setWwEngine(engine: WakewordEngine): void { _wwEngine = engine; }

// Unified granularity — controls which messages are displayed and counted as unread.
// TTS only reads text replies (result contentKind), never tool_call messages.
//
// UI currently exposes two levels: "仅文字" (final_only) and "含 Tool Call" (all).
// Code retains all four levels for future use when intermediate/thinking
// classification becomes reliable (stop_reason=None is ambiguous — see
// JSONL analysis in commit f6d2899).
//
// Levels (ascending verbosity):
//   final_only   — only final answers (non-intermediate, non-[tool:] messages)
//   with_steps   — + intermediate text steps (contentKind: 'intermediate')  [NOT YET EFFECTIVE]
//   with_thinking — + model reasoning/chain-of-thought (contentKind: 'thinking')  [NOT YET EFFECTIVE]
//   all          — + tool call details ([tool:...] and contentKind: 'tool_call')
export type Granularity = 'final_only' | 'with_steps' | 'with_thinking' | 'all';
const VALID_GRANULARITY: Granularity[] = ['final_only', 'with_steps', 'with_thinking', 'all'];

function _migrateGranularity(): Granularity {
  try {
    const v = localStorage.getItem(STORAGE_KEY + 'granularity');
    if (v && VALID_GRANULARITY.includes(v as Granularity)) return v as Granularity;
    // Migrate from old keys
    const oldDisplay = localStorage.getItem(STORAGE_KEY + 'displayGranularity');
    if (oldDisplay === 'final_only') return 'final_only';
    if (oldDisplay === 'no_thinking') return 'with_steps';
    if (oldDisplay === 'all') return 'all';
    return 'final_only';
  } catch (_e) { return 'final_only'; }
}
let _granularity: Granularity = _migrateGranularity();
export function getGranularity(): Granularity { return _granularity; }
export function setGranularity(v: Granularity): void { _granularity = v; }

// Shared message filter — used by display, unread counting, and TTS.
export function shouldIncludeMsg(
  m: { intermediate?: boolean; contentKind?: string; text?: string; role?: string },
  granularity?: Granularity,
): boolean {
  // Boundary markers (role="system") are structural — always shown
  if ((m as { role?: string }).role === 'system') return true;
  const g = granularity ?? _granularity;
  if (!m.intermediate) {
    // Non-intermediate tool-call placeholders (lost flag after mergeFromServer)
    if (m.text?.startsWith('[tool:')) return g === 'all';
    // Skip empty assistant messages (tool_use-only JSONL entries that were
    // persisted to canonical_store without text — they show as blank bubbles)
    if (m.role === 'assistant' && !m.text?.trim()) return false;
    return true;
  }
  // Intermediate messages filtered by granularity
  switch (g) {
    case 'final_only': return false;
    case 'with_steps': return m.contentKind === 'intermediate';
    case 'with_thinking': return m.contentKind === 'intermediate' || m.contentKind === 'thinking';
    case 'all': return true;
    default: return false;
  }
}

// Backward-compat aliases (deprecated — use getGranularity / shouldIncludeMsg)
export type DisplayGranularity = 'all' | 'no_thinking' | 'final_only';
export type TtsGranularity = 'all' | 'final_only' | 'none';
export function getDisplayGranularity(): DisplayGranularity {
  const g = _granularity;
  if (g === 'all') return 'all';
  if (g === 'with_steps' || g === 'with_thinking') return 'no_thinking';
  return 'final_only';
}
export function setDisplayGranularity(v: DisplayGranularity): void {
  if (v === 'all') _granularity = 'all';
  else if (v === 'no_thinking') _granularity = 'with_steps';
  else _granularity = 'final_only';
}
export function getTtsGranularity(): TtsGranularity {
  // Unified model: granularity controls what is read. 'none' is no longer a granularity
  // value — auto-read on/off is handled by isAutoReadEnabled().
  const g = _granularity;
  if (g === 'all') return 'all';
  return 'final_only';
}
export function setTtsGranularity(_v: TtsGranularity): void {
  // No-op: TTS granularity is now unified with display granularity.
  // Old callers may still invoke this during settings restore — safe to ignore.
}

// Track text already read via WS path (intermediate_step, SPEAK) to
// prevent the sync-path grace-window TTS from double-reading the same
// content when canonical messages arrive after the turn completes.
const _readTextKeys: Record<string, Set<string>> = {};
function _textKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}
export function markTextRead(botId: string, text: string): void {
  if (!text) return;
  if (!_readTextKeys[botId]) _readTextKeys[botId] = new Set();
  _readTextKeys[botId].add(_textKey(text));
}
export function isTextAlreadyRead(botId: string, text: string): boolean {
  if (!text) return false;
  return !!_readTextKeys[botId]?.has(_textKey(text));
}
export function clearReadTexts(botId: string): void {
  delete _readTextKeys[botId];
}

// Car mode
let _carMode = false;
export function isCarMode(): boolean { return _carMode; }
export function setCarMode(v: boolean): void { _carMode = v; }

// Default voice
let _defaultVoice = '';
export function getDefaultVoice(): string { return _defaultVoice; }
export function setDefaultVoice(v: string): void { _defaultVoice = v; }

// Voices list
let _voicesList: Array<{ id: string; name: string; locale: string; gender: string }> = [];
export function getVoicesList(): typeof _voicesList { return _voicesList; }
export function setVoicesList(v: typeof _voicesList): void { _voicesList = v; }

// Announce voice (for system notifications)
const ANNOUNCE_VOICE_DEFAULT = 'zh-CN-XiaoxiaoNeural';
let _announceVoice = (() => {
  try { return localStorage.getItem(STORAGE_KEY + 'announceVoice') || ANNOUNCE_VOICE_DEFAULT; } catch (_e) { return ANNOUNCE_VOICE_DEFAULT; }
})();
export function getAnnounceVoice(): string { return _announceVoice; }
export function setAnnounceVoice(v: string): void { _announceVoice = v; }

// Announce rate (for system notifications)
const ANNOUNCE_RATE_DEFAULT = '1.0';
let _announceRate = (() => {
  try { return localStorage.getItem(STORAGE_KEY + 'announceRate') || ANNOUNCE_RATE_DEFAULT; } catch (_e) { return ANNOUNCE_RATE_DEFAULT; }
})();
export function getAnnounceRate(): string { return _announceRate; }
export function setAnnounceRate(v: string): void { _announceRate = v; }

// Toast — delegated to enhanced toast module
export { showToast } from './toast';

// Default status text
export function defaultStatusText(): string {
  if (_inputMode === 'wakeword') return t('status.waiting_wakeword');
  return t('status.click_to_talk');
}

// Deferred reads
let _deferredReads: Array<{ el: HTMLElement; audioB64: string; text: string }> = [];
export function autoReadEnqueue(el: HTMLElement | null, audioB64: string, text: string): void {
  if (!_autoReadEnabled) return;
  if (!el) return;
  if (_micStateRef.isActive) {
    _deferredReads.push({ el, audioB64: audioB64 || '', text: text || '' });
    return;
  }
  // Import dynamically to avoid circular dependency
  import('../audio/audio-player').then(({ audioPlayer }) => {
    audioPlayer.enqueue(el, audioB64, text);
  });
}
// Clear stale deferred reads (e.g. on barge-in, matching original _deferredReads = [])
export function clearDeferredReads(): void { _deferredReads = []; }

export function flushDeferredReads(): void {
  if (!_autoReadEnabled || _deferredReads.length === 0) { _deferredReads = []; return; }
  const items = _deferredReads;
  _deferredReads = [];
  import('../audio/audio-player').then(({ audioPlayer }) => {
    for (const item of items) {
      if (item.el && item.el.isConnected) {
        audioPlayer.enqueue(item.el, item.audioB64, item.text);
      }
    }
  });
}

// --- Three-layer state re-exports (Phase 1: coexist with legacy API) ---
export { micState } from '../state/mic-state';
export type { MicStateValue, MicMode, MicContext } from '../state/mic-state';
export { botTurnState } from '../state/bot-turn-state';
export type { BotTurnStateValue } from '../state/bot-turn-state';
export { remoteAgentState, classifyToAgentState } from '../state/remote-agent-state';
export type { RemoteAgentStateValue } from '../state/remote-agent-state';
export { projectCssClass, projectStatusText, syncDisplay, wireAutoSync, setNetworkOverlay as setProjectionNetworkOverlay, getNetworkOverlay as getProjectionNetworkOverlay } from '../state/state-projection';
export type { CssClass } from '../state/state-projection';

// Height scale (recording mode) — device-local only, not synced to backend
export function getHeightScale(): number {
  try {
    const v = localStorage.getItem(STORAGE_KEY + 'heightScale');
    if (v) { const n = parseFloat(v); if (n > 0 && n <= 1) return n; }
  } catch (_e) { /* ignore */ }
  return 1;
}

export function applyHeightScale(scale: number): void {
  const vv = Math.round(window.visualViewport?.height || 0);
  const vvTop = Math.round(window.visualViewport?.offsetTop || 0);
  const ih = Math.round(window.innerHeight || 0);
  const ch = Math.round(document.documentElement?.clientHeight || 0);
  const rawH = Math.max(vv + vvTop, vv, ih, ch);
  if (rawH > 0) {
    const h = scale < 1 ? Math.round(rawH * scale) : rawH;
    document.documentElement.style.setProperty('--app-vh', `${h}px`);
    document.body.classList.toggle('recording-mode', scale < 1);
  }
}

// Settings sync helpers
export async function loadSharedSettings(): Promise<Record<string, unknown>> {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return {};
    return await res.json();
  } catch (_e) { return {}; }
}

export async function saveSharedSettings(patch: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch (e) { log.warn('Failed to save shared settings', { detail: String(e) }); }
}

export function syncSetting(key: string, value: unknown): void {
  try { localStorage.setItem(STORAGE_KEY + key, typeof value === 'object' ? JSON.stringify(value) : String(value)); } catch (_e) { /* ignore */ }
  saveSharedSettings({ [key]: value });
}

/**
 * Apply all settings from a shared-settings payload (GET /api/settings response)
 * to both localStorage and in-memory state.
 * Does NOT trigger UI updates — caller is responsible for refreshAvatars(),
 * updateAutoReadToggle(), etc. after calling this.
 *
 * NOTE: STORAGE_KEY + 'locale' === 'tryvoice_locale', which is the same key
 * used by i18n/index.ts. Both must stay in sync if STORAGE_KEY ever changes.
 */
export function applySharedSettings(shared: Record<string, unknown>): void {
  const ls = (key: string, value: unknown): void => {
    try {
      localStorage.setItem(
        STORAGE_KEY + key,
        typeof value === 'object' ? JSON.stringify(value) : String(value),
      );
    } catch (_e) { /* quota exceeded or private mode */ }
  };

  // --- Per-bot maps ---
  if (shared.avatars && typeof shared.avatars === 'object') {
    ls('avatars', shared.avatars);
    for (const [id, url] of Object.entries(shared.avatars as Record<string, string>)) {
      if (typeof url === 'string') setBotAvatar(id, url);
    }
  }
  if (shared.voices && typeof shared.voices === 'object') {
    ls('voices', shared.voices);
    for (const [id, voiceId] of Object.entries(shared.voices as Record<string, string>)) {
      if (typeof voiceId === 'string') setBotVoiceSelection(id, voiceId);
    }
  }
  if (shared.ttsRates && typeof shared.ttsRates === 'object') {
    ls('ttsRates', shared.ttsRates);
    for (const [id, rate] of Object.entries(shared.ttsRates as Record<string, string>)) {
      if (typeof rate === 'string') setBotTtsRate(id, rate);
    }
  }

  // --- Scalar state with in-memory setters ---
  if (shared.inputMode === 'ptt' || shared.inputMode === 'wakeword') {
    ls('inputMode', shared.inputMode);
    setInputMode(shared.inputMode as InputMode);
  }
  if (shared.autoRead !== undefined) {
    const v = shared.autoRead !== '0' && shared.autoRead !== false && shared.autoRead !== 0;
    ls('autoRead', v ? '1' : '0');
    setAutoReadEnabled(v);
  }
  if (shared.textReplyEnabled !== undefined) {
    const v = shared.textReplyEnabled === '1' || shared.textReplyEnabled === true || shared.textReplyEnabled === 1;
    ls('textReplyEnabled', v ? '1' : '0');
    setTextReplyEnabled(v);
  }
  if (typeof shared.announceVoice === 'string') {
    ls('announceVoice', shared.announceVoice);
    setAnnounceVoice(shared.announceVoice);
  }
  // announceRate: NOT in SYNC_KEYS, so syncSetting() never writes it to the backend.
  // The block below can never execute in practice (shared.announceRate will always be
  // undefined). Included for forward-compatibility if announceRate is added to SYNC_KEYS.
  if (typeof shared.announceRate === 'string') {
    ls('announceRate', shared.announceRate);
  }
  // Unified granularity (new key)
  if (shared.granularity && VALID_GRANULARITY.includes(shared.granularity as Granularity)) {
    ls('granularity', shared.granularity);
    setGranularity(shared.granularity as Granularity);
  } else if (shared.displayGranularity === 'all' || shared.displayGranularity === 'no_thinking' || shared.displayGranularity === 'final_only') {
    // Backward compat: migrate from old displayGranularity
    setDisplayGranularity(shared.displayGranularity as DisplayGranularity);
    ls('granularity', _granularity);
  }
  // Session mode (controller/observer)
  if (shared.sessionMode === 'observer' || shared.sessionMode === 'controller') {
    ls('sessionMode', shared.sessionMode);
    // Update toggle if DOM is ready
    const toggle = document.getElementById('tmux-mirror-toggle') as HTMLInputElement | null;
    if (toggle) toggle.checked = shared.sessionMode === 'observer';
  }
  const VALID_WW: WakewordEngine[] = ['picovoice', 'openwakeword', 'sherpa-onnx-kws'];
  if (typeof shared.wwEngine === 'string' && VALID_WW.includes(shared.wwEngine as WakewordEngine)) {
    ls('wwEngine', shared.wwEngine);
    setWwEngine(shared.wwEngine as WakewordEngine);
  }

  // --- LS-only (read by initSettings / settings-panel when opened) ---
  for (const key of [
    'volume', 'fontSize', 'theme', 'sttLang', 'sttModel', 'wakeLock',
    'endWord', 'cancelWord', 'wwAllowBargeIn', 'wwMicAec', 'wwMapping',
    'pvSensitivity', 'pvEndword', 'pvCancelword',
  ] as const) {
    if (shared[key] !== undefined) ls(key, shared[key]);
  }

  // --- Extra keys not in SYNC_KEYS ---
  // locale: setLocale() already writes to its own LS key 'tryvoice_locale'
  // (= STORAGE_KEY + 'locale'); applyI18nToDOM() is called later by initSettings()
  if (typeof shared.locale === 'string') {
    setLocale(shared.locale);
  }
  if (shared.botNames && typeof shared.botNames === 'object') {
    setBotNames(shared.botNames as Record<string, string>);
  }
  if (typeof shared.sttVocab === 'string') {
    ls('sttVocab', shared.sttVocab);
  }
  // voiceprintEmbedding: handled separately by restoreVoiceprintFromBackend()
}
