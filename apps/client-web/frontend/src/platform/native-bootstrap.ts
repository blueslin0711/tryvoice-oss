// Must be imported BEFORE any fetch() or WebSocket calls.
// On native platforms, patches global fetch to prepend the backend server URL
// for relative paths (e.g., fetch('/api/...') → fetch('https://server:7860/api/...')).

import { getServerUrl, isNativePlatform } from './server-url';

export function getWsUrl(queryParams?: Record<string, string>): string {
  const serverUrl = getServerUrl();
  let base: string;
  if (!serverUrl) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    base = `${proto}://${location.host}/ws`;
  } else {
    const wsProto = serverUrl.startsWith('https') ? 'wss' : 'ws';
    const host = serverUrl.replace(/^https?:\/\//, '');
    base = `${wsProto}://${host}/ws`;
  }
  if (queryParams) {
    const qs = new URLSearchParams(queryParams).toString();
    if (qs) base += `?${qs}`;
  }
  return base;
}

export function bootstrapNativePlatform(): void {
  if (!isNativePlatform()) return;

  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && input.startsWith('/')) {
      input = getServerUrl() + input;
    } else if (input instanceof Request && input.url.startsWith('/')) {
      input = new Request(getServerUrl() + input.url, input);
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
}
