// Native wakeword bridge for iOS (Capacitor).
// On native platforms, delegates wakeword detection to the Swift WakeWordEngine
// which uses AVAudioEngine + ONNX Runtime and works in the background.

import { isNativePlatform, getServerUrl } from './server-url';
import { registerPlugin } from '@capacitor/core';
import { createLogger } from '../logging/logger';
import { bus } from '../core/event-bus';

const log = createLogger('wakeword.native');

let _started = false;
let _removeListener: (() => void) | null = null;
let _removeAudioLevelListener: (() => void) | null = null;

interface WakeWordPlugin {
  start(opts: { serverUrl: string; keywords: Record<string, string>; threshold?: number }): Promise<{ status: string; keywords: string[] }>;
  stop(): Promise<{ status: string }>;
  saveConfig(opts: { serverUrl: string; keywords: Record<string, string>; threshold: number }): Promise<{ status: string }>;
  addListener(event: string, cb: (data: any) => void): Promise<{ remove: () => void }>;
}

// Register the native plugin via Capacitor's bridge
const WakeWord = registerPlugin<WakeWordPlugin>('WakeWordPlugin');

export function isNativeWakeWordAvailable(): boolean {
  return isNativePlatform();
}

function getPlugin(): WakeWordPlugin {
  return WakeWord;
}

/**
 * Start native wakeword detection.
 * @param keywords Map of keyword name → ONNX model filename
 * @param threshold Detection threshold (default 0.3)
 * @param onDetected Callback when a wakeword is detected
 */
export async function startNativeWakeWord(
  keywords: Record<string, string>,
  threshold: number = 0.3,
  onDetected: (keyword: string, score: number) => void,
): Promise<void> {
  if (_started) {
    await stopNativeWakeWord();
  }

  const serverUrl = getServerUrl();
  if (!serverUrl) {
    log.error('Server URL not configured, cannot start native wakeword');
    return;
  }

  const plugin = getPlugin();

  // Register listeners before starting
  const handle = await plugin.addListener('wakeWordDetected', (data: { keyword: string; score: number }) => {
    log.info('Native wakeword detected', { keyword: data.keyword, score: data.score });
    onDetected(data.keyword, data.score);
  });
  _removeListener = handle.remove;

  // Forward native audio RMS to the event bus so the wakeword button animation works
  // (same event that the browser wakeword pipeline emits from ScriptProcessorNode)
  const audioHandle = await plugin.addListener('audioLevel', (data: { rms: number }) => {
    bus.emit('wakeword:audio-level', data.rms);
  });
  _removeAudioLevelListener = audioHandle.remove;

  log.info('Starting native wakeword', { serverUrl, keywords: Object.keys(keywords), threshold });
  const result = await plugin.start({ serverUrl, keywords, threshold });
  _started = true;
  log.info('Native wakeword started', { keywords: result.keywords });
}

export async function stopNativeWakeWord(): Promise<void> {
  if (!_started) return;

  _removeListener?.();
  _removeListener = null;
  _removeAudioLevelListener?.();
  _removeAudioLevelListener = null;
  await getPlugin().stop();
  _started = false;
  log.info('Native wakeword stopped');
}

export function isNativeWakeWordRunning(): boolean {
  return _started;
}

/**
 * Persist wakeword config to UserDefaults via the native plugin so AppDelegate can
 * start the native engine directly in applicationDidEnterBackground without relying
 * on JS execution (WKWebView may freeze before any async JS after visibilitychange).
 */
export async function saveNativeWakeWordConfig(
  keywords: Record<string, string>,
  threshold: number,
): Promise<void> {
  if (!isNativePlatform()) return;
  const serverUrl = getServerUrl();
  if (!serverUrl) return;
  try {
    await getPlugin().saveConfig({ serverUrl, keywords, threshold });
    log.info('Native wakeword config persisted to UserDefaults', { keywords: Object.keys(keywords), threshold });
  } catch (e) {
    log.warn('Failed to persist native wakeword config', { error: String(e) });
  }
}
