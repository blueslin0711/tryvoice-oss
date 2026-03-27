// Main entry point — wires all modules together
// Each module is self-contained; main.ts only does assembly and event binding.

// Disable browser page-level scroll restoration on refresh
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

import './styles.css';
import { bootstrapNativePlatform } from './platform/native-bootstrap';
import { isNativePlatform, getServerUrl, setServerUrl } from './platform/server-url';
import { saveSnapshot, consumeSnapshot } from './platform/state-snapshot';
import { wasCrashReload } from './platform/crash-recovery';
import { showAudioUnlockOverlay } from './platform/audio-unlock';
import { initLocalNotifications } from './platform/local-notifications';
bootstrapNativePlatform(); // Must run before any fetch() or WS calls
import { createLogger } from './logging/logger';
import { bus } from './core/event-bus';

const log = createLogger('ui.app');
import { BOT_IDS, STORAGE_KEY, STORAGE_KEY_LEGACY } from './core/types';
import { chatStore } from './store/chat-store';
import * as ws from './network/ws-client';
import { syncManager } from './network/sync';
import { audioPlayer } from './audio/audio-player';
import { browserSTT } from './audio/browser-stt';
import { azureTTS } from './audio/azure-tts';
import {
  getCurrentBotId, setCurrentBotId, getBotNames, setBotNames,
  getUnreadCount, setUnreadCount, getBotSeenCount, setBotSeenCount,
  getInputMode, isAutoReadEnabled, setAutoReadEnabled, getWwEngine,
  setBotVoiceSelection, setVoicesList, setDefaultVoice,
  defaultStatusText, showToast, syncSetting,
  loadSharedSettings, applySharedSettings,
  syncStatusDisplay, interruptBot, quietResetBot,
  getHeightScale, shouldIncludeMsg, getLastReadSeq, setLastReadSeq,
} from './ui/app-state';
import { micState } from './state/mic-state';
import { renderChat, initChatRenderer, resetScrollSession, saveScrollPosition, restoreScrollPosition, scrollToFirstUnread } from './ui/chat-renderer';
import {
  updateBadges, updateChatHeader, updateAutoReadToggle,
  updateTextReplyBarVisibility,
  refreshAllBotNameDisplays, refreshAvatars,
  setTtsRipple, clearRipple,
  invalidateVoiceFeedback,
} from './ui/mic-ui';
import { initCopyHelper, initDesktopCopy } from './ui/copy-helper';
import { pttTap, cancelRecording } from './recording/ptt-recorder';
import { applyInputMode, restartWakeWordListening, cancelWakeWordRecording, preloadOwwSessions } from './wakeword/wakeword-manager';
import { initSettings, restoreFontSize } from './settings/settings-panel';
import { notifyBotSwitched } from './settings/slide-reset';
import { initCarMode } from './settings/car-mode';
import { checkAndShowSetupWizard } from './ui/setup-wizard';
import { setStatusText, bindStatusCompactor } from './ui/status-bar';
import { bootstrapSlots, bindBotTabs, setActiveTab, currentDefaultBotId } from './ui/slot-tabs';
import { createWsDispatcher, resetAnnouncedSnapshot, scheduleUnreadAnnouncement } from './network/ws-dispatcher';
import { initTextComposer, initMobileMenu, syncMenuAutoReadState, switchComposerDraft } from './ui/text-composer';
import { ensureAuthorized } from './ui/auth-overlay';
import { ensureWakewordScripts } from './core/script-loader';
import { initGestures } from './ui/gesture';
import { createOnWsOpen, createOnWsClose, migrateStoragePrefix } from './network/ws-lifecycle';
import { bindAudioStateEvents, bindChatEvents, bindWsEvents, bindOutboxEvents, bindChatStoreChanged } from './ui/event-wiring';
import { wireMicSync, botTurnState } from './state/bot-turn-state';
import { wireAutoSync } from './state/state-projection';
import { outbox } from './network/outbox';
import { t } from './i18n';
import { initToastContainer } from './ui/toast';
import { initErrorBanner } from './ui/error-banner';
import { initApiKeyBanner } from './ui/api-key-banner';

// ---- DOM refs ----
const transcript = document.getElementById('transcript')!;
const micBtn = document.getElementById('mic-btn');
const wwToggle = document.getElementById('ww-toggle');
const autoReadToggle = document.getElementById('auto-read-toggle');
const settingsOverlay = document.getElementById('settings-overlay');
const dragHandle = document.getElementById('drag-handle');

// ---- Viewport height fix for mobile ----
function _applyViewportHeightVar(): void {
  const vv = Math.round(window.visualViewport?.height || 0);
  const vvTop = Math.round(window.visualViewport?.offsetTop || 0);
  const ih = Math.round(window.innerHeight || 0);
  const ch = Math.round(document.documentElement?.clientHeight || 0);
  const rawH = Math.max(vv + vvTop, vv, ih, ch);
  if (rawH > 0) {
    const scale = getHeightScale();
    const h = scale < 1 ? Math.round(rawH * scale) : rawH;
    document.documentElement.style.setProperty('--app-vh', `${h}px`);
    document.body.classList.toggle('recording-mode', scale < 1);
  }
}

function _bindViewportHeightVar(): void {
  const update = () => _applyViewportHeightVar();
  update();
  window.addEventListener('resize', update, { passive: true });
  window.addEventListener('orientationchange', update);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', update, { passive: true });
    window.visualViewport.addEventListener('scroll', update, { passive: true });
  }
  setTimeout(update, 220);
  setTimeout(update, 900);
}

// ---- Status text helper ----
function _setStatus(raw: string): void {
  setStatusText(raw, defaultStatusText());
}

// ---- Bot switching ----
function switchToBot(newBotId: string, opts?: { suppressAutoRead?: boolean }): void {
  if (!BOT_IDS.includes(newBotId)) return;
  if (newBotId === getCurrentBotId()) return;
  const oldBotId = getCurrentBotId();
  audioPlayer.getAudioContext();
  // Cancel active recording (mic is shared singleton)
  const wasMicActive = micState.isActive;
  if (wasMicActive && micState.getMode() === 'wakeword') cancelWakeWordRecording();
  else if (wasMicActive) cancelRecording();
  // If mic was recording, fully interrupt old bot's turn; otherwise just reset display
  if (wasMicActive) {
    interruptBot(getCurrentBotId());
  } else {
    quietResetBot(getCurrentBotId());
  }
  // Save old bot's scroll position before switching (ISSUE-11b/20)
  saveScrollPosition(oldBotId);
  setActiveTab(newBotId);
  notifyBotSwitched(newBotId);
  switchComposerDraft(getCurrentBotId(), newBotId);
  setCurrentBotId(newBotId);
  try { localStorage.setItem(STORAGE_KEY + 'currentBotId', newBotId); } catch (_e) { /* ignore */ }
  updateChatHeader(newBotId);
  // Reset scroll tracking so the deferred requestAnimationFrame scroll-to-bottom
  // in renderChat is not blocked by stale _userHasScrolledThisSession from the
  // previous bot. Without this, if the user scrolled at any point during the
  // session, the rAF fallback won't fire and the sync scrollTop=scrollHeight may
  // use a pre-layout scrollHeight, leaving the chat stuck mid-history.
  resetScrollSession();
  renderChat(newBotId);
  // Scroll to first unread message if the bot has unreads (PI-02).
  // Must run after renderChat so the DOM has the correct elements.
  const lastRead = getLastReadSeq(newBotId);
  const maxSeq = chatStore.getMaxServerSeq(newBotId);
  const hasUnreads = lastRead >= 0 && maxSeq > lastRead;
  if (hasUnreads) {
    // Try to scroll to the first unread message at ~1/3 from top
    if (!scrollToFirstUnread(lastRead)) {
      // Fallback: restore saved position or stay at bottom
      restoreScrollPosition(newBotId);
    }
  } else {
    // No unreads: restore saved scroll position for the new bot (ISSUE-11b/20).
    // Must run after renderChat so the DOM has the correct scrollHeight.
    // If no saved position, renderChat already scrolled to bottom.
    restoreScrollPosition(newBotId);
  }
  // Mark all currently-rendered messages as seen so sync-path chat:changed
  // events (e.g. from mergeFromServer) don't re-count them as new unread.
  const seenCount = chatStore.getMessages(newBotId).filter(m => m.role === 'assistant' && shouldIncludeMsg(m)).length;
  setBotSeenCount(newBotId, seenCount);
  const unreadN = getUnreadCount(newBotId);
  setUnreadCount(newBotId, 0);
  updateBadges();
  // Advance lastReadSeq on the OLD bot (we just left it, all seen)
  if (oldBotId && oldBotId !== newBotId) {
    const oldMax = chatStore.getMaxServerSeq(oldBotId);
    if (oldMax > getLastReadSeq(oldBotId)) setLastReadSeq(oldBotId, oldMax);
  }
  ws.send({ type: 'switch_bot', botId: newBotId });
  syncStatusDisplay(newBotId);
  if (unreadN > 0 && !opts?.suppressAutoRead) bus.emit('chat:auto-read-unread', { botId: newBotId, count: unreadN });
  resetAnnouncedSnapshot();
  scheduleUnreadAnnouncement();
  showToast(getBotNames()[newBotId]);
}

bus.on('bot:switch', (payload: unknown) => {
  if (typeof payload === 'string') {
    switchToBot(payload);
  } else {
    const obj = payload as { botId: string; suppressAutoRead?: boolean };
    switchToBot(obj.botId, { suppressAutoRead: obj.suppressAutoRead });
  }
});

// Processing timeout: resetBotToIdle + syncStatusDisplay already called in app-state.ts
bus.on('bot:processing-timeout', (_botId: unknown) => {
  // Nothing extra needed — app-state.ts handles reset and display sync
});

// Speaking timeout: same pattern — app-state.ts handles reset and display sync
bus.on('bot:speaking-timeout', (_botId: unknown) => {});

bus.on('audio:tts-rms', (rms: unknown) => {
  setTtsRipple(rms as number);
});

bus.on('audio:state', (evt: unknown) => {
  const { state } = evt as { state: string };
  if (state === 'idle') clearRipple();
});

// ---- WS dispatcher & lifecycle ----
const onWsMessage = createWsDispatcher();
const _onWsOpen = createOnWsOpen(_setStatus);
const _onWsClose = createOnWsClose(_setStatus);

// ---- Event wiring ----
bindAudioStateEvents(transcript);
bindChatEvents();

// ---- PTT binding ----
micBtn?.addEventListener('click', pttTap);
micBtn?.addEventListener('touchend', pttTap, { passive: false } as AddEventListenerOptions);
document.addEventListener('keydown', (e) => {
  if (getInputMode() !== 'ptt') return;
  if (e.code === 'Space' && !e.repeat && !(e.target as HTMLElement).matches('input,textarea')) {
    e.preventDefault();
    pttTap();
  }
});

// ---- Cancel button (cancel recording / stop TTS) ----
const cancelBtn = document.getElementById('cancel-btn');
const carCancelBtn = document.getElementById('car-cancel-btn');
function onCancelClick(): void {
  // Cancel button only controls recording and TTS playback.
  // It does NOT interrupt session generation — ESC key does that.

  // Priority 1: cancel wakeword recording
  if (micState.isActive && micState.getMode() === 'wakeword') {
    cancelWakeWordRecording();
    return;
  }
  // Priority 2: cancel PTT recording
  if (micState.isActive) {
    cancelRecording();
    return;
  }
  // Priority 3: stop TTS playback (without cancelling the turn)
  if (audioPlayer.isPlaying) {
    quietResetBot(getCurrentBotId());
    return;
  }
}
cancelBtn?.addEventListener('click', onCancelClick);
carCancelBtn?.addEventListener('click', onCancelClick);

// ---- WW toggle ----
wwToggle?.addEventListener('click', () => {
  if (getInputMode() === 'wakeword') {
    applyInputMode('ptt');
    showToast(t('toast.switched_to_ptt'));
  } else {
    applyInputMode('wakeword');
    showToast(t('toast.switched_to_wakeword'));
  }
});

// ---- Auto-read toggle ----
autoReadToggle?.addEventListener('click', () => {
  const enabled = !isAutoReadEnabled();
  setAutoReadEnabled(enabled);
  syncSetting('autoRead', enabled ? '1' : '0');
  updateAutoReadToggle();
  syncMenuAutoReadState();
  // Stop ongoing TTS playback immediately when autoRead is turned off
  if (!enabled) bus.emit('interrupt:stop-audio');
  showToast(enabled ? t('toast.auto_read_on') : t('toast.auto_read_off'));
});

// ---- Gestures ----
initGestures(transcript, settingsOverlay, dragHandle);

// ---- pageshow: soft recovery on bfcache restore ----
// Previously this did location.reload() on bfcache restore, causing a disruptive
// white-flash on every iOS app-switch. The WebSocket auto-reconnect (ws-client.ts)
// plus onWsOpen state sync (ws-lifecycle.ts) already handle full recovery, so we
// only need to kick AudioContext resume + an immediate history sync here.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    log.info('bfcache restore — soft recovery', {});
    resetScrollSession(); // ensure next renderChat scrolls to bottom
    syncManager.scheduleAll([...BOT_IDS]);
    setTimeout(() => updateBadges(), 200);
    try { audioPlayer.getAudioContext(); } catch (_e) { /* ignore */ }
  }
  if (getInputMode() === 'wakeword') setTimeout(() => restartWakeWordListening('pageshow'), 300);
});

// ---- visibilitychange: sync + badge refresh on foreground return ----
// On iOS, WKWebView JavaScript is frozen when the app is backgrounded.
// Messages that arrive during this window may be queued by WebKit but badge updates
// can be deferred or skipped. On returning to foreground, force a history sync so
// any messages received while backgrounded are fetched and unread badges are shown.
// (If WS disconnected, scheduleAll defers until the reconnect fires onWsOpen.)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    saveSnapshot(); // save state before iOS freezes us
    return;
  }
  syncManager.scheduleAll([...BOT_IDS]);
  setTimeout(() => updateBadges(), 200);
  // Resume the TTS AudioContext — iOS suspends all AudioContexts when backgrounded.
  // Without this, TTS audio won't play after the user returns from background.
  try { audioPlayer.getAudioContext(); } catch (_e) { /* ignore */ }
});

// ---- Slot refresh after setup wizard ----
window.addEventListener('slots-changed', async () => {
  await bootstrapSlots();
  bindBotTabs(switchToBot);
  refreshAvatars();
  updateChatHeader(getCurrentBotId());
});

// ---- Init ----
async function init(): Promise<void> {
  initToastContainer();
  initErrorBanner();
  initApiKeyBanner();
  migrateStoragePrefix(STORAGE_KEY_LEGACY, STORAGE_KEY);
  migrateStoragePrefix('voice_shell_', STORAGE_KEY);

  // On native platforms, ensure backend server URL is configured
  if (isNativePlatform() && !getServerUrl()) {
    const url = prompt('Enter TryVoice server URL (e.g., https://192.168.1.100:7860)');
    if (url) setServerUrl(url);
    else {
      document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#fff;font-size:16px;">Please restart the app and enter a valid server URL.</div>';
      return;
    }
  }

  initLocalNotifications().catch(() => {});  // request notification permission on iOS
  bindStatusCompactor(defaultStatusText);
  await bootstrapSlots();
  // Restore persisted bot selection (ISSUE-11a)
  try {
    const savedBotId = localStorage.getItem(STORAGE_KEY + 'currentBotId');
    if (savedBotId && BOT_IDS.includes(savedBotId) && savedBotId !== getCurrentBotId()) {
      setCurrentBotId(savedBotId);
      setActiveTab(savedBotId);
    }
  } catch (_e) { /* ignore */ }
  bindBotTabs(switchToBot);
  refreshAvatars();
  updateChatHeader(getCurrentBotId());

  chatStore.init([...BOT_IDS]);
  bindChatStoreChanged();

  const savedVolume = (() => { try { return localStorage.getItem(STORAGE_KEY + 'volume'); } catch (_e) { return null; } })();
  audioPlayer.init({
    requestTTS: (text: string, cb: (b64: string | null) => void) => azureTTS.requestTTS(text, cb),
    initialVolume: savedVolume !== null ? Number(savedVolume) : 100,
  });

  // Detect crash-reload and restore UI state
  const crashReload = await wasCrashReload();
  const snapshot = crashReload ? consumeSnapshot() : null;
  if (snapshot) {
    log.info('Crash-reload detected, restoring snapshot', { botId: snapshot.botId, inputMode: snapshot.inputMode });
    if (snapshot.botId !== getCurrentBotId()) {
      switchToBot(snapshot.botId);
    }
  }
  if (crashReload) {
    // Show tap-to-resume overlay — user gesture unlocks AudioContext on iOS
    showAudioUnlockOverlay().then(() => {
      applyInputMode(getInputMode());
    });
  }

  initChatRenderer();
  initTextComposer();
  initMobileMenu();
  initCopyHelper();
  initDesktopCopy(transcript);

  // Load IDB cache first so cursor is non-zero → afterSeq incremental sync
  // instead of initial-100 full load that would overwrite historical messages.
  await chatStore.loadAll([...BOT_IDS]);
  syncManager.scheduleAll([...BOT_IDS]);

  // Trigger background summary generation for archived bots
  fetch('/history/generate-summaries', { method: 'POST' }).catch(() => {});

  azureTTS.init().then(() => { if (azureTTS.ready) log.info('Azure TTS ready'); });
  browserSTT.init().then(() => { if (browserSTT.ready) log.info('Browser STT ready'); });
  outbox.init();

  bindOutboxEvents();
  bindWsEvents(onWsMessage, _onWsOpen, _onWsClose);

  ws.connect();
  wireMicSync();
  wireAutoSync(getCurrentBotId, defaultStatusText);
  // Preload wakeword scripts early if user's saved mode is wakeword
  if (getInputMode() === 'wakeword') {
    ensureWakewordScripts(getWwEngine());  // fire-and-forget
  }
  applyInputMode(getInputMode());
  updateTextReplyBarVisibility();
  updateAutoReadToggle();

  // Fetch shared settings and voice list in parallel
  const [shared] = await Promise.all([
    loadSharedSettings(),
    fetch('/voices').then(r => r.ok ? r.json() : null).then(data => {
      if (data?.voices) setVoicesList(data.voices);
      if (data?.current) setDefaultVoice(data.current);
    }).catch(() => {}),
  ]);
  // Restore ALL settings from backend (covers cleared localStorage / new device)
  applySharedSettings(shared);
  // Re-apply input mode in case wakeword mode was restored from backend
  // (applyInputMode ran earlier with the localStorage-initialized mode)
  applyInputMode(getInputMode());
  // UI updates that require imports not available in app-state.ts.
  // These are also called earlier in init() but must run again after backend restore
  // to reflect values that may differ from the localStorage-initialized state.
  refreshAvatars();
  updateAutoReadToggle();
  updateTextReplyBarVisibility();
  refreshAllBotNameDisplays();
  // Re-invalidate voice feedback if wakeword mode was restored from backend
  if (getInputMode() === 'wakeword') {
    for (const id of BOT_IDS) invalidateVoiceFeedback(id);
  }
  // Voiceprint handled separately (async import)
  if (shared.voiceprintEmbedding) {
    const { restoreVoiceprintFromBackend } = await import('./wakeword/voiceprint-verifier');
    restoreVoiceprintFromBackend(shared);
  }

  restoreFontSize();
  initSettings();
  initCarMode();

  // Preload OWW models in background so wakeword mode switch is instant
  preloadOwwSessions();
}

// ---- Entry point ----
(async () => {
  _bindViewportHeightVar();
  await ensureAuthorized();
  const needsSetup = await checkAndShowSetupWizard();
  if (needsSetup) return;
  await init();
  if ('serviceWorker' in navigator && !import.meta.env.DEV) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      log.warn('Service worker registration failed', { detail: String(err) });
      showToast(t('error.sw_failed'), { severity: 'warning' });
    });
  }
})().catch(e => log.error('Init failed', { detail: String(e) }));
