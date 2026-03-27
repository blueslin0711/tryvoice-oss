import { audioPlayer } from '../audio/audio-player';
import { createLogger } from '../logging/logger';

const log = createLogger('platform.audio-unlock');

/**
 * Show a full-screen tap-to-resume overlay. The user tap provides the gesture
 * context iOS requires to resume AudioContext and re-enable audio I/O.
 * Returns a Promise that resolves when the user taps or after 30s timeout.
 */
export function showAudioUnlockOverlay(): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'audio-unlock-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 99999;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      cursor: pointer; touch-action: manipulation;
    `;
    overlay.innerHTML = `
      <div style="
        background: #1a1a2e; border-radius: 16px; padding: 32px 28px;
        text-align: center; max-width: 280px; color: #fff;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      ">
        <div style="font-size: 40px; margin-bottom: 12px;">🔊</div>
        <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">Tap to Resume Audio</div>
        <div style="font-size: 13px; color: #aaa;">App was refreshed by the system</div>
      </div>
    `;

    let dismissed = false;

    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(timer);
      overlay.removeEventListener('click', dismiss);
      overlay.remove();
      // Resume AudioContext within user gesture (or best-effort on timeout)
      try {
        const ctx = audioPlayer.getAudioContext();
        if (ctx.state === 'suspended') {
          ctx.resume().then(() => log.info('AudioContext resumed via user tap'))
            .catch((e) => log.warn('AudioContext resume failed', { error: String(e) }));
        }
      } catch (e) {
        log.warn('AudioContext access failed', { error: String(e) });
      }
      log.info('Audio unlock overlay dismissed');
      resolve();
    };

    // Auto-dismiss after 30s so wakeword restart is not blocked indefinitely
    const timer = setTimeout(() => {
      log.info('Audio unlock overlay auto-dismissed after timeout');
      dismiss();
    }, 30_000);

    overlay.addEventListener('click', dismiss);
    document.body.appendChild(overlay);
    log.info('Audio unlock overlay shown');
  });
}
