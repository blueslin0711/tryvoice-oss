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

beforeEach(() => {
  vi.useFakeTimers();
  statusEl.textContent = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('status bar auto-revert', () => {
  it('transient status reverts to default after 2.5s', () => {
    // "已取消录音" compacts to "已取消" which is a known transient status
    setStatusText('已取消录音', '点击说话');
    expect(statusEl.textContent).toBe('已取消');
    vi.advanceTimersByTime(2500);
    expect(statusEl.textContent).toBe('点击说话');
  });

  it('non-transient status does NOT revert', () => {
    setStatusText('处理中', '点击说话');
    expect(statusEl.textContent).toContain('处理中');
    vi.advanceTimersByTime(5000);
    expect(statusEl.textContent).toContain('处理中');
  });

  it('new status clears pending revert timer', () => {
    setStatusText('已取消录音', '点击说话');
    vi.advanceTimersByTime(1000); // halfway through revert delay
    setStatusText('处理中', '点击说话');
    vi.advanceTimersByTime(5000); // well past original revert
    expect(statusEl.textContent).toContain('处理中'); // should NOT have reverted
  });

  it('transient status followed by another transient resets timer', () => {
    setStatusText('已取消录音', '点击说话');
    vi.advanceTimersByTime(2000);
    setStatusText('没听清，再说一次？', '点击说话');
    vi.advanceTimersByTime(2000);
    // Only 2s after second transient — should still show it
    expect(statusEl.textContent).toBe('没听清');
    vi.advanceTimersByTime(600);
    // Now 2.6s after — should revert
    expect(statusEl.textContent).toBe('点击说话');
  });
});
