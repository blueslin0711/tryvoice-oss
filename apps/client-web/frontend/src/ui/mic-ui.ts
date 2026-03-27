// Mic button UI state management
// Ported from app.js mic/avatar/badge/banner UI

import { bus } from '../core/event-bus';
import {
  getCurrentBotId, getBotNames, getBotDisplayName, getBotAvatars, getBotVoiceSelections, getDefaultVoice,
  getUnreadCount, setUnreadCount, isAutoReadEnabled,
  getInputMode, isCarMode,
  defaultStatusText, showToast,
} from './app-state';
import { micState } from '../state/mic-state';
import { BOT_IDS, STORAGE_KEY } from '../core/types';
import { t, getLocale } from '../i18n';

const micBtn = document.getElementById('mic-btn');
const wwToggle = document.getElementById('ww-toggle');
const autoReadToggle = document.getElementById('auto-read-toggle');
const hintEl = document.getElementById('hint');
const statusEl = document.getElementById('status');
const focusBanner = document.getElementById('focus-banner');
const carBotName = document.getElementById('car-bot-name');

// Voice feedback audio cache — stores decoded AudioBuffers for zero-latency playback
const voiceFeedbackCache: Record<string, { voiceId: string; locale: string; startBuf: AudioBuffer | null; stopBuf: AudioBuffer | null; cancelBuf: AudioBuffer | null }> = {};
const voiceFeedbackPending: Record<string, Promise<void>> = {};

export function setMicRecordingState(state: string): void {
  if (!micBtn) return;
  micBtn.classList.remove('recording', 'processing', 'speaking');
  document.body.classList.remove('state-recording', 'state-processing', 'state-speaking');
  if (state) {
    micBtn.classList.add(state);
    document.body.classList.add(`state-${state}`);
  }
}

const cancelBtn = document.getElementById('cancel-btn');
const carCancelBtn = document.getElementById('car-cancel-btn');

export function setCancelButtonsVisible(visible: boolean): void {
  cancelBtn?.classList.toggle('show', visible);
  carCancelBtn?.classList.toggle('show', visible);
}

export function setCancelReplyActive(_active: boolean): void {
  // no-op: cancel reply buttons removed from UI
}

export function setVoiceRipple(rms: number): void {
  if (!micBtn) return;
  const norm = Math.min(rms / 0.15, 1);
  micBtn.style.setProperty('--mic-rms', String(norm));
  bus.emit('recording:rms', rms);
}

export function setTtsRipple(rms: number): void {
  if (!micBtn) return;
  const norm = Math.min(rms / 0.15, 1);
  micBtn.style.setProperty('--tts-rms', String(norm));
}

export function clearRipple(): void {
  if (!micBtn) return;
  micBtn.style.removeProperty('--mic-rms');
  micBtn.style.removeProperty('--tts-rms');
}

export function updateMicAvatar(): void {
  if (!micBtn) return;
  const botId = getCurrentBotId();
  const avatars = getBotAvatars();
  if (avatars[botId]) {
    micBtn.style.backgroundImage = `url(${avatars[botId]})`;
    micBtn.textContent = '';
  } else {
    micBtn.style.backgroundImage = '';
    micBtn.textContent = '\u{1F3A4}';
  }
}

export function updateBadges(): void {
  BOT_IDS.forEach(id => {
    const tab = document.querySelector(`.bot-tab[data-bot="${id}"]`);
    if (!tab) return;
    const badge = tab.querySelector('.badge') as HTMLElement;
    if (!badge) return;
    const count = getUnreadCount(id);
    if (count > 0) {
      badge.textContent = String(count);
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }
  });
}

export function updateChatHeader(botId: string): void {
  const nameEl = document.getElementById('chat-current-name');
  if (nameEl) nameEl.textContent = getBotDisplayName(botId);
  if (carBotName) carBotName.textContent = getBotDisplayName(botId);
}

export function setWwToggleLoading(loading: boolean): void {
  if (!wwToggle) return;
  if (loading) {
    wwToggle.classList.add('show', 'loading');
    wwToggle.classList.remove('active');
  } else {
    wwToggle.classList.remove('loading');
    // Restore active state — restartWakeWordListening() calls startWakeWord()
    // which removes 'active' on loading=true, but never re-adds it because
    // updateWwToggle() is only called from applyInputMode(), not restart.
    if (getInputMode() === 'wakeword') {
      wwToggle.classList.add('active');
    }
  }
}

export function updateWwToggle(): void {
  if (!wwToggle) return;
  wwToggle.classList.remove('loading');
  const mode = getInputMode();
  if (mode === 'ptt') {
    wwToggle.classList.add('show');
    wwToggle.textContent = '🤚';
    wwToggle.title = t('mic.switch_to_wakeword');
    wwToggle.classList.remove('active');
  } else if (mode === 'wakeword') {
    wwToggle.classList.add('show');
    wwToggle.textContent = '👂';
    wwToggle.title = t('mic.switch_to_ptt');
    wwToggle.classList.add('active');
  } else {
    wwToggle.classList.remove('show');
  }
}

// Wakeword audio level → ear icon pulsing animation
const carModeBtn = document.getElementById('car-overlay-mode');
bus.on('wakeword:audio-level', (rms: number) => {
  const norm = Math.min(rms / 0.12, 1);
  if (wwToggle) wwToggle.style.setProperty('--ww-rms', String(norm));
  if (carModeBtn) carModeBtn.style.setProperty('--ww-rms', String(norm));
});

export function updateAutoReadToggle(): void {
  if (!autoReadToggle) return;
  if (isAutoReadEnabled()) {
    autoReadToggle.classList.add('active');
    autoReadToggle.classList.remove('off');
  } else {
    autoReadToggle.classList.remove('active');
    autoReadToggle.classList.add('off');
  }
}

export function updateListeningBanner(): void {
  if (!focusBanner) return;
  const mode = getInputMode();
  if (mode === 'wakeword') {
    focusBanner.classList.add('show', 'wakeword');
    focusBanner.classList.remove('vad');
  } else {
    focusBanner.classList.remove('show', 'wakeword', 'vad');
  }
}

export function updateTextReplyBarVisibility(): void {
  const bar = document.getElementById('text-reply-bar');
  if (!bar) return;
  if (isCarMode()) {
    bar.classList.remove('show');
  } else {
    bar.classList.add('show');
  }
}

export function refreshAllBotNameDisplays(): void {
  const names = getBotNames();
  BOT_IDS.forEach(id => {
    const tab = document.querySelector(`.bot-tab[data-bot="${id}"] .tab-name`);
    if (tab) tab.textContent = names[id] || id;
  });
  updateChatHeader(getCurrentBotId());
}

export function refreshAvatars(): void {
  const avatars = getBotAvatars();
  BOT_IDS.forEach(id => {
    const tab = document.querySelector(`.bot-tab[data-bot="${id}"]`);
    if (!tab) return;
    const imgEl = tab.querySelector('.tab-avatar') as HTMLImageElement;
    const emojiEl = tab.querySelector('.tab-avatar-emoji') as HTMLElement;
    if (avatars[id]) {
      if (imgEl) { imgEl.src = avatars[id]; imgEl.style.display = ''; }
      if (emojiEl) emojiEl.style.display = 'none';
    } else {
      if (imgEl) imgEl.style.display = 'none';
      if (emojiEl) { emojiEl.style.display = ''; emojiEl.textContent = '\u{1F916}'; }
    }
  });
  updateMicAvatar();
}

async function fetchTTSForBot(text: string, botId: string): Promise<string | null> {
  const { azureTTS } = await import('../audio/azure-tts');
  const { getBotVoiceSelections: getVS, getDefaultVoice: getDV, getBotTtsRates: getRates } = await import('./app-state');
  const voice = getVS()[botId] || getDV();
  const rate = getRates()[botId] || '1.0';
  // Try Azure browser-direct TTS first
  if (azureTTS.ready) {
    try {
      const b64 = await azureTTS.speak(text, { voice, rate });
      if (b64) return b64;
    } catch (_e) { /* fallback to server */ }
  }
  // Fallback: server-side Edge TTS (pass voice explicitly — server may not have it yet)
  try {
    const resp = await fetch('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, botId, voice, rate }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.audio as string) || null;
  } catch (_e) { return null; }
}

function decodeB64ToAudioBuffer(ctx: AudioContext, b64: string): Promise<AudioBuffer> {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return ctx.decodeAudioData(buf.buffer.slice(0));
}

// Audio context + beep helpers for PTT mode
let _beepCtx: AudioContext | null = null;
function _playBeep(freqStart: number, freqEnd: number, dur: number): void {
  try {
    if (!_beepCtx) _beepCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = _beepCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqStart, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(freqEnd, ctx.currentTime + dur);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur);
  } catch (_e) { /* ignore */ }
}
function _playStartBeep(): void {
  _playBeep(600, 900, 0.12);
}
function _playStopBeep(): void {
  _playBeep(900, 500, 0.15);
}

export async function playVoiceFeedback(type: 'start' | 'stop' | 'cancel'): Promise<void> {
  // PTT mode: use simple beep sounds (matching original behavior)
  if (getInputMode() !== 'wakeword') {
    if (type === 'start') _playStartBeep();
    else _playStopBeep();
    return;
  }

  // Wakeword mode: play TTS voice feedback
  const botId = getCurrentBotId();
  const cached = voiceFeedbackCache[botId];
  const bufKey = (type + 'Buf') as 'startBuf' | 'stopBuf' | 'cancelBuf';
  const buf = cached?.[bufKey] ?? (type === 'cancel' ? cached?.stopBuf : null);
  if (buf) {
    try {
      const { audioPlayer } = await import('../audio/audio-player');
      const ctx = audioPlayer.getAudioContext();
      const source = ctx.createBufferSource();
      source.buffer = buf;
      // Route through main gain node (respects user volume) like original
      const gainNode = audioPlayer.getGainNode();
      if (gainNode) {
        source.connect(gainNode);
      } else {
        source.connect(ctx.destination);
      }
      await new Promise<void>(resolve => { source.onended = () => resolve(); source.start(); });
    } catch (_e) { /* ignore */ }
    return;
  }
  // No cache: play beep as fallback, trigger prefetch for next time
  if (type === 'start') _playStartBeep();
  else _playStopBeep();
  prefetchVoiceFeedback(botId);
}

export async function prefetchVoiceFeedback(botId: string): Promise<void> {
  const voiceId = getBotVoiceSelections()[botId] || getDefaultVoice() || '';
  const locale = getLocale();
  const cached = voiceFeedbackCache[botId];
  if (cached && cached.voiceId === voiceId && cached.locale === locale) return;
  if (botId in voiceFeedbackPending) {
    try { await voiceFeedbackPending[botId]; } catch (_e) { /* ignore */ }
    const freshCache = voiceFeedbackCache[botId];
    if (freshCache && freshCache.voiceId === voiceId && freshCache.locale === locale) return;
    // Stale pending wrote wrong voice or wrong locale — delete so playVoiceFeedback
    // falls back to beep instead of playing stale audio while we re-fetch
    delete voiceFeedbackCache[botId];
  }
  const promise = (async () => {
    try {
      const { audioPlayer } = await import('../audio/audio-player');
      const ctx = audioPlayer.getAudioContext();

      // L2: check localStorage before calling TTS
      const lsKey = STORAGE_KEY + 'vf_' + voiceId + '_' + locale;
      let startB64: string | null = null;
      let stopB64: string | null = null;
      let cancelB64: string | null = null;
      try {
        const stored = localStorage.getItem(lsKey);
        if (stored) {
          const parsed = JSON.parse(stored) as { v: number; startB64: string; stopB64: string; cancelB64?: string };
          if (parsed.v === 1 && parsed.startB64 && parsed.stopB64) {
            startB64 = parsed.startB64;
            stopB64 = parsed.stopB64;
            cancelB64 = parsed.cancelB64 || null;
          }
        }
      } catch (_e) { /* ignore LS read errors */ }

      // L3: TTS API on localStorage miss
      if (!startB64 || !stopB64) {
        [startB64, stopB64, cancelB64] = await Promise.all([
          fetchTTSForBot(t('mic.feedback.here'), botId),
          fetchTTSForBot(t('mic.feedback.received'), botId),
          fetchTTSForBot(t('mic.feedback.cancelled'), botId),
        ]);
        if (!startB64 || !stopB64) return;
        // Persist to localStorage for future page loads
        try {
          localStorage.setItem(lsKey, JSON.stringify({ v: 1, startB64, stopB64, cancelB64 }));
        } catch (_e) { /* ignore LS write errors (quota exceeded etc.) */ }
      }

      // Decode base64 → AudioBuffer for zero-latency playback
      const [startBuf, stopBuf, cancelBuf] = await Promise.all([
        decodeB64ToAudioBuffer(ctx, startB64),
        decodeB64ToAudioBuffer(ctx, stopB64),
        cancelB64 ? decodeB64ToAudioBuffer(ctx, cancelB64) : Promise.resolve(null),
      ]);
      voiceFeedbackCache[botId] = { voiceId, locale, startBuf, stopBuf, cancelBuf };
    } catch (_e) { /* ignore */ }
  })();
  voiceFeedbackPending[botId] = promise;
  await promise;
  delete voiceFeedbackPending[botId];
}

export function invalidateVoiceFeedback(botId: string): void {
  delete voiceFeedbackCache[botId];
  if (getInputMode() === 'wakeword') prefetchVoiceFeedback(botId);
}

// Wake lock
let wakeLock: WakeLockSentinel | null = null;
let _nativeKeepAwake = false;

export async function requestWakeLock(): Promise<void> {
  // Prefer native idle timer on iOS Capacitor
  const { nativeSetKeepAwake } = await import('../platform/native-screen-lock');
  _nativeKeepAwake = await nativeSetKeepAwake(true);
  if (_nativeKeepAwake) return;

  // Web fallback
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await (navigator as Navigator & { wakeLock: { request: (type: string) => Promise<WakeLockSentinel> } }).wakeLock.request('screen');
    }
  } catch (_e) { /* ignore */ }
}

export async function releaseWakeLock(): Promise<void> {
  if (_nativeKeepAwake) {
    const { nativeSetKeepAwake } = await import('../platform/native-screen-lock');
    await nativeSetKeepAwake(false);
    _nativeKeepAwake = false;
  }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

export function getStatusEl(): HTMLElement | null { return statusEl; }
export function getHintEl(): HTMLElement | null { return hintEl; }
export function getMicBtn(): HTMLElement | null { return micBtn; }
