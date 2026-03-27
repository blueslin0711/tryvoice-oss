/**
 * Status bar auto-revert tests
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub DOM globals before importing status-bar (it reads getElementById at module load)
const statusEl = { id: 'status', textContent: '' } as unknown as HTMLDivElement;

vi.stubGlobal('document', {
  getElementById: (id: string) => (id === 'status' ? statusEl : null),
});

// Stub localStorage for i18n
const storage: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, val: string) => { storage[key] = val; },
  removeItem: (key: string) => { delete storage[key]; },
});

// Must import AFTER DOM setup
const { setStatusText } = await import('../ui/status-bar');
const { t } = await import('../i18n');

const CANCELLED = t('status.cancelled');
const NOT_HEARD = t('status.not_heard');
const PROCESSING = t('status.processing');
const DEFAULT = t('status.click_to_talk');

beforeEach(() => {
  vi.useFakeTimers();
  statusEl.textContent = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('status bar auto-revert', () => {
  it('transient status reverts to default after 2.5s', () => {
    setStatusText(CANCELLED, DEFAULT);
    expect(statusEl.textContent).toBe(CANCELLED);
    vi.advanceTimersByTime(2500);
    expect(statusEl.textContent).toBe(DEFAULT);
  });

  it('non-transient status does NOT revert', () => {
    setStatusText(PROCESSING, DEFAULT);
    expect(statusEl.textContent).toContain(PROCESSING);
    vi.advanceTimersByTime(5000);
    expect(statusEl.textContent).toContain(PROCESSING);
  });

  it('new status clears pending revert timer', () => {
    setStatusText(CANCELLED, DEFAULT);
    vi.advanceTimersByTime(1000); // halfway through revert delay
    setStatusText(PROCESSING, DEFAULT);
    vi.advanceTimersByTime(5000); // well past original revert
    expect(statusEl.textContent).toContain(PROCESSING); // should NOT have reverted
  });

  it('transient status followed by another transient resets timer', () => {
    setStatusText(CANCELLED, DEFAULT);
    vi.advanceTimersByTime(2000);
    setStatusText(NOT_HEARD, DEFAULT);
    vi.advanceTimersByTime(2000);
    // Only 2s after second transient — should still show it
    expect(statusEl.textContent).toBe(NOT_HEARD);
    vi.advanceTimersByTime(600);
    // Now 2.6s after — should revert
    expect(statusEl.textContent).toBe(DEFAULT);
  });
});
