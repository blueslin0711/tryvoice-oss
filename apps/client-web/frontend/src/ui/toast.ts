// Enhanced toast notification system with severity levels, action buttons, and queuing.
// Backward-compatible: showToast(text, duration?) still works.

export type ToastSeverity = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  callback: () => void;
}

export interface ToastOptions {
  severity?: ToastSeverity;
  duration?: number;
  action?: ToastAction;
  id?: string;
}

interface ToastItem {
  text: string;
  severity: ToastSeverity;
  duration: number;
  action?: ToastAction;
  id?: string;
  el?: HTMLElement;
  timer?: ReturnType<typeof setTimeout>;
}

const _ICONS: Record<ToastSeverity, string> = {
  info: '\u2139',    // ℹ
  success: '\u2713', // ✓
  warning: '\u26A0', // ⚠
  error: '\u2715',   // ✕
};

const _DEFAULT_DURATION: Record<ToastSeverity, number> = {
  info: 1500,
  success: 1500,
  warning: 4000,
  error: 5000,
};

const MAX_VISIBLE = 3;

let _container: HTMLElement | null = null;
const _visible: ToastItem[] = [];
const _queue: ToastItem[] = [];

export function initToastContainer(): void {
  if (_container) return;
  _container = document.createElement('div');
  _container.id = 'toast-container';
  document.body.appendChild(_container);
}

function _createToastEl(item: ToastItem): HTMLElement {
  const el = document.createElement('div');
  el.className = `toast-item toast-${item.severity}`;
  el.setAttribute('role', 'alert');

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = _ICONS[item.severity];
  el.appendChild(icon);

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = item.text;
  el.appendChild(text);

  if (item.action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = item.action.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      item.action!.callback();
      _dismissItem(item);
    });
    el.appendChild(btn);
  }

  return el;
}

function _showItem(item: ToastItem): void {
  if (!_container) initToastContainer();

  const el = _createToastEl(item);
  item.el = el;
  _container!.appendChild(el);

  // Trigger reflow for animation
  el.offsetHeight; // eslint-disable-line @typescript-eslint/no-unused-expressions
  requestAnimationFrame(() => el.classList.add('show'));

  _visible.push(item);

  item.timer = setTimeout(() => _dismissItem(item), item.duration);
}

function _dismissItem(item: ToastItem): void {
  if (item.timer) clearTimeout(item.timer);
  const idx = _visible.indexOf(item);
  if (idx === -1) return;
  _visible.splice(idx, 1);

  if (item.el) {
    item.el.classList.remove('show');
    item.el.classList.add('toast-exit');
    setTimeout(() => item.el?.remove(), 300);
  }

  // Show next queued item
  if (_queue.length > 0 && _visible.length < MAX_VISIBLE) {
    _showItem(_queue.shift()!);
  }
}

function _findById(id: string): ToastItem | undefined {
  return _visible.find(i => i.id === id) || _queue.find(i => i.id === id);
}

/**
 * Show a toast notification.
 * Backward-compatible: showToast(text) or showToast(text, 1500) still works.
 * Enhanced: showToast(text, { severity: 'error', action: { label: 'Retry', callback: fn } })
 */
export function showToast(text: string, durationOrOpts?: number | ToastOptions): void {
  let opts: ToastOptions = {};
  if (typeof durationOrOpts === 'number') {
    opts = { duration: durationOrOpts };
  } else if (durationOrOpts) {
    opts = durationOrOpts;
  }

  const severity = opts.severity || 'info';
  const duration = opts.duration || (opts.action ? 5000 : _DEFAULT_DURATION[severity]);
  const item: ToastItem = { text, severity, duration, action: opts.action, id: opts.id };

  // Dedup by id: replace existing toast with same id
  if (item.id) {
    const existing = _findById(item.id);
    if (existing) {
      // Update text in place
      if (existing.el) {
        const textEl = existing.el.querySelector('.toast-text');
        if (textEl) textEl.textContent = text;
      }
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => _dismissItem(existing), duration);
      return;
    }
  }

  if (_visible.length >= MAX_VISIBLE) {
    _queue.push(item);
  } else {
    _showItem(item);
  }
}

export function dismissToast(id: string): void {
  const item = _findById(id);
  if (item) _dismissItem(item);
}
