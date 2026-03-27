// WS lifecycle handlers — open/close reconnect logic

import { BOT_IDS, STORAGE_KEY } from '../core/types';
import { t } from '../i18n';
import {
  getCurrentBotId, getBotVoiceSelections, getBotTtsRates,
  defaultStatusText, resetBotToIdle,
  syncStatusDisplay, setBotStreamState,
} from '../ui/app-state';
import { setNetworkOverlay } from '../state/state-projection';
import { botTurnState } from '../state/bot-turn-state';
import { remoteAgentState } from '../state/remote-agent-state';
import * as ws from './ws-client';
import { outbox } from './outbox';
import { syncManager } from './sync';
import { currentDefaultBotId } from '../ui/slot-tabs';
import { showBanner, dismissBanner } from '../ui/error-banner';

export type SetStatusFn = (raw: string) => void;

export function createOnWsOpen(setStatus: SetStatusFn): () => void {
  return function onWsOpen(): void {
    setNetworkOverlay(null);
    dismissBanner('ws-disconnected');
    syncStatusDisplay(getCurrentBotId());
    const defaultBotId = currentDefaultBotId();
    if (getCurrentBotId() !== defaultBotId) ws.send({ type: 'switch_bot', botId: getCurrentBotId() });
    const sttLangSel = document.getElementById('stt-language-select') as HTMLSelectElement | null;
    if (sttLangSel && sttLangSel.value !== 'zh') ws.send({ type: 'set_stt_language', language: sttLangSel.value });
    const sttModelSel = document.getElementById('stt-model-select') as HTMLSelectElement | null;
    if (sttModelSel && sttModelSel.value !== 'whisper-large-v3-turbo') ws.send({ type: 'set_stt_model', model: sttModelSel.value });
    for (const [botId, voiceId] of Object.entries(getBotVoiceSelections())) {
      if (voiceId) ws.send({ type: 'set_voice', botId, voiceId });
    }
    const rates = getBotTtsRates();
    for (const [botId, rate] of Object.entries(rates)) {
      if (rate && rate !== '1.0') ws.send({ type: 'set_tts_rate', botId, rate });
    }
    outbox.drain();
    syncManager.scheduleAll([...BOT_IDS]);
    // Query active turns so reconnecting clients restore processing status
    ws.send({ type: 'query_active_turns' });
  };
}

export function createOnWsClose(setStatus: SetStatusFn): () => void {
  return function onWsClose(): void {
    for (const id of BOT_IDS) {
      // Clear stale stream states so the chat:changed handler's guard
      // (event-wiring.ts) doesn't block sync-path unread detection
      // after reconnection.
      setBotStreamState(id, null);
      botTurnState.resetToIdle(id, 'ws_close');
      remoteAgentState.resetToIdle(id);
      resetBotToIdle(id);
    }
    setNetworkOverlay(t('status.reconnecting'));
    showBanner('ws-disconnected', t('error.connection_lost'));
    syncStatusDisplay(getCurrentBotId());
  };
}

// Storage migration from legacy prefix
export function migrateStoragePrefix(legacyKey: string, newKey: string): void {
  try {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.startsWith(legacyKey)) {
        const nk = newKey + key.slice(legacyKey.length);
        if (localStorage.getItem(nk) === null) {
          localStorage.setItem(nk, localStorage.getItem(key)!);
        }
      }
    }
  } catch (_e) { /* ignore */ }
}
