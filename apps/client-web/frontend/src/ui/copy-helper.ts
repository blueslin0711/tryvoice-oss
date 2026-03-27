// Copy helper — works on self-signed HTTPS / iOS
// Ported from app.js copy overlay section

import { showToast } from './app-state';
import { t } from '../i18n';

const copyOverlay = document.getElementById('copy-overlay');
const copyTextarea = document.getElementById('copy-textarea') as HTMLTextAreaElement | null;
const copyDoBtn = document.getElementById('copy-do');
const copyCloseBtn = document.getElementById('copy-close');

function openCopyOverlay(text: string): void {
  if (!copyOverlay || !copyTextarea) return;
  copyTextarea.value = text;
  copyOverlay.style.display = 'flex';
  setTimeout(() => {
    copyTextarea.focus();
    copyTextarea.select();
  }, 50);
}

function closeCopyOverlay(): void {
  if (copyOverlay) copyOverlay.style.display = 'none';
}

function fallbackCopyOnce(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:none;outline:none;opacity:0;-webkit-user-select:text;user-select:text';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (_e) {
    return false;
  }
}

export function copyText(text: string): void {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text)
      .then(() => showToast(t('toast.copied')))
      .catch(() => { openCopyOverlay(text); showToast(t('toast.copy_panel_opened')); });
  } else {
    const ok = fallbackCopyOnce(text);
    if (!ok) { openCopyOverlay(text); showToast(t('toast.copy_panel_opened')); }
    else showToast(t('toast.copied'));
  }
}

export function initCopyHelper(): void {
  if (copyCloseBtn) copyCloseBtn.addEventListener('click', closeCopyOverlay);
  if (copyOverlay) {
    copyOverlay.addEventListener('click', (e) => {
      if (e.target === copyOverlay) closeCopyOverlay();
    });
  }
  if (copyDoBtn) {
    copyDoBtn.addEventListener('click', () => {
      const text = copyTextarea?.value || '';
      if (!text) return;
      const ok = fallbackCopyOnce(text);
      if (ok) { showToast(t('toast.copied')); closeCopyOverlay(); }
      else showToast(t('toast.long_press_to_copy'));
    });
  }
}

// Desktop double-click to select message text
export function initDesktopCopy(transcript: HTMLElement): void {
  transcript.addEventListener('dblclick', (e) => {
    const isDesktop = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
    if (!isDesktop) return;
    if ((e.target as HTMLElement).closest('.play-btn')) return;
    const msg = (e.target as HTMLElement).closest('.msg');
    if (!msg) return;
    const textEl = msg.querySelector('.msg-text');
    if (!textEl) return;
    const sel = window.getSelection?.();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(textEl);
    sel.removeAllRanges();
    sel.addRange(range);
    showToast(t('toast.text_selected_cmd_c'));
  });
}
