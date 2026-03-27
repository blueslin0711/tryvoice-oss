// Persistent error banner for critical issues (connection loss, auth failure).
// Shows above the chat area; stays until explicitly dismissed.

interface BannerAction {
  label: string;
  callback: () => void;
}

let _bannerEl: HTMLElement | null = null;
let _textEl: HTMLElement | null = null;
let _actionEl: HTMLButtonElement | null = null;
let _currentId: string | null = null;

export function initErrorBanner(): void {
  if (_bannerEl) return;

  _bannerEl = document.createElement('div');
  _bannerEl.id = 'error-banner';
  _bannerEl.className = 'error-banner hidden';
  _bannerEl.setAttribute('role', 'alert');
  _bannerEl.setAttribute('aria-live', 'assertive');

  const icon = document.createElement('span');
  icon.className = 'error-banner-icon';
  icon.textContent = '\u26A0'; // ⚠
  _bannerEl.appendChild(icon);

  _textEl = document.createElement('span');
  _textEl.className = 'error-banner-text';
  _bannerEl.appendChild(_textEl);

  _actionEl = document.createElement('button');
  _actionEl.className = 'error-banner-action';
  _actionEl.style.display = 'none';
  _bannerEl.appendChild(_actionEl);

  // Insert as first child of #chat-main
  const chatMain = document.getElementById('chat-main');
  if (chatMain) {
    chatMain.insertBefore(_bannerEl, chatMain.firstChild);
  } else {
    document.body.appendChild(_bannerEl);
  }
}

export function showBanner(id: string, text: string, action?: BannerAction): void {
  if (!_bannerEl || !_textEl || !_actionEl) return;

  _currentId = id;
  _textEl.textContent = text;

  if (action) {
    _actionEl.textContent = action.label;
    _actionEl.style.display = '';
    _actionEl.onclick = (e) => {
      e.stopPropagation();
      action.callback();
    };
  } else {
    _actionEl.style.display = 'none';
    _actionEl.onclick = null;
  }

  _bannerEl.classList.remove('hidden');
}

export function dismissBanner(id: string): void {
  if (!_bannerEl || _currentId !== id) return;
  _bannerEl.classList.add('hidden');
  _currentId = null;
}
