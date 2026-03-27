// Projection Layer: derives UI state from three independent state layers
//
// Provides:
//   - projectCssClass(botId): '' | 'recording' | 'processing' | 'speaking'
//   - projectStatusText(botId): localized status string with 6-level priority
//   - syncDisplay(botId): push CSS class + status text + cancel visibility to DOM

import { bus } from '../core/event-bus';
import { createLogger } from '../logging/logger';
import { micState } from './mic-state';
import { botTurnState } from './bot-turn-state';
import { remoteAgentState } from './remote-agent-state';
import { audioPlayer } from '../audio/audio-player';
import type { BotTurnStateValue } from './bot-turn-state';
import { t } from '../i18n';
import { getInitOverlay, getServerStatusText, getBotStatusReason } from '../ui/app-state';
// compactStatusText is imported lazily via _statusBar to avoid pulling in
// status-bar.ts at module load time (it accesses `document` at top level).

const log = createLogger('state.projection');

export type CssClass = '' | 'recording' | 'processing' | 'speaking';

// --- CSS class projection ---
export function projectCssClass(botId: string): CssClass {
  // Mic actively recording for this bot
  if (micState.isActive && micState.context?.botId === botId) {
    const ms = micState.state;
    if (ms === 'acquiring' || ms === 'recording') return 'recording';
    // Only show processing from mic state if bot turn is still active
    // (prevents stale yellow animation when STT fails and BotTurnState resets to idle
    //  before micState finishes its saving→idle cleanup)
    if ((ms === 'stopping' || ms === 'saving') && botTurnState.get(botId) !== 'idle') return 'processing';
  }

  const turn = botTurnState.get(botId);
  if (turn === 'listening') return 'recording';
  if (['stt', 'sending', 'awaiting', 'receiving', 'tts'].includes(turn)) {
    // Show speaking animation when audio is actually playing, even if
    // BotTurnState is awaiting/receiving (ISSUE-01: decouple speaking
    // visual from turn state — AudioPlayer is the source of truth).
    if (audioPlayer.state !== 'idle') return 'speaking';
    return 'processing';
  }
  if (turn === 'speaking') return 'speaking';
  // Audio playing while turn is idle (e.g. reading unread messages on bot switch)
  if (audioPlayer.state !== 'idle') return 'speaking';
  return '';
}

// --- Status text projection ---

// Network overlay — supersedes all other text when set
let _networkOverlay: string | null = null;
export function setNetworkOverlay(text: string | null): void { _networkOverlay = text; }
export function getNetworkOverlay(): string | null { return _networkOverlay; }

export function defaultStatusText(inputMode?: string): string {
  if (inputMode === 'wakeword') return t('status.waiting_wakeword');
  // Defer to app-state for the actual input mode
  return '';
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

export function projectStatusText(botId: string, fallbackDefault: string): string {
  // P1: network overlay (disconnect)
  if (_networkOverlay) return _networkOverlay;

  // P2: init overlay (wakeword loading)
  const initOv = getInitOverlay();
  if (initOv) return initOv;

  // P3: active turn state (L1+L2+L3 derived)
  const turn = botTurnState.get(botId);
  const agent = remoteAgentState.get(botId);

  if (turn === 'listening') return t('status.listening');
  if (turn === 'stt') return t('status.recognizing');
  if (turn === 'sending') return t('status.processing');
  if (turn === 'awaiting' || turn === 'receiving') {
    if (agent === 'processing') return t('status.thinking');
    if (agent === 'generating') return t('status.generating');
    if (agent === 'queued') return t('status.processing');
    return t('status.processing');
  }
  if (turn === 'tts') return t('status.generating');
  if (turn === 'speaking') return t('status.speaking');
  // ISSUE-01: show speaking text when audio plays outside of a turn (e.g. unread read-aloud)
  if (turn === 'idle' && audioPlayer.state !== 'idle') return t('status.speaking');

  // P4: transient reason (not_heard, cancelled, etc.)
  const reason = getBotStatusReason(botId);
  if (reason && reason !== 'default' && reason in TRANSIENT_REASONS) {
    return TRANSIENT_REASONS[reason]();
  }

  // P5: server status text (non-processing info from WS)
  const serverTxt = getServerStatusText(botId);
  if (serverTxt) {
    return _statusBar ? _statusBar.compactStatusText(serverTxt, fallbackDefault) : serverTxt;
  }

  // P6: default
  return fallbackDefault;
}

// --- Cancel button visibility ---
function deriveCancelVisible(): boolean {
  return micState.isActive || audioPlayer.state !== 'idle';
}

// --- Sync display to DOM ---
// Uses cached dynamic imports to break circular deps with mic-ui / status-bar

let _micUi: typeof import('../ui/mic-ui') | null = null;
let _statusBar: typeof import('../ui/status-bar') | null = null;

async function _ensureImports(): Promise<void> {
  if (!_micUi) _micUi = await import('../ui/mic-ui');
  if (!_statusBar) _statusBar = await import('../ui/status-bar');
}

// Track previous syncDisplay output to log only on changes
const _prevDisplay: Record<string, { cssClass: CssClass; statusText: string; cancelVisible: boolean }> = {};

export function syncDisplay(botId: string, currentBotId: string, fallbackDefault: string): void {
  if (botId !== currentBotId) return;

  const cssClass = projectCssClass(botId);
  const statusText = projectStatusText(botId, fallbackDefault);
  const cancelVisible = deriveCancelVisible();

  const prev = _prevDisplay[botId];
  if (!prev || prev.cssClass !== cssClass || prev.statusText !== statusText || prev.cancelVisible !== cancelVisible) {
    log.info('syncDisplay changed', { botId, cssClass, statusText, cancelVisible });
    _prevDisplay[botId] = { cssClass, statusText, cancelVisible };
  }

  if (_micUi && _statusBar) {
    _micUi.setMicRecordingState(cssClass);
    _micUi.updateMicAvatar();
    _statusBar.setStatusText(statusText, fallbackDefault);
    _micUi.setCancelButtonsVisible(cancelVisible);
    import('../ui/car-mode-overlay').then(({ setCarOverlayStatus }) => {
      setCarOverlayStatus(statusText);
    }).catch(() => {});
    return;
  }
  _ensureImports().then(() => syncDisplay(botId, currentBotId, fallbackDefault));
}

// --- Auto-sync wiring ---
let _wired = false;

export function wireAutoSync(getCurrentBotId: () => string, getDefaultStatus: () => string): void {
  if (_wired) return;
  _wired = true;

  const sync = () => {
    const botId = getCurrentBotId();
    syncDisplay(botId, botId, getDefaultStatus());
  };

  bus.on('mic:state-change', sync);
  bus.on('bot:turn-state-change', sync);
  bus.on('agent:state-change', sync);
  bus.on('audio:state', sync);
  bus.on('ui:init-overlay-change', sync);
  bus.on('ui:server-status-change', sync);
}
