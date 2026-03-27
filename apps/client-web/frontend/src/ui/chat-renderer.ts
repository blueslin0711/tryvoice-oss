// Chat rendering — message list, markdown, scroll, streaming
import { createLogger } from '../logging/logger';
import { marked } from 'marked';

const _log = createLogger('ui.chat-renderer');
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json_lang from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css_lang from 'highlight.js/lib/languages/css';
import 'highlight.js/styles/github-dark.css';

import { t } from '../i18n';
import { bus } from '../core/event-bus';
import { chatStore } from '../store/chat-store';
import { audioPlayer } from '../audio/audio-player';
import { cleanForTTS, chunkForTTS } from '../audio/tts-cleaner';
import { BOT_IDS, STORAGE_KEY } from '../core/types';
import type { BotId, ScrollOwnership } from '../core/types';
import { getCurrentBotId, getBotNames, getUnreadCount, setUnreadCount, getBotStatus, setBotStatus, getBotStreamState, setBotStreamState, isAutoReadEnabled, showToast, getInputMode, interruptBot, shouldIncludeMsg, getGranularity, getBotSeenCount, setBotSeenCount, markTextRead } from './app-state';
import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import * as ws from '../network/ws-client';
import { outbox } from '../network/outbox';
import { syncManager } from '../network/sync';

// Register highlight.js languages
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('json', json_lang);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css_lang);

// Configure marked with custom code renderer
const _renderer = new marked.Renderer();
_renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value;
  const langLabel = language || 'code';
  return `<div class="code-block-wrap">
    <div class="code-block-header">
      <span class="code-lang">${langLabel}</span>
      <button class="code-copy-btn" title="${t('chat.copy_btn_title')}">${t('chat.copy_code')}</button>
    </div>
    <pre><code class="hljs${language ? ' language-' + language : ''}">${highlighted}</code></pre>
  </div>`;
};
_renderer.link = ({ href, title, text }: { href: string; title?: string | null; text: string }) => {
  const titleAttr = title ? ` title="${title}"` : '';
  return `<a href="${href}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
};
marked.use({ renderer: _renderer });
marked.setOptions({ breaks: true, gfm: true });

// DOM references
let transcript: HTMLElement;
let statusEl: HTMLElement;
let _scrollBottomFab: HTMLButtonElement | null = null;
let _backToLatestFab: HTMLButtonElement | null = null;

// Scroll-up loading state
let _isLoadingOlder = false;
let _scrollUpCheckTimer: ReturnType<typeof setTimeout> | null = null;

// Track whether user has actively scrolled this session.
// Until user scrolls, force renderChat to scroll-to-bottom (counteracts
// browser scroll restoration on page refresh).
let _userHasScrolledThisSession = false;

// Per-bot scroll position persistence (ISSUE-11b)
const _SCROLL_KEY_PREFIX = STORAGE_KEY + 'scrollPos_';

/** Save scroll position for a bot to localStorage. */
export function saveScrollPosition(botId: string): void {
  const el = transcript || document.getElementById('transcript');
  if (!el) return;
  try {
    localStorage.setItem(_SCROLL_KEY_PREFIX + botId, String(el.scrollTop));
  } catch (_e) { /* quota exceeded */ }
}

/** Restore scroll position for a bot from localStorage. Returns true if restored. */
export function restoreScrollPosition(botId: string): boolean {
  const el = transcript || document.getElementById('transcript');
  if (!el) return false;
  try {
    const saved = localStorage.getItem(_SCROLL_KEY_PREFIX + botId);
    if (saved !== null) {
      el.scrollTop = Number(saved);
      // Mark as user-scrolled so the rAF fallback in renderChat doesn't
      // override the restored position with scrollToBottom (ISSUE-11b/20).
      _userHasScrolledThisSession = true;
      return true;
    }
  } catch (_e) { /* ignore */ }
  return false;
}

/**
 * Scroll to the first unread message (serverSeq > lastReadSeq), positioned
 * at approximately 1/3 from the top of the viewport (PI-02).
 * Returns true if an unread message was found and scrolled to.
 */
export function scrollToFirstUnread(lastReadSeq: number): boolean {
  const el = transcript || document.getElementById('transcript');
  if (!el) return false;
  const msgEls = el.querySelectorAll('.msg[data-server-seq]');
  let target: HTMLElement | null = null;
  for (const node of msgEls) {
    const msgEl = node as HTMLElement;
    const seq = Number(msgEl.dataset.serverSeq);
    if (seq > lastReadSeq) {
      target = msgEl;
      break;
    }
  }
  if (!target) return false;
  // Position the first unread message at ~1/3 from the top of the viewport
  const viewportHeight = el.clientHeight;
  const targetOffset = target.offsetTop;
  el.scrollTop = Math.max(0, targetOffset - Math.round(viewportHeight / 3));
  _userHasScrolledThisSession = true;
  return true;
}

/** Reset scroll tracking so next renderChat scrolls to bottom (e.g. bfcache restore, bot switch). */
export function resetScrollSession(): void {
  _userHasScrolledThisSession = false;
  // Clear any pending scroll-ownership timer from the previous bot so it
  // doesn't fire after the switch and scroll to a stale reading element.
  if (_scrollOwnershipTimer) { clearTimeout(_scrollOwnershipTimer); _scrollOwnershipTimer = null; }
  _scrollOwnership = 'AUTO';
}


export function initChatRenderer(): void {
  transcript = document.getElementById('transcript')!;
  statusEl = document.getElementById('status')!;
  _ensureScrollBottomFab();
  _ensureBackToLatestFab();

  // Detect real user scroll (wheel/touchmove only fire on user interaction,
  // NOT on programmatic scrollTop assignment). Once the user scrolls, normal
  // _isNearBottom logic takes over.
  const _markUserScrolled = () => {
    _userHasScrolledThisSession = true;
    // Persist scroll position on user scroll (ISSUE-11b)
    saveScrollPosition(getCurrentBotId());
  };
  transcript.addEventListener('wheel', _markUserScrolled, { passive: true });
  transcript.addEventListener('touchmove', _markUserScrolled, { passive: true });

  // Delegated click handler for inline play buttons
  transcript.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.play-btn') as HTMLElement | null;
    if (!btn) return;
    e.stopPropagation();
    const msgEl = btn.closest('.msg.assistant') as HTMLElement | null;
    if (!msgEl) return;
    if (audioPlayer.state === 'playing') {
      interruptBot(getCurrentBotId(), 'stopped_reading');
    } else {
      // Immediate visual feedback before TTS loads
      btn.classList.add('loading');
      btn.textContent = '\u23F8'; // pause icon
      msgEl.classList.add('reading');
      startChunkedReadFromMessage(msgEl);
    }
  });

  // Scroll ownership detection — fires on ANY user scroll (not just during TTS)
  // so the 30s MANUAL→AUTO recovery timer always starts (SC-G-04).
  setTimeout(() => {
    transcript.addEventListener('touchstart', () => {
      _onUserScroll();
    }, { passive: true });
    transcript.addEventListener('wheel', () => {
      _onUserScroll();
    }, { passive: true });
    transcript.addEventListener('scroll', () => {
      if (_isNearBottom(transcript)) _hideNewMsgIndicator();
      _updateScrollBottomFab();
      // Debounced scroll-up check for loading older messages
      if (_scrollUpCheckTimer) clearTimeout(_scrollUpCheckTimer);
      _scrollUpCheckTimer = setTimeout(_checkScrollUp, 150);
    });
  }, 500);

  // ISSUE-23: Auto-scroll to bottom when async content (images, KaTeX, lazy
  // messages) changes the scroll height after initial render.
  let _prevScrollHeight = transcript.scrollHeight;
  const resizeObs = new ResizeObserver(() => {
    if (!transcript) return;
    const newHeight = transcript.scrollHeight;
    if (newHeight > _prevScrollHeight) {
      if (!_userHasScrolledThisSession || _isNearBottom(transcript)) {
        _scrollToBottom(transcript);
      }
    }
    _prevScrollHeight = newHeight;
  });
  // Observe the transcript's direct children so we detect content size changes
  for (const child of transcript.children) {
    resizeObs.observe(child);
  }
  // Also observe future children via MutationObserver
  const mutObs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement) resizeObs.observe(node);
      }
    }
    // Immediately check height after DOM mutations (covers text-only changes)
    if (!transcript) return;
    const newHeight = transcript.scrollHeight;
    if (newHeight > _prevScrollHeight) {
      if (!_userHasScrolledThisSession || _isNearBottom(transcript)) {
        _scrollToBottom(transcript);
      }
    }
    _prevScrollHeight = newHeight;
  });
  mutObs.observe(transcript, { childList: true, subtree: true });
}

// --- Scroll ownership ---
let _scrollOwnership: ScrollOwnership = 'AUTO';
let _scrollOwnershipTimer: ReturnType<typeof setTimeout> | null = null;
const SCROLL_MANUAL_TIMEOUT_MS = 30000;

function _setScrollOwnership(mode: ScrollOwnership): void {
  _scrollOwnership = mode;
  _updateScrollOwnershipUI();
}

function _onUserScroll(): void {
  if (_scrollOwnership !== 'MANUAL') _setScrollOwnership('MANUAL');
  if (_scrollOwnershipTimer) clearTimeout(_scrollOwnershipTimer);
  _scrollOwnershipTimer = setTimeout(() => {
    _setScrollOwnership('AUTO');
    if (audioPlayer.state === 'playing') {
      const readingEl = transcript.querySelector('.msg.reading');
      if (readingEl) readingEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, SCROLL_MANUAL_TIMEOUT_MS);
}

function _updateScrollOwnershipUI(): void {
  let indicator = document.getElementById('scroll-ownership-indicator');
  const isPlaying = audioPlayer.state === 'playing';
  if (_scrollOwnership === 'MANUAL' && isPlaying) {
    if (!indicator) {
      indicator = document.createElement('button');
      indicator.id = 'scroll-ownership-indicator';
      indicator.style.cssText = 'position:fixed;bottom:120px;right:20px;z-index:200;background:rgba(91,110,174,0.95);color:#fff;border:none;border-radius:20px;padding:8px 16px;font-size:13px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,0.35);transition:opacity 0.2s;-webkit-tap-highlight-color:transparent;';
      indicator.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        _setScrollOwnership('AUTO');
        if (_scrollOwnershipTimer) clearTimeout(_scrollOwnershipTimer);
        const readingEl = transcript.querySelector('.msg.reading');
        if (readingEl) readingEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      document.body.appendChild(indicator);
    }
    indicator.textContent = t('chat.scroll_to_reading');
    indicator.style.display = 'block';
  } else {
    if (indicator) indicator.style.display = 'none';
  }
}

// --- Scroll to reading element (called from event-wiring on TTS start) ---
function _isElementVisible(el: Element, container: HTMLElement): boolean {
  const elRect = el.getBoundingClientRect();
  const cRect = container.getBoundingClientRect();
  return elRect.bottom > cRect.top && elRect.top < cRect.bottom;
}

export function scrollToReadingIfNeeded(): void {
  if (!transcript) return;
  // Prefer block-level element for finer scroll tracking within long messages
  const scrollTarget = transcript.querySelector('mark.tts-reading') || transcript.querySelector('.msg.reading');
  if (!scrollTarget) return;
  // AUTO mode: always track
  // MANUAL mode: only track if the reading element is currently visible
  if (_scrollOwnership === 'AUTO' || _isElementVisible(scrollTarget, transcript)) {
    scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// --- New message indicator ---
let _unreadNewCount = 0;

function _isNearBottom(el: HTMLElement, threshold = 150): boolean {
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < threshold;
}

function _isFarFromBottom(el: HTMLElement): boolean {
  return (el.scrollHeight - el.scrollTop - el.clientHeight) > Math.max(260, Math.round(el.clientHeight * 0.75));
}

function _scrollToBottom(el: HTMLElement, smooth = false): void {
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

function _ensureScrollBottomFab(): void {
  if (_scrollBottomFab || !transcript?.parentElement) return;
  const btn = document.createElement('button');
  btn.id = 'scroll-bottom-fab';
  btn.type = 'button';
  btn.textContent = '↓';
  btn.title = t('chat.scroll_to_bottom_title');
  btn.style.display = 'none';
  btn.addEventListener('click', () => {
    _scrollToBottom(transcript, true);
    _hideNewMsgIndicator();
    _updateScrollBottomFab();
  });
  transcript.parentElement.style.position = 'relative';
  transcript.parentElement.appendChild(btn);
  _scrollBottomFab = btn;
}

function _updateScrollBottomFab(): void {
  if (!_scrollBottomFab || !transcript) return;
  const show = _isFarFromBottom(transcript);
  _scrollBottomFab.style.display = show ? 'inline-flex' : 'none';
}

// --- Scroll-up loading for older messages ---
function _checkScrollUp(): void {
  if (!transcript || _isLoadingOlder) return;

  const { scrollTop, clientHeight } = transcript;
  const threshold = clientHeight * 3;

  if (scrollTop < threshold) {
    const botId = getCurrentBotId();
    const vp = chatStore.getViewport(botId);
    if (!vp.hasMore) return;

    _isLoadingOlder = true;
    _showLoadingSpinner(true);
    const prevScrollHeight = transcript.scrollHeight;

    syncManager.loadOlderMessages(botId).then(({ loaded }) => {
      if (loaded > 0) {
        renderChat(botId);
        // Preserve scroll position after prepending older messages
        const newScrollHeight = transcript.scrollHeight;
        transcript.scrollTop = scrollTop + (newScrollHeight - prevScrollHeight);
      }
      _showLoadingSpinner(false);
      _isLoadingOlder = false;
    });
  }
}

function _showLoadingSpinner(show: boolean): void {
  let spinner = document.getElementById('history-load-spinner');
  if (show && !spinner) {
    spinner = document.createElement('div');
    spinner.id = 'history-load-spinner';
    spinner.className = 'history-load-spinner';
    spinner.textContent = '...';
    if (transcript) transcript.prepend(spinner);
  } else if (!show && spinner) {
    spinner.remove();
  }
}

// --- "Back to latest" button ---
function _ensureBackToLatestFab(): void {
  if (_backToLatestFab || !transcript?.parentElement) return;
  const btn = document.createElement('button');
  btn.id = 'back-to-latest-fab';
  btn.type = 'button';
  btn.className = 'back-to-latest';
  btn.textContent = '\u2193 Back to latest';
  btn.style.display = 'none';
  btn.addEventListener('click', () => {
    const botId = getCurrentBotId();
    chatStore.returnToLatest(botId);
    renderChat(botId);
    _scrollToBottom(transcript);
  });
  document.body.appendChild(btn);
  _backToLatestFab = btn;
}

function _updateBackToLatestFab(): void {
  if (!_backToLatestFab) return;
  const botId = getCurrentBotId();
  const vp = chatStore.getViewport(botId);
  _backToLatestFab.style.display = vp.mode === 'history' ? 'block' : 'none';
}

function _showNewMsgIndicator(count: number): void {
  _unreadNewCount = count;
  let btn = document.getElementById('new-msg-indicator');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'new-msg-indicator';
    btn.style.cssText = 'position:absolute;bottom:90px;left:50%;transform:translateX(-50%);z-index:100;background:#5b6eae;color:#fff;border:none;border-radius:20px;padding:6px 16px;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3);transition:opacity 0.2s;';
    btn.addEventListener('click', () => {
      _scrollToBottom(transcript, true);
      _hideNewMsgIndicator();
    });
    transcript.parentElement!.style.position = 'relative';
    transcript.parentElement!.appendChild(btn);
  }
  btn.textContent = t('chat.new_messages', { count });
  btn.style.display = 'block';
}

function _hideNewMsgIndicator(): void {
  _unreadNewCount = 0;
  const btn = document.getElementById('new-msg-indicator');
  if (btn) btn.style.display = 'none';
}

// --- Helpers ---
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderLatex(html: string): string {
  // Block-level: $$...$$
  html = html.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
    try {
      const katex = (window as unknown as Record<string, unknown>).__katex as typeof import('katex');
      if (!katex) return `$$${tex}$$`;
      return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false });
    } catch { return `$$${tex}$$`; }
  });
  // Inline: $...$  (avoid matching currency like $10, $139/年, $99.50)
  html = html.replace(/(?<!\$)\$(?!\$)(?!\d)([^\s$](?:[^$]*[^\s$])?)\$(?!\$)/g, (_, tex) => {
    try {
      const katex = (window as unknown as Record<string, unknown>).__katex as typeof import('katex');
      if (!katex) return `$${tex}$`;
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false });
    } catch { return `$${tex}$`; }
  });
  return html;
}

// Lazy-load KaTeX
let _katexLoaded = false;
function ensureKatex(): void {
  if (_katexLoaded) return;
  _katexLoaded = true;
  import('katex').then((m) => {
    (window as unknown as Record<string, unknown>).__katex = m.default || m;
  }).catch(() => { /* KaTeX optional */ });
}

export function renderMd(text: string): string {
  ensureKatex();
  try {
    let html = marked.parse(text || '') as string;
    // Wrap tables in scrollable container
    html = html.replace(/<table>/g, '<div class="table-wrap"><table>');
    html = html.replace(/<\/table>/g, '</table></div>');
    return renderLatex(html);
  } catch (_e) { return escHtml(text || ''); }
}

function formatMsgTime(ts: string): string {
  if (!ts) return '';
  const raw = String(ts).trim();
  const d = /^\d{11,}$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isSessionStartMessage(role: string, text: string): boolean {
  if (role !== 'assistant') return false;
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  return t.startsWith('\u2705 new session started') || t.startsWith('new session started');
}

function createSessionDivider(ts?: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'session-divider';
  d.dataset.sessionStart = '1';
  const title = formatMsgTime(ts || '') || '';
  d.innerHTML = `<span>${title ? `\u5BF9\u8BDD\u5DF2\u91CD\u7F6E ${title}` : '\u5BF9\u8BDD\u5DF2\u91CD\u7F6E'}</span>`;
  return d;
}

const _deliveryLabels: Record<string, string> = { sending: t('chat.delivery.sending'), sent: t('chat.delivery.sent'), delivered: t('chat.delivery.delivered'), processing: t('chat.delivery.processing'), agent_processing: t('chat.delivery.agent_processing'), replied: t('chat.delivery.replied'), failed: t('chat.delivery.failed') };

// --- Context menu (singleton) ---
let _ctxMenu: HTMLElement | null = null;

function _getCtxMenu(): HTMLElement {
  if (!_ctxMenu) {
    _ctxMenu = document.createElement('div');
    _ctxMenu.className = 'msg-ctx-menu';
    document.body.appendChild(_ctxMenu);
    document.addEventListener('click', () => _hideCtxMenu());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _hideCtxMenu(); });
  }
  return _ctxMenu;
}

function _hideCtxMenu(): void {
  _ctxMenu?.classList.remove('visible');
}

function _showCtxMenu(x: number, y: number, role: string, msgEl: HTMLElement): void {
  const menu = _getCtxMenu();
  let html = `<button class="ctx-item ctx-copy">${t('chat.copy_btn_title')}</button>`;
  if (role === 'assistant') {
    html += `<button class="ctx-item ctx-play">${t('chat.play_btn_title')}</button>`;
    html += `<button class="ctx-item ctx-retry">${t('chat.retry_btn_title')}</button>`;
  }
  if (role === 'user') {
    html += `<button class="ctx-item ctx-edit">${t('chat.edit_btn_title')}</button>`;
  }
  menu.innerHTML = html;
  menu.classList.add('visible');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
  });
  menu.querySelector('.ctx-copy')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = msgEl.querySelector('.msg-text')?.textContent || '';
    bus.emit('ui:copy', text.trim());
    _hideCtxMenu();
  });
  if (role === 'assistant') {
    menu.querySelector('.ctx-play')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (audioPlayer.state === 'playing') {
        interruptBot(getCurrentBotId(), 'stopped_reading');
      } else {
        // Immediate visual feedback before TTS loads
        msgEl.classList.add('reading');
        const playBtn = msgEl.querySelector('.play-btn') as HTMLElement | null;
        if (playBtn) {
          playBtn.classList.add('loading');
          playBtn.textContent = '\u23F8';
        }
        startChunkedReadFromMessage(msgEl);
      }
      _hideCtxMenu();
    });
    menu.querySelector('.ctx-retry')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const allMsgs = Array.from(transcript.querySelectorAll('.msg'));
      const idx = allMsgs.indexOf(msgEl);
      for (let i = idx - 1; i >= 0; i--) {
        if (allMsgs[i].classList.contains('user')) {
          const userText = allMsgs[i].querySelector('.msg-text')?.textContent?.trim() || '';
          if (userText) sendTextPayload(userText);
          break;
        }
      }
      _hideCtxMenu();
    });
  }
  if (role === 'user') {
    menu.querySelector('.ctx-edit')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const msgText = msgEl.querySelector('.msg-text')?.textContent?.trim() || '';
      const input = document.getElementById('text-reply-input') as HTMLTextAreaElement | null;
      if (input && msgText) { input.value = msgText; input.focus(); }
      _hideCtxMenu();
    });
  }
}

/** Build the inline-meta span (float:right) that holds time + delivery status + optional play btn. */
function _createInlineMeta(timeText: string, deliveryClass: string, deliveryLabel: string, role?: string): HTMLElement {
  const meta = document.createElement('span');
  meta.className = 'msg-inline-meta';
  const delSpan = document.createElement('span');
  delSpan.className = `msg-delivery ${deliveryClass}`;
  delSpan.textContent = deliveryLabel;
  meta.appendChild(delSpan);
  // Inline play button for assistant messages (order: delivery → play → time)
  if (role === 'assistant') {
    const playBtn = document.createElement('span');
    playBtn.className = 'play-btn';
    playBtn.textContent = '\u25B6';
    playBtn.setAttribute('role', 'button');
    meta.appendChild(playBtn);
  }
  const timeSpan = document.createElement('span');
  timeSpan.className = 'msg-time';
  timeSpan.textContent = timeText;
  meta.appendChild(timeSpan);
  return meta;
}

/** Append meta into the last block child (e.g. last <p>) so the float appears on the last text line. */
function _injectInlineMeta(textEl: HTMLElement, metaEl: HTMLElement): void {
  const children = Array.from(textEl.children);
  const last = children[children.length - 1];
  // Inject into last <p> so float appears on the same visual line as the last paragraph
  if (last && last.tagName === 'P') {
    last.appendChild(metaEl);
  } else {
    textEl.appendChild(metaEl);
  }
}

export function createMsgEl(
  role: string,
  text: string,
  botId: string,
  ts?: string,
  status?: string,
  deliveryStatus?: string,
  eventKey?: string,
  clientMsgId?: string,
  sourceChannel?: string,
  serverSeq?: number | null,
  contentKind?: string,
): HTMLElement {
  const d = document.createElement('div');
  const isPending = status === 'pending' && (!deliveryStatus || deliveryStatus === 'sending');
  d.className = `msg msg-enter ${role}` + (isPending ? ' sending' : '') + (deliveryStatus === 'failed' ? ' send-failed' : '');
  d.addEventListener('animationend', () => d.classList.remove('msg-enter'), { once: true });
  if (eventKey) d.dataset.eventKey = eventKey;
  if (clientMsgId) d.dataset.clientMsgId = clientMsgId;
  if (serverSeq != null) d.dataset.serverSeq = String(serverSeq);
  if (contentKind && contentKind !== 'result') {
    d.classList.add(`msg-${contentKind}`);
    d.dataset.contentKind = contentKind;
  }
  const timeText = formatMsgTime(ts || '');
  const channelBadge = sourceChannel && sourceChannel !== 'web'
    ? `<span class="source-channel-badge">${{telegram:'via Telegram',slack:'via Slack'}[sourceChannel] || 'via '+sourceChannel}</span>`
    : '';
  const ds = deliveryStatus || '';
  const deliveryLbl = (role === 'user' && ds && ds !== 'replied') ? (_deliveryLabels[ds] || '') : '';
  if (role === 'user') {
    d.innerHTML = `${channelBadge}<div class="msg-text">${escHtml(text)}</div>`;
  } else {
    d.innerHTML = `${channelBadge}<div class="msg-text md-body">${renderMd(text)}</div>`;
  }
  // Inject content-kind label for non-result assistant messages
  if (contentKind && contentKind !== 'result' && role === 'assistant') {
    const labels: Record<string, string> = { intermediate: 'step', thinking: 'thinking', tool_call: 'tool' };
    const label = labels[contentKind];
    if (label) {
      const labelEl = document.createElement('span');
      labelEl.className = 'msg-kind-label';
      labelEl.textContent = label;
      d.querySelector('.msg-text')?.prepend(labelEl);
    }
    // Collapsible tool_call cards: default collapsed to 5 lines
    if (contentKind === 'tool_call') {
      const textEl = d.querySelector('.msg-text') as HTMLElement;
      if (textEl) {
        d.classList.add('tool-collapsed');
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'tool-toggle-btn';
        toggleBtn.textContent = '展开';
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const collapsed = d.classList.toggle('tool-collapsed');
          toggleBtn.textContent = collapsed ? '展开' : '收起';
        });
        textEl.after(toggleBtn);
      }
    }
  }
  // Inject inline time as float:right inside the text container
  if (timeText) {
    const metaEl = _createInlineMeta(timeText, ds, deliveryLbl, role);
    const textEl = d.querySelector('.msg-text') as HTMLElement;
    if (role === 'assistant') {
      _injectInlineMeta(textEl, metaEl);
    } else {
      textEl.appendChild(metaEl);
    }
  }

  // Code block copy buttons
  d.querySelectorAll<HTMLButtonElement>('.code-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const codeEl = btn.closest('.code-block-wrap')?.querySelector('code');
      const codeText = codeEl?.textContent || '';
      navigator.clipboard.writeText(codeText).then(() => {
        btn.textContent = t('chat.copied');
        setTimeout(() => { btn.textContent = t('chat.copy_code'); }, 1500);
      });
    });
  });

  // Right-click context menu
  d.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    _showCtxMenu(e.clientX, e.clientY, role, d);
  });

  return d;
}


// --- Render ---
let _renderChat_wasNearBottom = true;
let _renderChat_currentBotId = '';

/** Update an existing msg element's content in place (no remove/re-insert). */
function _updateMsgElInPlace(el: HTMLElement, m: { role: string; text: string; ttsText?: string; deliveryStatus?: string; status?: string }, botId: string): void {
  const textEl = el.querySelector('.msg-text') as HTMLElement | null;
  if (textEl) {
    // Save and remove existing inline meta before replacing content
    const existingMeta = el.querySelector('.msg-inline-meta') as HTMLElement | null;
    const savedTime = existingMeta?.querySelector('.msg-time')?.textContent || '';
    existingMeta?.remove();

    if (m.role === 'assistant') {
      textEl.innerHTML = renderMd(m.text);
      if (!textEl.classList.contains('md-body')) textEl.classList.add('md-body');
      if (savedTime) _injectInlineMeta(textEl, _createInlineMeta(savedTime, '', '', 'assistant'));
    } else {
      textEl.textContent = m.text;
      if (savedTime) {
        const ds = m.deliveryStatus || '';
        const lbl = ds ? (_deliveryLabels[ds] || '') : '';
        textEl.appendChild(_createInlineMeta(savedTime, ds, lbl));
      }
    }
  }
  if (m.role === 'assistant') {
    el.dataset.ttsText = m.ttsText || m.text;
  }
  if (m.role === 'user') {
    const ds = m.deliveryStatus || '';
    const isPending = m.status === 'pending' && (!ds || ds === 'sending');
    el.classList.toggle('sending', isPending);
    el.classList.toggle('send-failed', ds === 'failed');
    const statusSpan = el.querySelector('.msg-delivery') as HTMLElement | null;
    if (statusSpan) {
      statusSpan.className = `msg-delivery ${ds}`;
      statusSpan.textContent = ds ? (_deliveryLabels[ds] || '') : '';
    }
  }
}

/** Targeted delivery status update — no full re-render needed. */
export function updateDeliveryStatusDOM(botId: string, clientMsgId: string, deliveryStatus: string): void {
  if (botId !== getCurrentBotId()) return;
  const el = transcript.querySelector(`.msg[data-client-msg-id="${CSS.escape(clientMsgId)}"]`) as HTMLElement | null;
  if (!el) return;
  const isPending = deliveryStatus === 'sending';
  el.classList.toggle('sending', isPending);
  el.classList.toggle('send-failed', deliveryStatus === 'failed');
  let statusSpan = el.querySelector('.msg-delivery') as HTMLElement | null;
  if (!statusSpan) {
    // Dynamically create the span if it doesn't exist — insert before msg-time
    const meta = el.querySelector('.msg-inline-meta');
    if (meta) {
      statusSpan = document.createElement('span');
      const timeSpan = meta.querySelector('.msg-time');
      if (timeSpan) meta.insertBefore(statusSpan, timeSpan);
      else meta.appendChild(statusSpan);
    }
  }
  if (statusSpan) {
    statusSpan.className = `msg-delivery ${deliveryStatus}`;
    statusSpan.textContent = deliveryStatus ? (_deliveryLabels[deliveryStatus] || '') : '';
  }
}

function _shouldDisplayMsg(m: { intermediate?: boolean; contentKind?: string; text?: string }): boolean {
  return shouldIncludeMsg(m);
}

export function renderChat(botId: string): void {
  // When switching bots, check if we have a saved scroll position to restore.
  // If yes, don't force scroll-to-bottom — the caller (switchToBot) will
  // call restoreScrollPosition() after renderChat completes (ISSUE-11b/20).
  const isBotSwitch = _renderChat_currentBotId !== botId && _renderChat_currentBotId !== '';
  const hasSavedScroll = isBotSwitch && localStorage.getItem(_SCROLL_KEY_PREFIX + botId) !== null;
  // Until user actively scrolls, always scroll to bottom. This counteracts
  // browser scroll restoration which can reset scrollTop between renders.
  _renderChat_wasNearBottom = (isBotSwitch && !hasSavedScroll) || !_userHasScrolledThisSession || _isNearBottom(transcript);

  const msgs = chatStore.getMessages(botId).filter(_shouldDisplayMsg);
  // Debug: log last 3 messages with their serverSeq and _seq
  if (msgs.length > 0) {
    const tail = msgs.slice(-3).map(m => ({
      seq: m.serverSeq,
      _seq: m._seq,
      role: m.role,
      text: (m.text || '').slice(0, 40),
    }));
    _log.info('renderChat', { botId, total: msgs.length, tail });
  }

  // If switching bots, do a full clear — different bot's messages
  if (_renderChat_currentBotId !== botId) {
    _renderChat_currentBotId = botId;
    transcript.innerHTML = '';
  }

  // Build a lookup of existing DOM elements by eventKey, clientMsgId, and text
  const existingByKey = new Map<string, HTMLElement>();
  const existingByText = new Map<string, HTMLElement>();
  for (const child of Array.from(transcript.children)) {
    const el = child as HTMLElement;
    if (!el.classList?.contains('msg')) continue;
    const key = el.dataset?.eventKey;
    if (key) existingByKey.set(key, el);
    const cmid = el.dataset?.clientMsgId;
    if (cmid) existingByKey.set(`cmid:${cmid}`, el);
    // Text-based fallback index — handles eventKey changes from server sync
    const textContent = el.querySelector('.msg-text')?.textContent?.trim() || '';
    if (textContent) {
      const role = el.classList.contains('user') ? 'user' : 'assistant';
      existingByText.set(`${role}|${textContent}`, el);
    }
  }

  // Track all DOM elements that should exist after this render pass
  const keepEls = new Set<HTMLElement>();
  let lastAssistant: HTMLElement | null = null;
  let prevNode: Node | null = null;

  for (const m of msgs) {
    const key = m.eventKey || (m.clientMsgId ? `cmid:${m.clientMsgId}` : '');

    // Fallback: backend-driven session divider (for page-refresh with Claude Code bots)
    if (isSessionStartMessage(m.role, m.text)) {
      // Check if divider already exists right before this position
      const nextSibling: ChildNode | null = prevNode ? prevNode.nextSibling : transcript.firstChild;
      if (!nextSibling || !(nextSibling as HTMLElement).classList?.contains('session-divider')) {
        const divider = createSessionDivider(m.ts);
        if (nextSibling) {
          transcript.insertBefore(divider, nextSibling);
        } else {
          transcript.appendChild(divider);
        }
        prevNode = divider;
      } else {
        prevNode = nextSibling;
      }
    }

    // System/boundary messages — render as dividers or inline labels, not bubbles
    if (m.role === 'system') {
      const existingBoundary = key ? (transcript.querySelector(`[data-event-key="${CSS.escape(key)}"]`) as HTMLElement) : null;
      if (existingBoundary) {
        keepEls.add(existingBoundary);
        // Reposition if needed
        const expectedNext: ChildNode | null = prevNode ? prevNode.nextSibling : transcript.firstChild;
        if (existingBoundary !== expectedNext) {
          if (expectedNext) transcript.insertBefore(existingBoundary, expectedNext);
          else transcript.appendChild(existingBoundary);
        }
        prevNode = existingBoundary;
        continue;
      }
      const isCancel = m.text.includes('取消');
      const time = formatMsgTime(m.ts || '');
      if (isCancel) {
        // Inline label — small, right-aligned
        const label = document.createElement('div');
        label.className = 'boundary-inline-label';
        if (key) label.dataset.eventKey = key;
        if (m.serverSeq != null) label.dataset.serverSeq = String(m.serverSeq);
        label.textContent = `${m.text}${time ? ' ' + time : ''}`;
        const nextSibling: ChildNode | null = prevNode ? prevNode.nextSibling : transcript.firstChild;
        if (nextSibling) transcript.insertBefore(label, nextSibling);
        else transcript.appendChild(label);
        keepEls.add(label);
        prevNode = label;
      } else {
        // Full-width divider (reuse .session-divider styling)
        const d = document.createElement('div');
        d.className = 'session-divider';
        if (key) d.dataset.eventKey = key;
        if (m.serverSeq != null) d.dataset.serverSeq = String(m.serverSeq);
        d.innerHTML = `<span>${m.text}${time ? ' ' + time : ''}</span>`;
        const nextSibling: ChildNode | null = prevNode ? prevNode.nextSibling : transcript.firstChild;
        if (nextSibling) transcript.insertBefore(d, nextSibling);
        else transcript.appendChild(d);
        keepEls.add(d);
        prevNode = d;
      }
      continue;
    }

    // Look up existing DOM element by key, clientMsgId, or text content
    let el: HTMLElement | undefined;
    if (key) el = existingByKey.get(key);
    if (!el && m.clientMsgId) el = existingByKey.get(`cmid:${m.clientMsgId}`);
    // Text fallback: handles eventKey changes when server sync replaces local keys
    if (!el && m.text) {
      const candidate = existingByText.get(`${m.role}|${m.text.trim()}`);
      if (candidate && !keepEls.has(candidate)) el = candidate;
    }

    if (el) {
      keepEls.add(el);
      _updateMsgElInPlace(el, m, botId);
      // Sync data-event-key so future lookups use the canonical server key
      if (m.eventKey && el.dataset.eventKey !== m.eventKey) {
        el.dataset.eventKey = m.eventKey;
      }
      // Sync data-server-seq for search jump targeting
      if (m.serverSeq != null && !el.dataset.serverSeq) {
        el.dataset.serverSeq = String(m.serverSeq);
      }
      if (m.role === 'assistant') lastAssistant = el;
      // Reposition if not in correct place
      const expectedNext: ChildNode | null = prevNode ? prevNode.nextSibling : transcript.firstChild;
      if (el !== expectedNext) {
        if (expectedNext) {
          transcript.insertBefore(el, expectedNext);
        } else {
          transcript.appendChild(el);
        }
      }
      prevNode = el;
    } else {
      // New message — create and insert at correct position
      const d = createMsgEl(m.role, m.text, botId, m.ts, m.status, m.deliveryStatus, m.eventKey, m.clientMsgId, m.sourceChannel, m.serverSeq, m.contentKind);
      if (m.role === 'assistant') {
        d.dataset.ttsText = m.ttsText || m.text;
        lastAssistant = d;
      }
      keepEls.add(d);
      // Insert after prevNode
      const nextSibling: ChildNode | null = prevNode ? prevNode.nextSibling : transcript.firstChild;
      if (nextSibling) {
        transcript.insertBefore(d, nextSibling);
      } else {
        transcript.appendChild(d);
      }
      prevNode = d;
    }
  }

  // Remove orphan DOM elements (messages no longer in store)
  for (const child of Array.from(transcript.querySelectorAll('.msg'))) {
    if (!keepEls.has(child as HTMLElement)) {
      child.remove();
    }
  }

  bus.emit('chat:rendered', botId, lastAssistant);
  updatePlayButtons();
  if (_renderChat_wasNearBottom) {
    transcript.scrollTop = transcript.scrollHeight;
    _hideNewMsgIndicator();
  }
  // Deferred scroll-to-bottom: counteracts browser inner-element scroll restoration
  // on page refresh. history.scrollRestoration='manual' only prevents page-level
  // restoration, not nested scrollable elements like #transcript.
  if (!_userHasScrolledThisSession) {
    requestAnimationFrame(() => {
      if (!_userHasScrolledThisSession && transcript) {
        transcript.scrollTop = transcript.scrollHeight;
      }
    });
  }
  _updateScrollBottomFab();
  _updateBackToLatestFab();
}

export function addBotMsg(botId: string, role: string, text: string, extra?: Record<string, unknown>, persist = false): HTMLElement | null {
  const result = chatStore.addMessage(botId, role, text, extra as never, { persist, notify: false });
  if (!result) return null;
  const currentBotId = getCurrentBotId();

  if (result.isDuplicate) {
    if (botId === currentBotId) {
      // Update existing DOM element in place — do NOT re-render entire chat
      const eventKey = result.msg.eventKey;
      let existingEl: HTMLElement | null = null;
      if (eventKey) {
        existingEl = transcript.querySelector(`.msg[data-event-key="${CSS.escape(eventKey)}"]`);
      }
      // Fallback: find by clientMsgId (e.g. user message sent before eventKey is known)
      if (!existingEl && result.msg.clientMsgId) {
        existingEl = transcript.querySelector(`.msg[data-client-msg-id="${CSS.escape(result.msg.clientMsgId)}"]`);
      }
      if (existingEl) {
        _updateMsgElInPlace(existingEl, result.msg, botId);
        // Sync data-event-key so subsequent lookups and renderChat find this element
        if (eventKey && existingEl.dataset.eventKey !== eventKey) {
          existingEl.dataset.eventKey = eventKey;
        }
        return existingEl;
      }
      // Fallback: full re-render only if element not found
      renderChat(botId);
      const msgEls = transcript.querySelectorAll('.msg');
      return msgEls[result.index] as HTMLElement || null;
    }
    return null;
  }

  if (botId === currentBotId) {
    const msg = result.msg;
    if (isSessionStartMessage(msg.role, msg.text)) {
      transcript.appendChild(createSessionDivider(msg.ts));
    }
    const d = createMsgEl(msg.role, msg.text, botId, msg.ts, msg.status, msg.deliveryStatus, msg.eventKey, msg.clientMsgId, msg.sourceChannel, msg.serverSeq, msg.contentKind);
    if (msg.role === 'assistant') {
      d.dataset.ttsText = msg.ttsText || msg.text;
    }
    const wasNear = _isNearBottom(transcript);
    // Insert at correct sorted position instead of always appending
    const allMsgEls = transcript.querySelectorAll('.msg');
    if (result.index >= allMsgEls.length) {
      transcript.appendChild(d);
    } else {
      transcript.insertBefore(d, allMsgEls[result.index]);
    }
    if (msg.role === 'user') {
      // User sent a message — always scroll to bottom and reset ownership
      transcript.scrollTop = transcript.scrollHeight;
      _hideNewMsgIndicator();
      _setScrollOwnership('AUTO');
      if (_scrollOwnershipTimer) { clearTimeout(_scrollOwnershipTimer); _scrollOwnershipTimer = null; }
    } else if (wasNear) {
      transcript.scrollTop = transcript.scrollHeight;
      _hideNewMsgIndicator();
    } else {
      _unreadNewCount++;
      _showNewMsgIndicator(_unreadNewCount);
    }
    _updateScrollBottomFab();
    return d;
  } else {
    if (role === 'assistant' && shouldIncludeMsg(
      { intermediate: !!extra?.intermediate, contentKind: extra?.contentKind as string, text },
    )) {
      // Update seen count before incrementing unread so future sync-path
      // chat:changed events don't double-count this message.
      // Both counters use shouldIncludeMsg so their baselines stay aligned.
      setBotSeenCount(botId, getBotSeenCount(botId) + 1);
      setUnreadCount(botId, (getUnreadCount(botId) || 0) + 1);
      bus.emit('ui:badges');
    }
    if (role === 'assistant') {
      bus.emit('ui:flash-tab', botId);
    }
    return null;
  }
}

export function scrollToLatestSessionBoundary(smooth = true): boolean {
  if (!transcript) return false;
  const nodes = transcript.querySelectorAll('.session-divider[data-session-start="1"]');
  if (!nodes.length) return false;
  const latest = nodes[nodes.length - 1] as HTMLElement;
  latest.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  return true;
}

let _searchFocusTimer: ReturnType<typeof setTimeout> | null = null;
export function scrollToMessageByEventKey(eventKey: string, smooth = true): boolean {
  const key = String(eventKey || '').trim();
  if (!transcript || !key) return false;
  const nodes = transcript.querySelectorAll('.msg');
  let target: HTMLElement | null = null;
  for (const n of nodes) {
    const el = n as HTMLElement;
    if ((el.dataset.eventKey || '') === key) {
      target = el;
      break;
    }
  }
  if (!target) return false;
  target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
  target.classList.add('search-focus');
  if (_searchFocusTimer) clearTimeout(_searchFocusTimer);
  _searchFocusTimer = setTimeout(() => {
    target?.classList.remove('search-focus');
  }, 1800);
  return true;
}

// --- Audio stream completion ---

export function completeStreamAudio(botId: string): void {
  const st = getBotStreamState(botId);
  if (!st) return;
  st.audioDone = true;
  setBotStreamState(botId, null);
}

// --- Playback ---
export function updatePlayButtons(): void {
  document.querySelectorAll('.msg.assistant .play-btn').forEach(b => {
    const el = b as HTMLElement;
    const msg = el.closest('.msg')!;
    const active = msg.classList.contains('reading');
    el.classList.remove('loading');
    el.classList.toggle('active', active);
    el.textContent = active ? '\u23F8' : '\u25B6';
  });
}

export function enqueueChunkedReadFromElements(elements: HTMLElement[]): void {
  if (!elements.length) return;
  for (const el of elements) {
    if (!el) continue;
    // Skip tool_call messages — only read text replies aloud
    if (el.dataset.contentKind === 'tool_call') continue;
    const rawText = el.dataset.ttsText || el.querySelector('.msg-text')?.textContent || '';
    if (!rawText) continue;
    const ttsText = cleanForTTS(rawText);
    if (!ttsText) continue;
    const chunks = chunkForTTS(ttsText);
    for (const chunk of chunks) {
      audioPlayer.enqueue(el, '', chunk);
    }
  }
}

export function startChunkedReadFromMessage(msgEl: HTMLElement): void {
  if (!msgEl) return;
  const allAssistant = Array.from(transcript.querySelectorAll('.msg.assistant')) as HTMLElement[];
  const idx = allAssistant.indexOf(msgEl);
  if (idx === -1) return;
  _setScrollOwnership('AUTO');
  if (_scrollOwnershipTimer) clearTimeout(_scrollOwnershipTimer);
  interruptBot(getCurrentBotId());
  enqueueChunkedReadFromElements(allAssistant.slice(idx));
}

export function autoReadUnreadN(botId: string, count: number): void {
  if (!isAutoReadEnabled()) {
    _log.info('autoReadUnreadN: skipped (auto-read disabled)', { botId, count });
    return;
  }
  if (count <= 0) return;
  // DOM already contains only messages that pass shouldIncludeMsg (via _shouldDisplayMsg
  // in renderChat and display checks in ws-dispatcher). The unread count is calculated
  // with the same shouldIncludeMsg filter, so slice(-count) is now consistent.
  const candidates = Array.from(transcript.querySelectorAll('.msg.assistant')) as HTMLElement[];
  const unreadEls = candidates.slice(-count);
  if (unreadEls.length === 0) {
    _log.info('autoReadUnreadN: skipped (no DOM elements)', { botId, count, totalCandidates: candidates.length });
    return;
  }
  _log.info('autoReadUnreadN: starting', { botId, count, elements: unreadEls.length });
  _setScrollOwnership('AUTO');
  if (_scrollOwnershipTimer) clearTimeout(_scrollOwnershipTimer);
  interruptBot(getCurrentBotId());
  enqueueChunkedReadFromElements(unreadEls);
}

// --- Text input ---
export function sendTextPayload(payloadText: string, displayText?: string): void {
  const payload = (payloadText || '').trim();
  if (!payload) return;
  const input = document.getElementById('text-reply-input') as HTMLTextAreaElement | null;
  const display = (displayText || payload).trim();
  const currentBotId = getCurrentBotId();
  const msgId = ws.nextMsgId();
  // Ensure bot is idle before starting a new text turn (mirrors voice path's interrupt logic)
  const currentTurn = botTurnState.get(currentBotId);
  if (currentTurn !== 'idle') {
    interruptBot(currentBotId, 'new_text_turn');
  }
  botTurnState.transition(currentBotId, 'sending');
  outbox.enqueue({ type: 'text', text: payload, botId: currentBotId }, msgId);
  addBotMsg(currentBotId, 'user', display, { status: 'pending', deliveryStatus: 'sending', clientMsgId: msgId });
  // Always scroll to bottom when user sends a message
  if (transcript) _scrollToBottom(transcript, true);
  if (input) { input.value = ''; input.style.height = 'auto'; }
  syncManager.schedule(currentBotId, 350);
}

export function sendTextReply(): void {
  const input = document.getElementById('text-reply-input') as HTMLTextAreaElement | null;
  const text = (input?.value || '').trim();
  if (!text) return;
  sendTextPayload(text, text);
}


export function getTranscript(): HTMLElement {
  return transcript;
}

export function getStatusEl(): HTMLElement {
  return statusEl;
}
