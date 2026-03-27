// Local notifications for iOS (Capacitor).
// Schedules a system notification when a bot message arrives while the app is backgrounded.
// Tapping the notification switches to the bot that sent the message.
// On web/desktop this module is a no-op — all exports guard on isNativePlatform().

import { LocalNotifications } from '@capacitor/local-notifications';
import { isNativePlatform } from './server-url';
import { createLogger } from '../logging/logger';
import { getBotDisplayName, setCurrentBotId } from '../ui/app-state';
import { bus } from '../core/event-bus';

const log = createLogger('ui.local-notifications');

let _initialized = false;

/** Deterministic integer notification ID so the same message never fires twice. */
function notifIdForMessage(botId: string, eventKey: string): number {
  let h = 0;
  const str = `${botId}:${eventKey}`;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 2_147_483_647;
}

/**
 * Request notification permission and register the tap-to-switch-bot listener.
 * Call once at app startup, gated by isNativePlatform().
 */
export async function initLocalNotifications(): Promise<void> {
  if (!isNativePlatform() || _initialized) return;
  _initialized = true;

  try {
    const { display } = await LocalNotifications.requestPermissions();
    log.info('Local notification permission', { display });
  } catch (e) {
    log.warn('requestPermissions failed', { error: String(e) });
    return;
  }

  // When notification is tapped: switch to the bot that sent the message
  await LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
    const botId = event.notification.extra?.botId as string | undefined;
    if (!botId) return;
    log.info('Notification tapped, switching to bot', { botId });
    setCurrentBotId(botId);
    bus.emit('bot:switch', { botId });
  });

  log.info('Local notifications initialised');
}

/**
 * Schedule a local notification for a new bot message, but only when the app is backgrounded.
 * eventKey is used for deduplication (same key → same notification ID → system replaces it).
 * Safe to call regardless of platform — no-ops on web/desktop.
 */
export function notifyNewMessage(botId: string, messageText: string, eventKey: string): void {
  if (!isNativePlatform() || !_initialized) return;
  if (!document.hidden) return;  // app is in foreground, no notification needed

  const botName = getBotDisplayName(botId);
  const body = messageText.slice(0, 80).trim() || '…';
  const id = notifIdForMessage(botId, eventKey);

  LocalNotifications.schedule({
    notifications: [{
      id,
      title: botName,
      body,
      extra: { botId },
      schedule: { at: new Date(Date.now() + 100) },
    }],
  }).catch(e => log.warn('Failed to schedule notification', { error: String(e) }));

  log.info('Scheduled notification', { botId, eventKey, id });
}
