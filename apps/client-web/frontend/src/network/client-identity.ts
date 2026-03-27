// Persistent client identity for multi-device sync logging.

import { isNativePlatform } from '../platform/server-url';

const STORAGE_KEY = 'tryvoice_client_id';

function _generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getClientId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = _generateUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

export function getDeviceType(): string {
  return isNativePlatform() ? 'ios' : 'web';
}
