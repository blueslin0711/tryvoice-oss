// First-run banner prompting users to optionally configure Groq / Azure API keys
// for lower-latency browser-direct STT and high-quality TTS.
// Shown once on first open when keys are missing; dismissed via localStorage.

import { STORAGE_KEY } from '../core/types';

const DISMISS_KEY = STORAGE_KEY + 'apiKeyBannerDismissed';
let _bannerEl: HTMLElement | null = null;

export function initApiKeyBanner(): void {
  // Already dismissed?
  try {
    if (localStorage.getItem(DISMISS_KEY) === '1') return;
  } catch (_e) { /* proceed */ }

  // Check both endpoints in parallel
  Promise.all([
    fetch('/stt-config').then(r => r.json()).catch(() => ({ keyMasked: '' })),
    fetch('/speech-config').then(r => r.json()).catch(() => ({ azureEnabled: true })),
  ]).then(([stt, tts]) => {
    const groqConfigured = Boolean(stt.keyMasked);
    const azureConfigured = Boolean(tts.azureEnabled);

    // Both configured — no banner needed
    if (groqConfigured && azureConfigured) return;

    _render(groqConfigured, azureConfigured);
  });
}

function _render(groqOk: boolean, azureOk: boolean): void {
  _bannerEl = document.createElement('div');
  _bannerEl.id = 'api-key-banner';
  _bannerEl.className = 'api-key-banner';

  let html = `<div class="akb-header">
    <span class="akb-title">Enhance your experience with free API keys</span>
    <button class="akb-dismiss" aria-label="Dismiss">\u00D7</button>
  </div><div class="akb-items">`;

  if (!groqOk) {
    html += `<div class="akb-item">
      <div class="akb-item-title">Groq API Key</div>
      <div class="akb-item-desc">Browser-direct speech-to-text with lower latency</div>
      <div class="akb-item-actions">
        <a href="https://console.groq.com/keys" target="_blank" rel="noopener" class="akb-link">Get free key</a>
        <button class="akb-settings-btn" data-section="stt">Add in Settings</button>
      </div>
    </div>`;
  }

  if (!azureOk) {
    html += `<div class="akb-item">
      <div class="akb-item-title">Azure Speech Key</div>
      <div class="akb-item-desc">High-quality neural text-to-speech voices</div>
      <div class="akb-item-actions">
        <a href="https://azure.microsoft.com/en-us/products/ai-services/speech-to-text" target="_blank" rel="noopener" class="akb-link">Get free key</a>
        <button class="akb-settings-btn" data-section="tts">Add in Settings</button>
      </div>
    </div>`;
  }

  html += `</div><div class="akb-footer">These are optional. Local Whisper + Edge TTS works without them.</div>`;

  _bannerEl.innerHTML = html;

  // Wire up dismiss
  _bannerEl.querySelector('.akb-dismiss')?.addEventListener('click', _dismiss);

  // Wire up "Add in Settings" buttons — open settings panel
  _bannerEl.querySelectorAll('.akb-settings-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const overlay = document.getElementById('settings-overlay');
      if (overlay) overlay.classList.remove('hidden');
      _dismiss();
    });
  });

  // Insert as first child of #chat-main (same pattern as error-banner)
  const chatMain = document.getElementById('chat-main');
  if (chatMain) {
    chatMain.insertBefore(_bannerEl, chatMain.firstChild);
  } else {
    document.body.appendChild(_bannerEl);
  }
}

function _dismiss(): void {
  if (_bannerEl) {
    _bannerEl.classList.add('hidden');
    setTimeout(() => _bannerEl?.remove(), 300);
  }
  try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_e) { /* ignore */ }
}
