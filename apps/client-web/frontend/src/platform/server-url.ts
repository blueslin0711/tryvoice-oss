// Manages the backend server URL for native platforms.
// On web, returns '' (relative URLs work via same-origin).
// On native (Capacitor), returns a stored URL like 'https://192.168.1.100:7860'.

const STORAGE_KEY = 'tryvoice_server_url';

let _cachedUrl: string | null = null;

export function getServerUrl(): string {
  if (_cachedUrl !== null) return _cachedUrl;
  _cachedUrl = localStorage.getItem(STORAGE_KEY) || '';
  return _cachedUrl;
}

export function setServerUrl(url: string): void {
  const normalized = url.replace(/\/+$/, '');
  _cachedUrl = normalized;
  localStorage.setItem(STORAGE_KEY, normalized);
}

export function isNativePlatform(): boolean {
  return !!(window as any).Capacitor?.isNativePlatform?.();
}
