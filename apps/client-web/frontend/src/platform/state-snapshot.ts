import { getCurrentBotId, getInputMode } from '../ui/app-state';
import { STORAGE_KEY } from '../core/types';

const SNAPSHOT_KEY = STORAGE_KEY + 'ui_snapshot';

export interface UISnapshot {
  botId: string;
  inputMode: string;
  ts: number; // Date.now() when saved
}

export function saveSnapshot(): void {
  try {
    const snap: UISnapshot = {
      botId: getCurrentBotId(),
      inputMode: getInputMode(),
      ts: Date.now(),
    };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch { /* localStorage may be full */ }
}

/**
 * Consume the snapshot (returns it and deletes from storage).
 * Returns null if no snapshot, or if snapshot is older than 10 minutes.
 */
export function consumeSnapshot(): UISnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    localStorage.removeItem(SNAPSHOT_KEY);
    const snap: UISnapshot = JSON.parse(raw);
    // Discard stale snapshots (> 10 min = probably a fresh app launch, not crash)
    if (Date.now() - snap.ts > 10 * 60 * 1000) return null;
    return snap;
  } catch {
    return null;
  }
}
