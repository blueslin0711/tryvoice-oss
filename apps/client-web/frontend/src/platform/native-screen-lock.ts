// Native screen lock bridge for iOS (Capacitor).
// Uses UIApplication.shared.isIdleTimerDisabled to reliably prevent screen sleep.

import { isNativePlatform } from './server-url';
import { registerPlugin } from '@capacitor/core';

interface ScreenLockPlugin {
  setKeepAwake(opts: { enabled: boolean }): Promise<{ enabled: boolean }>;
}

const ScreenLock = registerPlugin<ScreenLockPlugin>('ScreenLockPlugin');

export async function nativeSetKeepAwake(enabled: boolean): Promise<boolean> {
  if (!isNativePlatform()) return false;
  try {
    await ScreenLock.setKeepAwake({ enabled });
    return true;
  } catch (_e) {
    return false;
  }
}
