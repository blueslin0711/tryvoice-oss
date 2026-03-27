// i18n core — lightweight translation with locale switching

import _zhCN from './zh-CN.json';
import _en from './en.json';

type LocaleMessages = Record<string, string>;

const zhCN = _zhCN as LocaleMessages;
const en = _en as LocaleMessages;

const locales: Record<string, LocaleMessages> = {
  'zh-CN': zhCN,
  'en': en,
};

const STORAGE_KEY = 'tryvoice_locale';

let currentLocale: string = (() => {
  try { return localStorage.getItem(STORAGE_KEY) || 'en'; }
  catch { return 'en'; }
})();
let messages: LocaleMessages = locales[currentLocale] || en;

/**
 * Get translated text.
 * @param key Message key, e.g. "status.connecting"
 * @param params Optional template params {name: "xxx"} → replaces {name}
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let text = messages[key] || en[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.split(`{${k}}`).join(String(v));
    }
  }
  return text;
}

export function setLocale(locale: string): void {
  currentLocale = locale;
  messages = locales[locale] || en;
  try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* ignore */ }
}

export function getLocale(): string {
  return currentLocale;
}

export function getAvailableLocales(): string[] {
  return Object.keys(locales);
}
