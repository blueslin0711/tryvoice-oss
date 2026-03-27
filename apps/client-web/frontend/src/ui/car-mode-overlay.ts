// Car mode overlay: info bar, controls, Orb canvas mount point
import { bus } from '../core/event-bus';
import {
  getCurrentBotId, getBotNames, getBotAvatars, isCarMode,
  getInputMode, interruptBot,
} from './app-state';
import { micState } from '../state/mic-state';
import { audioPlayer } from '../audio/audio-player';
import { startRecording, stopRecording } from '../recording/ptt-recorder';
import { applyInputMode } from '../wakeword/wakeword-manager';
import { t } from '../i18n';

const avatarEl = document.getElementById('car-overlay-avatar');
const nameEl = document.getElementById('car-overlay-name');
const statusEl = document.getElementById('car-overlay-status');
const muteBtn = document.getElementById('car-overlay-mute');
const exitBtn = document.getElementById('car-overlay-exit');
const settingsBtn = document.getElementById('car-overlay-settings');
const modeBtn = document.getElementById('car-overlay-mode');
const orbHint = document.getElementById('car-orb-hint');

let _muted = false;
let _prevVolume = 100;

export function updateCarOverlay(): void {
  if (!isCarMode()) return;
  const botId = getCurrentBotId();
  const avatars = getBotAvatars();
  if (avatarEl) {
    if (avatars[botId]) {
      avatarEl.innerHTML = `<img src="${avatars[botId]}" style="width:32px;height:32px;border-radius:50%;" alt="">`;
    } else {
      avatarEl.textContent = '\u{1F916}';
    }
  }
  if (nameEl) nameEl.textContent = getBotNames()[botId] || botId;
  _updateModeBtn();
}

export function setCarOverlayStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

export function getCarOrbCanvas(): HTMLCanvasElement | null {
  return document.getElementById('car-orb-canvas') as HTMLCanvasElement | null;
}

function _updateModeBtn(): void {
  if (!modeBtn) return;
  const mode = getInputMode();
  if (mode === 'wakeword') {
    modeBtn.classList.add('wakeword-active');
    modeBtn.textContent = '👂';
    modeBtn.title = t('mic.switch_to_ptt');
  } else {
    modeBtn.classList.remove('wakeword-active');
    modeBtn.textContent = '🤚';
    modeBtn.title = t('mic.switch_to_wakeword');
  }
  // Update hint text
  if (orbHint) {
    orbHint.textContent = mode === 'wakeword' ? '唤醒词模式 · 点击也可说话' : '点击说话';
  }
}

export function initCarOverlay(): void {
  // Mute toggle
  muteBtn?.addEventListener('click', () => {
    _muted = !_muted;
    if (_muted) {
      const gainNode = audioPlayer.getGainNode();
      _prevVolume = gainNode ? gainNode.gain.value * 100 : 100;
      audioPlayer.setVolume(0);
      muteBtn.classList.add('muted');
    } else {
      audioPlayer.setVolume(_prevVolume);
      muteBtn.classList.remove('muted');
    }
  });

  // Exit car mode
  exitBtn?.addEventListener('click', () => {
    bus.emit('ui:exit-car-mode');
  });

  // Settings
  settingsBtn?.addEventListener('click', () => {
    const settingsOverlay = document.getElementById('settings-overlay');
    settingsOverlay?.classList.add('open');
  });

  // Mode switch: toggle PTT / wakeword
  modeBtn?.addEventListener('click', () => {
    const current = getInputMode();
    const next = current === 'wakeword' ? 'ptt' : 'wakeword';
    applyInputMode(next);
    _updateModeBtn();
  });

  // Orb ring tap: toggle recording (both modes) + interrupt speaking
  const orbRing = document.getElementById('car-orb-ring');
  orbRing?.addEventListener('click', () => {
    // If AI is speaking, tap to interrupt
    if (audioPlayer.state !== 'idle') {
      interruptBot(getCurrentBotId(), 'stopped_reading');
      return;
    }
    // If currently recording, stop
    if (micState.isActive) {
      stopRecording();
      audioPlayer.getAudioContext();
      return;
    }
    // Start recording
    startRecording();
  });

  // Update overlay on bot switch
  bus.on('chat:render', () => updateCarOverlay());

  // Update mode button when input mode changes externally
  bus.on('ui:input-mode-changed', () => _updateModeBtn());
}
