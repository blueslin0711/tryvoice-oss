import { isNativePlatform } from './server-url';
import { registerPlugin } from '@capacitor/core';

interface CrashRecoveryPlugin {
  consumeCrashFlag(): Promise<{ crashed: boolean }>;
}

const CrashRecovery = registerPlugin<CrashRecoveryPlugin>('CrashRecovery');

/**
 * Returns true (once) if this page load was triggered by iOS killing the
 * WebContent process. On web or if no crash occurred, returns false.
 */
export async function wasCrashReload(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  try {
    const { crashed } = await CrashRecovery.consumeCrashFlag();
    return crashed;
  } catch {
    return false;
  }
}
