/**
 * 10.4 i18n translation tests
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage before importing i18n
const storage: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, val: string) => { storage[key] = val; },
  removeItem: (key: string) => { delete storage[key]; },
});

// Dynamic import to ensure mock takes effect
let t: typeof import('../i18n/index').t;
let setLocale: typeof import('../i18n/index').setLocale;
let getLocale: typeof import('../i18n/index').getLocale;
let getAvailableLocales: typeof import('../i18n/index').getAvailableLocales;

beforeEach(async () => {
  // Reset module to get fresh state
  vi.resetModules();
  storage['tryvoice_locale'] = 'zh-CN';
  const mod = await import('../i18n/index');
  t = mod.t;
  setLocale = mod.setLocale;
  getLocale = mod.getLocale;
  getAvailableLocales = mod.getAvailableLocales;
});

describe('i18n', () => {
  it('t() returns Chinese text by default', () => {
    const result = t('status.processing');
    expect(result).toBe('处理中');
  });

  it('t() returns key when not found', () => {
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('setLocale to en returns English', () => {
    setLocale('en');
    expect(t('status.processing')).toBe('Processing');
    expect(getLocale()).toBe('en');
  });

  it('setLocale to unknown falls back to English', () => {
    setLocale('fr');
    // Unknown locale → falls back to English messages
    expect(t('status.processing')).toBe('Processing');
  });

  it('getAvailableLocales returns zh-CN and en', () => {
    const locales = getAvailableLocales();
    expect(locales).toContain('zh-CN');
    expect(locales).toContain('en');
  });

  it('t() with params replaces placeholders', () => {
    // Use a key that might have params, or test with raw key fallback
    const result = t('{name} says hello', { name: 'Alice' });
    expect(result).toBe('Alice says hello');
  });
});

describe('i18n new keys coverage', () => {
  it('settings.tab keys exist in both locales', async () => {
    vi.resetModules();
    storage['tryvoice_locale'] = 'zh-CN';
    const zh = await import('../i18n/index');
    expect(zh.t('settings.tab.interaction')).toBe('交互方式');
    expect(zh.t('settings.tab.voice')).toBe('语音与播报');
    expect(zh.t('settings.title')).toBe('设置');

    vi.resetModules();
    storage['tryvoice_locale'] = 'en';
    const en = await import('../i18n/index');
    expect(en.t('settings.tab.interaction')).toBe('Interaction');
    expect(en.t('settings.tab.voice')).toBe('Voice & Audio');
    expect(en.t('settings.title')).toBe('Settings');
  });

  it('voiceprint keys use params correctly', async () => {
    vi.resetModules();
    storage['tryvoice_locale'] = 'zh-CN';
    const mod = await import('../i18n/index');
    expect(mod.t('settings.voiceprint.registered', { count: 5 })).toBe('已注册(5个样本)');
    expect(mod.t('settings.voiceprint.recording', { current: 1, total: 3 })).toBe('请说话 (1/3)...');
  });

  it('voice history keys exist in both locales', async () => {
    vi.resetModules();
    storage['tryvoice_locale'] = 'zh-CN';
    const zh = await import('../i18n/index');
    expect(zh.t('vh.no_records')).toBe('暂无录音记录');
    expect(zh.t('vh.count', { count: 3 })).toBe('共 3 条');

    vi.resetModules();
    storage['tryvoice_locale'] = 'en';
    const en = await import('../i18n/index');
    expect(en.t('vh.no_records')).toBe('No recordings yet');
    expect(en.t('vh.count', { count: 3 })).toBe('3 recordings');
  });

  it('toast keys exist', async () => {
    vi.resetModules();
    storage['tryvoice_locale'] = 'zh-CN';
    const zh = await import('../i18n/index');
    expect(zh.t('toast.language_changed')).toBe('语言已切换');
    expect(zh.t('toast.copy_failed')).toBe('复制失败');
    expect(zh.t('toast.resent')).toBe('已重新发送');
  });
});
