// Car mode — ported from app.js

import { bus } from '../core/event-bus';
import { BOT_IDS, STORAGE_KEY } from '../core/types';
import {
  getCurrentBotId, setCurrentBotId, getBotNames,
  getInputMode,
  setUnreadCount,
  showToast, syncStatusDisplay, quietResetBot,
  setCarMode, isCarMode,
} from '../ui/app-state';
import {
  updateMicAvatar, updateChatHeader, updateBadges,
  updateTextReplyBarVisibility, updateListeningBanner,
  requestWakeLock,
} from '../ui/mic-ui';
import { initCarOverlay, updateCarOverlay, getCarOrbCanvas } from '../ui/car-mode-overlay';
import { startOrb, stopOrb } from '../ui/orb-renderer';
import { audioPlayer } from '../audio/audio-player';
import * as ws from '../network/ws-client';
import { switchComposerDraft } from '../ui/text-composer';
import { restartWakeWordListening } from '../wakeword/wakeword-manager';

const carBotName = document.getElementById('car-bot-name');
const carExitBtn = document.getElementById('car-exit-btn');
const settingsOverlay = document.getElementById('settings-overlay');

let carSwipeStartX = 0;
let carSwipeStartY = 0;

function carSwitchBot(newBotId: string): void {
  audioPlayer.getAudioContext();
  quietResetBot(getCurrentBotId());
  document.querySelectorAll('.bot-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.bot-tab[data-bot="${newBotId}"]`)?.classList.add('active');
  switchComposerDraft(getCurrentBotId(), newBotId);
  setCurrentBotId(newBotId);
  updateChatHeader(newBotId);
  if (carBotName) carBotName.textContent = getBotNames()[newBotId];
  updateMicAvatar();
  bus.emit('chat:render', newBotId);
  setUnreadCount(newBotId, 0);
  updateBadges();
  ws.send({ type: 'switch_bot', botId: newBotId });
  syncStatusDisplay(newBotId);
  showToast(getBotNames()[newBotId]);
  if (getInputMode() === 'wakeword') restartWakeWordListening('car switch bot');
}


export function enterCarMode(): void {
  setCarMode(true);
  document.body.classList.add('car-mode');
  document.body.classList.remove('chat-expanded');
  if (carBotName) carBotName.textContent = getBotNames()[getCurrentBotId()];
  settingsOverlay?.classList.remove('open');
  updateMicAvatar();
  updateTextReplyBarVisibility();
  updateListeningBanner();
  requestWakeLock();
  updateCarOverlay();
  const orbCanvas = getCarOrbCanvas();
  if (orbCanvas) startOrb(orbCanvas);
  try { localStorage.setItem(STORAGE_KEY + 'carMode', '1'); } catch (_e) { /* ignore */ }
}

export function exitCarMode(): void {
  stopOrb();
  setCarMode(false);
  document.body.classList.remove('car-mode');
  updateTextReplyBarVisibility();
  updateListeningBanner();
  try { localStorage.removeItem(STORAGE_KEY + 'carMode'); } catch (_e) { /* ignore */ }
}

export function initCarMode(): void {
  carExitBtn?.addEventListener('click', exitCarMode);

  // Listen for enter-car-mode event from settings
  bus.on('ui:enter-car-mode', enterCarMode);
  bus.on('ui:exit-car-mode', exitCarMode);
  initCarOverlay();

  // Swipe to switch bots
  document.addEventListener('touchstart', (e) => {
    if (!isCarMode()) return;
    carSwipeStartX = e.touches[0].clientX;
    carSwipeStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!isCarMode()) return;
    const dx = e.changedTouches[0].clientX - carSwipeStartX;
    const dy = e.changedTouches[0].clientY - carSwipeStartY;
    if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
    const curIdx = Math.max(0, BOT_IDS.indexOf(getCurrentBotId()));
    if (BOT_IDS.length === 0) return;
    let newIdx: number;
    if (dx < 0) newIdx = (curIdx + 1) % BOT_IDS.length;
    else newIdx = (curIdx - 1 + BOT_IDS.length) % BOT_IDS.length;
    const newBotId = BOT_IDS[newIdx];
    if (newBotId !== getCurrentBotId()) carSwitchBot(newBotId);
  });

  // Restore car mode on reload
  try {
    if (localStorage.getItem(STORAGE_KEY + 'carMode') === '1') setTimeout(enterCarMode, 100);
  } catch (_e) { /* ignore */ }
}
