// Slash command autocomplete popup — Telegram-style inline command picker

import { getSlashCommands, getCurrentBotId } from './app-state';

let _popup: HTMLDivElement | null = null;
let _input: HTMLTextAreaElement | null = null;
let _onExecute: ((cmd: string) => void) | null = null;
let _activeIndex = 0;
let _filtered: Array<{ cmd: string; desc: string; label?: string }> = [];
let _open = false;

function _createPopup(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'slash-popup';
  el.setAttribute('role', 'listbox');
  el.addEventListener('mousedown', (e) => {
    // Prevent textarea blur when clicking popup items
    e.preventDefault();
  });
  return el;
}

function _render(): void {
  if (!_popup) return;
  _popup.innerHTML = '';
  _filtered.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'slash-popup-item' + (i === _activeIndex ? ' active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === _activeIndex ? 'true' : 'false');

    const cmdSpan = document.createElement('span');
    cmdSpan.className = 'slash-popup-cmd';
    cmdSpan.textContent = item.cmd;

    const descSpan = document.createElement('span');
    descSpan.className = 'slash-popup-desc';
    descSpan.textContent = item.desc;

    row.append(cmdSpan, descSpan);
    row.addEventListener('click', () => {
      _execute(i);
    });
    _popup!.appendChild(row);
  });
}

function _filter(query: string, commands: Array<{ cmd: string; desc: string; label?: string }>): void {
  const q = query.toLowerCase();
  _filtered = commands.filter((c) => c.cmd.startsWith('/' + q));
  _activeIndex = 0;
}

function _show(): void {
  if (!_popup) return;
  _open = true;
  _popup.classList.add('open');
}

function _hide(): void {
  if (!_popup) return;
  _open = false;
  _popup.classList.remove('open');
  _filtered = [];
}

function _execute(index: number): void {
  const item = _filtered[index];
  if (!item || !_onExecute || !_input) return;
  _input.value = '';
  _hide();
  _onExecute(item.cmd);
}

function _onInput(): void {
  if (!_input) return;
  const val = _input.value;

  // Only activate when text starts with "/" and nothing before it
  if (!val.startsWith('/')) {
    if (_open) _hide();
    return;
  }

  const query = val.slice(1); // text after "/"

  // If there's a space, it's a full command being typed — don't show popup
  if (query.includes(' ')) {
    if (_open) _hide();
    return;
  }

  const commands = getSlashCommands(getCurrentBotId());
  if (commands.length === 0) {
    if (_open) _hide();
    return;
  }

  _filter(query, commands);

  if (_filtered.length === 0) {
    _hide();
    return;
  }

  _render();
  _show();
}

/** Returns true if the keydown was consumed by the popup. */
export function handlePopupKeydown(e: KeyboardEvent): boolean {
  if (!_open) return false;

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      _activeIndex = (_activeIndex + 1) % _filtered.length;
      _render();
      return true;

    case 'ArrowUp':
      e.preventDefault();
      _activeIndex = (_activeIndex - 1 + _filtered.length) % _filtered.length;
      _render();
      return true;

    case 'Enter':
      e.preventDefault();
      _execute(_activeIndex);
      return true;

    case 'Escape':
      e.preventDefault();
      _hide();
      return true;

    case 'Tab':
      e.preventDefault();
      _execute(_activeIndex);
      return true;

    default:
      return false;
  }
}

export function isPopupOpen(): boolean {
  return _open;
}

/**
 * Initialize the slash command popup.
 * @param input  The textarea element to monitor
 * @param onExecute  Called with the full command string (e.g. "/clear") when selected
 */
export function initSlashPopup(
  input: HTMLTextAreaElement,
  onExecute: (cmd: string) => void,
): void {
  _input = input;
  _onExecute = onExecute;
  _popup = _createPopup();

  // Insert popup inside #text-reply-bar (positioned absolutely above it)
  const bar = input.closest('#text-reply-bar');
  if (bar) {
    bar.appendChild(_popup);
  } else {
    document.body.appendChild(_popup);
  }

  input.addEventListener('input', _onInput);

  // Close popup when clicking outside
  document.addEventListener('click', (e) => {
    if (!_open) return;
    if (_popup?.contains(e.target as Node)) return;
    if (e.target === _input) return;
    _hide();
  });
}
