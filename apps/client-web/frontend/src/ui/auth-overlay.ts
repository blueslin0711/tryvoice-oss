// Auth overlay — password authentication for access-protected instances

import { t } from '../i18n';

export async function fetchAuthStatus(): Promise<{ enabled: boolean; authenticated: boolean }> {
  try {
    const resp = await fetch('/auth/status');
    if (!resp.ok) return { enabled: false, authenticated: true };
    const data = await resp.json();
    return {
      enabled: !!data.enabled,
      authenticated: !!data.authenticated,
    };
  } catch (_e) {
    return { enabled: false, authenticated: true };
  }
}

export function showAuthOverlay(): Promise<void> {
  return new Promise((resolve) => {
    const existing = document.getElementById('auth-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.className = 'auth-overlay';
    overlay.innerHTML = `
      <form class="auth-card" id="auth-login-form" autocomplete="off">
        <h2 class="auth-title">${t('auth.title')}</h2>
        <p class="auth-subtitle">${t('auth.subtitle')}</p>
        <input id="auth-password-input" class="auth-input" type="password" placeholder="Password" />
        <div id="auth-login-error" class="auth-error"></div>
        <button class="auth-submit" type="submit">${t('auth.submit')}</button>
      </form>
    `;
    document.body.appendChild(overlay);

    const form = document.getElementById('auth-login-form') as HTMLFormElement;
    const input = document.getElementById('auth-password-input') as HTMLInputElement;
    const err = document.getElementById('auth-login-error') as HTMLDivElement;
    input.focus();

    form.addEventListener('submit', async (evt) => {
      evt.preventDefault();
      err.textContent = '';
      const password = input.value || '';
      try {
        const resp = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        if (!resp.ok) {
          err.textContent = t('auth.wrong_password');
          input.select();
          return;
        }
        const data = await resp.json();
        if (!data.ok) {
          err.textContent = t('auth.login_failed');
          input.select();
          return;
        }
        overlay.remove();
        resolve();
      } catch (_e) {
        err.textContent = t('auth.network_error');
      }
    });
  });
}

export async function ensureAuthorized(): Promise<void> {
  const status = await fetchAuthStatus();
  if (!status.enabled || status.authenticated) return;
  await showAuthOverlay();
}
