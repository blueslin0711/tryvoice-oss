// Text reply composer — text input, image attachment, mobile menu

import { t } from '../i18n';
import { createLogger } from '../logging/logger';
import { getCurrentBotId, interruptBot, showToast } from './app-state';
import { sendTextPayload } from './chat-renderer';
import { handlePopupKeydown, initSlashPopup, isPopupOpen } from './slash-popup';
import { showUserInputCard } from './user-input-card';
import * as ws from '../network/ws-client';

const log = createLogger('ui.text-composer');

// DOM refs
const textReplyInput = document.getElementById('text-reply-input') as HTMLTextAreaElement | null;
const textReplySendBtn = document.getElementById('text-reply-send') as HTMLButtonElement | null;
const textReplyImageBtn = document.getElementById('text-reply-image-btn') as HTMLButtonElement | null;
const textReplyImageInput = document.getElementById('text-reply-image-input') as HTMLInputElement | null;
const textReplyAttachmentStrip = document.getElementById('text-reply-attachment-strip') as HTMLDivElement | null;
const textReplyAttachmentThumb = document.getElementById('text-reply-attachment-thumb') as HTMLImageElement | null;
const textReplyAttachmentName = document.getElementById('text-reply-attachment-name') as HTMLDivElement | null;
const textReplyAttachmentHint = document.getElementById('text-reply-attachment-hint') as HTMLDivElement | null;
const textReplyAttachmentRemoveBtn = document.getElementById('text-reply-attachment-remove') as HTMLButtonElement | null;
const menuToggle = document.getElementById('menu-toggle') as HTMLButtonElement | null;
const menuPanel = document.getElementById('menu-panel') as HTMLDivElement | null;
const menuAutoReadBtn = document.getElementById('menu-auto-read-btn') as HTMLButtonElement | null;
const menuHistoryBtn = document.getElementById('menu-history-btn') as HTMLButtonElement | null;
const menuImageBtn = document.getElementById('menu-image-btn') as HTMLButtonElement | null;
const menuSettingsBtn = document.getElementById('menu-settings-btn') as HTMLButtonElement | null;
const historySearchToggle = document.getElementById('history-search-toggle') as HTMLButtonElement | null;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement | null;
const autoReadToggle = document.getElementById('auto-read-toggle');

type PendingImageAttachment = {
  mediaPath: string;
  previewUrl: string;
  name: string;
  size: number;
};

let _pendingImageAttachment: PendingImageAttachment | null = null;
let _pendingImageUpload = false;

// --- Per-bot draft cache (persisted to localStorage) ---
const DRAFT_STORAGE_KEY = 'vs:input-drafts';

function _loadDrafts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}');
  } catch { return {}; }
}

function _saveDraft(botId: string, text: string): void {
  const drafts = _loadDrafts();
  if (text) drafts[botId] = text;
  else delete drafts[botId];
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts)); } catch { /* quota */ }
}

function _restoreDraft(botId: string): void {
  if (!textReplyInput) return;
  const drafts = _loadDrafts();
  textReplyInput.value = drafts[botId] || '';
  _resizeTextReplyInput();
}

function _clearDraft(botId: string): void {
  _saveDraft(botId, '');
}

function _formatBytes(bytes: number): string {
  const b = Number(bytes || 0);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function _resizeTextReplyInput(): void {
  if (!textReplyInput) return;
  textReplyInput.style.height = 'auto';
  const next = Math.min(120, Math.max(34, textReplyInput.scrollHeight));
  textReplyInput.style.height = next + 'px';
}

function _setImageUploadUi(uploading: boolean): void {
  if (!textReplyImageBtn) return;
  textReplyImageBtn.disabled = uploading;
  textReplyImageBtn.innerHTML = uploading ? '...' : '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
}

function _renderPendingImageAttachment(): void {
  const has = !!_pendingImageAttachment;
  if (textReplyAttachmentStrip) {
    textReplyAttachmentStrip.classList.toggle('show', has);
    textReplyAttachmentStrip.hidden = !has;
  }
  if (textReplyImageBtn) {
    textReplyImageBtn.classList.toggle('active', has);
    textReplyImageBtn.title = has ? t('image.attached_replace') : t('image.upload');
  }
  if (!has || !_pendingImageAttachment) return;

  if (textReplyAttachmentThumb) {
    textReplyAttachmentThumb.src = _pendingImageAttachment.previewUrl;
    textReplyAttachmentThumb.alt = _pendingImageAttachment.name || t('image.preview_alt');
  }
  if (textReplyAttachmentName) {
    textReplyAttachmentName.textContent = _pendingImageAttachment.name || 'image';
  }
  if (textReplyAttachmentHint) {
    const sz = _formatBytes(_pendingImageAttachment.size);
    textReplyAttachmentHint.textContent = sz ? t('image.send_with_text') + ' · ' + sz : t('image.send_with_text');
  }
}

function _clearPendingImageAttachment(): void {
  if (_pendingImageAttachment?.previewUrl) {
    try { URL.revokeObjectURL(_pendingImageAttachment.previewUrl); } catch (_e) { /* ignore */ }
  }
  _pendingImageAttachment = null;
  _renderPendingImageAttachment();
}

async function _uploadImageAttachment(file: File): Promise<{ mediaPath: string; name: string; size: number }> {
  if (!file.type.startsWith('image/')) {
    throw new Error(t('image.only_images'));
  }
  const fd = new FormData();
  fd.append('file', file, file.name || 'image');
  const resp = await fetch('/media/upload', {
    method: 'POST',
    body: fd,
  });
  let data: Record<string, unknown> = {};
  try { data = await resp.json(); } catch (_e) { /* ignore */ }
  if (!resp.ok || !data.ok || !data.path) {
    const err = String(data.error || t('image.upload_failed'));
    throw new Error(err);
  }
  return {
    mediaPath: String(data.path),
    name: String(data.name || file.name || 'image'),
    size: Number(data.size || file.size || 0),
  };
}

function _handleSlashCommand(text: string): boolean {
  const botId = getCurrentBotId();
  if (!botId) return false;

  const cmd = text.toLowerCase().split(/\s+/)[0];

  switch (cmd) {
    case '/clear': {
      // Reuse existing new_session flow (same as slide-reset)
      ws.send({ type: 'new_session', botId });
      log.info('Slash command: /clear', { botId });
      return true;
    }
    case '/new': {
      ws.send({ type: 'new_session', botId });
      log.info('Slash command: /new', { botId });
      return true;
    }
    case '/compact': {
      ws.send({ type: 'compact_session', botId });
      log.info('Slash command: /compact', { botId });
      return true;
    }
    case '/model': {
      // Show model selector via user-input-card; reply handled by backend
      showUserInputCard(botId, {
        kind: 'ask_user',
        questions: [{
          question: 'Select model',
          header: '/model',
          options: [
            { label: 'claude-sonnet-4-6', description: 'Fast, balanced' },
            { label: 'claude-opus-4-6', description: 'Most capable' },
            { label: 'claude-haiku-4-5', description: 'Fastest, lightweight' },
          ],
          multiSelect: false,
        }],
        eventKey: `slash-model-${Date.now()}`,
      });
      log.info('Slash command: /model selector shown', { botId });
      return true;
    }
    case '/effort': {
      showUserInputCard(botId, {
        kind: 'ask_user',
        questions: [{
          question: 'Select thinking effort',
          header: '/effort',
          options: [
            { label: 'high', description: 'Maximum reasoning depth' },
            { label: 'medium', description: 'Balanced speed/quality' },
            { label: 'low', description: 'Fast responses' },
          ],
          multiSelect: false,
        }],
        eventKey: `slash-effort-${Date.now()}`,
      });
      log.info('Slash command: /effort selector shown', { botId });
      return true;
    }
    default:
      // Unknown slash command — send as regular text
      return false;
  }
}

function _sendTextComposerPayload(): void {
  if (_pendingImageUpload) {
    showToast(t('toast.image_uploading'));
    return;
  }

  const text = (textReplyInput?.value || '').trim();
  if (_pendingImageAttachment) {
    const prompt = text || t('image.default_prompt');
    const payload = `[media attached: ${_pendingImageAttachment.mediaPath}]\n${prompt}`;
    const display = text ? `🖼️ ${text}` : t('image.label');
    sendTextPayload(payload, display);
    _clearPendingImageAttachment();
    _clearDraft(getCurrentBotId());
    _resizeTextReplyInput();
    return;
  }

  if (!text) return;

  // Slash command interception
  if (text.startsWith('/')) {
    const handled = _handleSlashCommand(text);
    if (handled) {
      textReplyInput!.value = '';
      _clearDraft(getCurrentBotId());
      _resizeTextReplyInput();
      return;
    }
  }

  sendTextPayload(text, text);
  _clearDraft(getCurrentBotId());
  _resizeTextReplyInput();
}

function _syncMenuAutoReadState(): void {
  if (!menuAutoReadBtn || !autoReadToggle) return;
  menuAutoReadBtn.classList.toggle('active', autoReadToggle.classList.contains('active'));
  menuAutoReadBtn.classList.toggle('off', autoReadToggle.classList.contains('off'));
}

function _setMenuOpen(open: boolean): void {
  const next = !!open;
  document.body.classList.toggle('menu-open', next);
  menuToggle?.setAttribute('aria-expanded', next ? 'true' : 'false');
  menuPanel?.setAttribute('aria-hidden', next ? 'false' : 'true');
  if (next) _syncMenuAutoReadState();
}

export function syncMenuAutoReadState(): void {
  _syncMenuAutoReadState();
}

export function initTextComposer(): void {
  textReplySendBtn?.addEventListener('click', () => {
    _sendTextComposerPayload();
  });

  // Slash command autocomplete popup
  if (textReplyInput) {
    initSlashPopup(textReplyInput, (cmd) => {
      const handled = _handleSlashCommand(cmd);
      if (!handled) {
        // Unknown command — send as text
        sendTextPayload(cmd, cmd);
      }
      _clearDraft(getCurrentBotId());
      _resizeTextReplyInput();
    });
  }
  textReplyInput?.addEventListener('keydown', (e) => {
    // Slash popup intercepts arrow keys, Enter, Escape, Tab when open
    if (handlePopupKeydown(e)) return;

    // ESC → interrupt current bot processing
    if (e.key === 'Escape') {
      const botId = getCurrentBotId();
      if (botId) {
        interruptBot(botId, 'cancelled');
      }
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    // During IME composition (e.g. Chinese input), let Enter confirm
    // the candidate text instead of sending the message (Telegram-style).
    if (e.isComposing) return;
    e.preventDefault();
    _sendTextComposerPayload();
  });
  textReplyInput?.addEventListener('input', () => {
    _resizeTextReplyInput();
    _saveDraft(getCurrentBotId(), textReplyInput!.value);
  });
  _restoreDraft(getCurrentBotId());
  _renderPendingImageAttachment();

  // Mobile: expand input box on focus, hide secondary buttons
  textReplyInput?.addEventListener('focus', () => {
    document.body.classList.add('input-focused');
    _setMenuOpen(false);
  });
  textReplyInput?.addEventListener('blur', () => {
    document.body.classList.remove('input-focused');
  });

  textReplyImageBtn?.addEventListener('click', () => {
    textReplyImageInput?.click();
  });
  textReplyImageInput?.addEventListener('change', async () => {
    const file = textReplyImageInput!.files?.[0];
    textReplyImageInput!.value = '';
    if (!file) return;
    _pendingImageUpload = true;
    _setImageUploadUi(true);
    const previewUrl = URL.createObjectURL(file);
    try {
      const uploaded = await _uploadImageAttachment(file);
      _clearPendingImageAttachment();
      _pendingImageAttachment = {
        ...uploaded,
        previewUrl,
      };
      _renderPendingImageAttachment();
      _resizeTextReplyInput();
      showToast(t('toast.image_attached'));
    } catch (e) {
      try { URL.revokeObjectURL(previewUrl); } catch (_e) { /* ignore */ }
      showToast(t('toast.image_send_failed') + String((e as Error).message || e));
    } finally {
      _pendingImageUpload = false;
      _setImageUploadUi(false);
    }
  });
  textReplyAttachmentRemoveBtn?.addEventListener('click', () => {
    _clearPendingImageAttachment();
    showToast(t('toast.image_removed'));
  });

  // Paste image support
  textReplyInput?.addEventListener('paste', async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItem = items.find(item => item.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    _pendingImageUpload = true;
    _setImageUploadUi(true);
    const previewUrl = URL.createObjectURL(file);
    try {
      const uploaded = await _uploadImageAttachment(file);
      _clearPendingImageAttachment();
      _pendingImageAttachment = { ...uploaded, previewUrl };
      _renderPendingImageAttachment();
      _resizeTextReplyInput();
      showToast(t('toast.image_attached'));
    } catch (e) {
      try { URL.revokeObjectURL(previewUrl); } catch (_e) { /* ignore */ }
      showToast(t('toast.image_send_failed') + String((e as Error).message || e));
    } finally {
      _pendingImageUpload = false;
      _setImageUploadUi(false);
    }
  });
}

/** Call from switchToBot BEFORE setCurrentBotId so oldBotId is still current. */
export function switchComposerDraft(oldBotId: string, newBotId: string): void {
  _saveDraft(oldBotId, textReplyInput?.value || '');
  _restoreDraft(newBotId);
}

export function initMobileMenu(): void {
  menuToggle?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    _setMenuOpen(!document.body.classList.contains('menu-open'));
  });
  menuPanel?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  menuAutoReadBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    autoReadToggle?.click();
    _syncMenuAutoReadState();
  });
  menuHistoryBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    historySearchToggle?.click();
    _setMenuOpen(false);
  });
  menuSettingsBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    settingsBtn?.click();
    _setMenuOpen(false);
  });
  document.addEventListener('click', () => _setMenuOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // If menu is open, close it; otherwise interrupt bot
      if (document.body.classList.contains('menu-open')) {
        _setMenuOpen(false);
      }
      // Bot interrupt is handled by the text input's keydown handler
    }
  });
  _syncMenuAutoReadState();
}
