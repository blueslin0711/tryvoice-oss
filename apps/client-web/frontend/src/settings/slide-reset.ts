// Slide-to-reset session button — ported from app.js

import { getCurrentBotId, getBotNames, showToast } from '../ui/app-state';
import * as ws from '../network/ws-client';
import { t } from '../i18n';

let resetSliderComplete: (() => void) | null = null;
let resetSliderFailed: (() => void) | null = null;
let _pendingResetBotId: string | null = null;

export function initSlideReset(): void {
  const trackEl = document.getElementById('slide-reset');
  if (!trackEl) return;
  const thumb = trackEl.querySelector('.slide-reset-thumb') as HTMLElement;
  if (!thumb) return;
  const track: HTMLElement = trackEl;

  let dragging = false;
  let startX = 0;
  let thumbLeft = 0;
  const THRESHOLD = 0.78;
  let resetTimeout: ReturnType<typeof setTimeout> | null = null;

  function getMaxLeft(): number { return track.offsetWidth - thumb.offsetWidth - 4; }

  function onStart(e: MouseEvent | TouchEvent): void {
    dragging = true;
    startX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    thumbLeft = thumb.offsetLeft;
    thumb.classList.add('dragging');
    e.preventDefault();
  }

  function onMove(e: MouseEvent | TouchEvent): void {
    if (!dragging) return;
    const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const dx = x - startX;
    const maxL = getMaxLeft();
    const newLeft = Math.max(2, Math.min(thumbLeft + dx, maxL + 2));
    thumb.style.left = newLeft + 'px';
    if ((newLeft - 2) / maxL >= THRESHOLD) track.classList.add('triggered');
    else track.classList.remove('triggered');
  }

  function onEnd(): void {
    if (!dragging) return;
    dragging = false;
    thumb.classList.remove('dragging');
    const maxL = getMaxLeft();
    const pos = (parseInt(thumb.style.left) - 2) / maxL;
    if (pos >= THRESHOLD) {
      const botId = getCurrentBotId();
      _pendingResetBotId = botId;
      ws.send({ type: 'new_session', botId });
      showToast(getBotNames()[botId] + ' ' + t('toast.reset_request_sent'));
      track.classList.add('triggered');
      thumb.style.left = (maxL + 2) + 'px';
      thumb.classList.add('spinning');
      if (resetTimeout) clearTimeout(resetTimeout);
      resetTimeout = setTimeout(() => {
        if (thumb.classList.contains('spinning')) {
          thumb.classList.remove('spinning');
          track.classList.remove('triggered');
          thumb.style.left = '2px';
        }
      }, 10000);
    } else {
      thumb.style.left = '2px';
      track.classList.remove('triggered');
    }
  }

  resetSliderComplete = () => {
    if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
    _pendingResetBotId = null;
    thumb.classList.remove('spinning');
    track.classList.remove('triggered');
    thumb.style.left = '2px';
  };

  resetSliderFailed = () => {
    if (resetTimeout) { clearTimeout(resetTimeout); resetTimeout = null; }
    _pendingResetBotId = null;
    thumb.classList.remove('spinning');
    track.classList.remove('triggered');
    thumb.style.left = '2px';
  };

  thumb.addEventListener('mousedown', onStart);
  thumb.addEventListener('touchstart', onStart, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onEnd);
  window.addEventListener('touchend', onEnd);
}

export function onResetConfirmed(botId: string): void {
  if (_pendingResetBotId === botId) resetSliderComplete?.();
}
export function onResetFailed(botId: string): void {
  if (_pendingResetBotId === botId) resetSliderFailed?.();
}
export function notifyBotSwitched(newBotId: string): void {
  if (_pendingResetBotId !== null && _pendingResetBotId !== newBotId) {
    resetSliderComplete?.();
  }
}
