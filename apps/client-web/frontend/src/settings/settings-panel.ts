// Settings panel — ported from app.js bot settings section

import { bus } from '../core/event-bus';
import { BOT_IDS, STORAGE_KEY } from '../core/types';
import {
  getBotNames, setBotNames, getBotAvatars, setBotAvatar,
  getBotVoiceSelections, setBotVoiceSelection,
  getBotTtsRates, setBotTtsRate,
  getVoicesList, getDefaultVoice, getInputMode,
  getCurrentBotId, getWwEngine, setWwEngine,
  getAnnounceVoice, setAnnounceVoice, getAnnounceRate, setAnnounceRate,
  setGranularity, type Granularity,
  syncSetting, showToast, saveSharedSettings,
  getBotSuffixes, getBotDisplayName,
  getHeightScale, applyHeightScale,
} from '../ui/app-state';
import { refreshAllBotNameDisplays, refreshAvatars } from '../ui/mic-ui';
import { chatStore } from '../store/chat-store';
import {
  wwMapping, saveWwMapping, PV_BUILTIN_KEYWORDS, OWW_KEYWORDS,
  applyInputMode, setWwAllowBargeIn, wwAllowBargeIn, setWwMicAec, wwMicAec, setWwVadGate, wwVadGate,
  pvEndword, pvCancelword, setPvEndword, setPvCancelword,
  stopWakeWord, startWakeWord, _migrateWwMapping, adoptLegacyPvDeviceRegistration,
  isVoiceprintEnabled, setVoiceprintEnabled,
  getVoiceprintThreshold, setVoiceprintThreshold,
  hasEnrollment, getEnrollCount, clearEnrollment, enrollSpeaker, verifySpeakerWithAudio,
  VOICEPRINT_MIN_THRESHOLD, VOICEPRINT_MAX_THRESHOLD,
  getOwwThreshold, setOwwThreshold,
  OWW_MODEL_META,
  owwEndwordKeyword, owwCancelwordKeyword,
  setOwwEndwordKeyword, setOwwCancelwordKeyword,
  ensureWakewordConfigLoaded,
  isPicovoiceKeyExposed,
  isSherpaKwsAvailable,
  OWW_KEYWORD_TO_MODEL,
  SHERPA_KWS_KEYWORDS,
  skwsEndwordKeyword, skwsCancelwordKeyword,
  setSkwsEndwordKeyword, setSkwsCancelwordKeyword,
  getOwwPipelines, getActivePipeline, setActivePipeline,
} from '../wakeword/wakeword-manager';
import { startPersonalizationWizard } from '../wakeword/personalization-wizard';
import { startTrainingTool } from '../wakeword/training-tool';
import { getVoiceprintHistory, clearVoiceprintHistory, type VoiceprintHistoryEntry } from '../wakeword/voiceprint-verifier';
import { syncManager } from '../network/sync';
import * as ws from '../network/ws-client';
import { t, setLocale, getLocale } from '../i18n/index';
import { nativeSetKeepAwake } from '../platform/native-screen-lock';
import { voiceHistoryStore, type VoiceHistoryEntry } from '../store/voice-history-store';

/**
 * Apply the current locale to all DOM elements marked with data-i18n / data-i18n-opt.
 * Call on panel init and on every locale change.
 */
function applyI18nToDOM(): void {
  const locale = getLocale();
  document.documentElement.lang = locale.split('-')[0];

  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n')!;
    el.textContent = t(key);
  });

  document.querySelectorAll<HTMLOptionElement>('[data-i18n-opt]').forEach(el => {
    const key = el.getAttribute('data-i18n-opt')!;
    el.textContent = t(key);
  });

  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder')!;
    (el as HTMLInputElement).placeholder = t(key);
  });

  const langSel = document.getElementById('app-language-select') as HTMLSelectElement | null;
  if (langSel) langSel.value = locale;
}

/**
 * Apply user font size via CSS custom property.
 * Affects transcript, bot tabs, status bar, settings panel, and text input.
 */
export function applyFontSize(px: string): void {
  document.documentElement.style.setProperty('--user-font-size', px + 'px');
}

/**
 * Restore saved font size from localStorage on page load.
 */
export function restoreFontSize(): void {
  try {
    const saved = localStorage.getItem(STORAGE_KEY + 'fontSize');
    if (saved) applyFontSize(saved);
  } catch (_e) { /* ignore */ }
}

const settingsOverlay = document.getElementById('settings-overlay');
const settingsBtn = document.getElementById('settings-btn');
const closeSettings = document.getElementById('close-settings');
const botSettingsTabs = document.getElementById('bot-settings-tabs');
const botSettingsPanel = document.getElementById('bot-settings-panel');
const avatarFileInput = document.getElementById('avatar-file-input') as HTMLInputElement | null;
const historySearchSidebar = document.getElementById('history-search-sidebar') as HTMLDivElement | null;
const historySearchInput = document.getElementById('history-search-input') as HTMLInputElement | null;
const historySearchBtn = document.getElementById('history-search-btn') as HTMLButtonElement | null;
const historySearchBot = document.getElementById('history-search-bot') as HTMLSelectElement | null;
const historySearchResults = document.getElementById('history-search-results') as HTMLDivElement | null;
const historyExportBtn = document.getElementById('history-export-btn') as HTMLButtonElement | null;
const historyExportBot = document.getElementById('history-export-bot') as HTMLSelectElement | null;
const historyFullSyncBtn = document.getElementById('history-full-sync-btn') as HTMLButtonElement | null;
const pvDebugBtn = document.getElementById('pv-debug-btn') as HTMLButtonElement | null;
const pvAdoptBtn = document.getElementById('pv-adopt-btn') as HTMLButtonElement | null;
const pvClearBtn = document.getElementById('pv-clear-btn') as HTMLButtonElement | null;
const pvAdoptSource = document.getElementById('pv-adopt-source') as HTMLSelectElement | null;
const pvDebugOutput = document.getElementById('pv-debug-output') as HTMLPreElement | null;
const historySearchClose = document.getElementById('history-search-close') as HTMLButtonElement | null;
const historySearchToggle = document.getElementById('history-search-toggle') as HTMLButtonElement | null;
const historySearchBackdrop = document.getElementById('history-search-backdrop') as HTMLDivElement | null;

function _firstBotId(): string {
  return BOT_IDS[0] || 'main';
}

let settingsBotId = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY + 'settingsBotId') || _firstBotId();
  } catch (_e) {
    return _firstBotId();
  }
})();
let avatarUploadTarget: string | null = null;
let historySearchBound = false;
let historySearchInFlight = false;

type HistorySearchHit = {
  botId: string;
  role: string;
  text: string;
  eventKey: string;
  ts?: string;
  snippet?: string;
  serverSeq?: number;
};

function setHistorySearchPanelOpen(open: boolean): void {
  const shouldOpen = !!open;
  historySearchSidebar?.classList.toggle('open', shouldOpen);
  historySearchBackdrop?.classList.toggle('open', shouldOpen);
  historySearchToggle?.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  if (shouldOpen) {
    historySearchInput?.focus();
  }
}

function syncHistorySearchLayout(): void {
  const isOpen = !!historySearchSidebar?.classList.contains('open');
  historySearchBackdrop?.classList.toggle('open', isOpen);
  historySearchToggle?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

function escHtml(s: string): string { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function getBotAvatar(botId: string): string { return getBotAvatars()[botId] || ''; }

function saveAvatars(): void { syncSetting('avatars', getBotAvatars()); }
function saveVoiceSelections(): void { syncSetting('voices', getBotVoiceSelections()); }
function saveBotTtsRates(): void { syncSetting('ttsRates', getBotTtsRates()); }

function stepRange(el: HTMLInputElement, dir: number): void {
  const parsedStep = Number(el.step);
  const step = Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : 1;
  const minRaw = Number(el.min);
  const maxRaw = Number(el.max);
  const min = Number.isFinite(minRaw) ? minRaw : -Infinity;
  const max = Number.isFinite(maxRaw) ? maxRaw : Infinity;
  const curRaw = Number(el.value);
  const cur = Number.isFinite(curRaw) ? curRaw : (Number.isFinite(minRaw) ? minRaw : 0);
  let v = cur + dir * step;
  if (v < min) v = min;
  if (v > max) v = max;
  const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  el.value = decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
  el.dispatchEvent(new Event('input'));
}

function getUsedPvKeywords(excludeRole: string): Set<string> {
  const used = new Set<string>();
  for (const [bid, kw] of Object.entries(wwMapping)) {
    if (!BOT_IDS.includes(bid)) continue; // skip phantom/deleted bots
    if (kw && PV_BUILTIN_KEYWORDS.includes(kw) && excludeRole !== 'wake:' + bid) used.add(kw);
  }
  if (pvEndword && excludeRole !== 'endword') used.add(pvEndword);
  if (pvCancelword && excludeRole !== 'cancelword') used.add(pvCancelword);
  return used;
}

function getUsedOwwKeywords(excludeRole: string): Set<string> {
  const used = new Set<string>();
  for (const [bid, kw] of Object.entries(wwMapping)) {
    if (!BOT_IDS.includes(bid)) continue; // skip phantom/deleted bots
    if (kw && OWW_KEYWORDS.includes(kw) && excludeRole !== 'wake:' + bid) used.add(kw);
  }
  if (owwEndwordKeyword && excludeRole !== 'endword') used.add(owwEndwordKeyword);
  if (owwCancelwordKeyword && excludeRole !== 'cancelword') used.add(owwCancelwordKeyword);
  return used;
}

function getUsedSkwsKeywords(excludeRole: string): Set<string> {
  const used = new Set<string>();
  for (const [bid, kw] of Object.entries(wwMapping)) {
    if (!BOT_IDS.includes(bid)) continue;
    if (kw && SHERPA_KWS_KEYWORDS.includes(kw) && excludeRole !== 'wake:' + bid) used.add(kw);
  }
  if (skwsEndwordKeyword && excludeRole !== 'endword') used.add(skwsEndwordKeyword);
  if (skwsCancelwordKeyword && excludeRole !== 'cancelword') used.add(skwsCancelwordKeyword);
  return used;
}

function formatHistoryTime(ts?: string): string {
  const raw = String(ts || '').trim();
  if (!raw) return '';
  const d = /^\d{11,}$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function refreshHistoryBotOptions(): void {
  // Populate with current BOT_IDS as a fast local fallback
  const currentSearch = historySearchBot?.value || '';
  const currentExport = historyExportBot?.value || '';
  const names = getBotNames();
  let html = `<option value="">${t('settings.all_bots')}</option>`;
  for (const id of BOT_IDS) {
    const label = names[id] || id;
    html += `<option value="${id}">${escHtml(label)}</option>`;
  }
  if (historySearchBot) {
    historySearchBot.innerHTML = html;
    const validSearch = !currentSearch || BOT_IDS.includes(currentSearch);
    historySearchBot.value = validSearch ? currentSearch : '';
  }
  if (historyExportBot) {
    historyExportBot.innerHTML = html;
    const validExport = !currentExport || BOT_IDS.includes(currentExport);
    historyExportBot.value = validExport ? currentExport : '';
  }
  // Async: enrich with adapter-grouped data (includes archived bots)
  void populateBotFilters();
}

interface AdapterBotInfo {
  botId: string;
  messageCount: number;
  lastActivity: string;
  isActive: boolean;
}

interface ArchivedBotInfo {
  botId: string;
  index: number;
  messageCount: number;
  lastActivity: string;
  summary: string;
}

interface AdapterGroup {
  adapterId: string;
  adapterName: string;
  ephemeralSessions: boolean;
  bots: AdapterBotInfo[];
  archivedBots?: ArchivedBotInfo[];
}

async function populateBotFilters(): Promise<void> {
  try {
    const resp = await fetch('/history/by-adapter');
    if (!resp.ok) return;
    const data = await resp.json();
    const adapters: AdapterGroup[] = data.adapters || [];
    if (!adapters.length) return;

    for (const selectId of ['history-search-bot', 'history-export-bot']) {
      const select = document.getElementById(selectId) as HTMLSelectElement | null;
      if (!select) continue;

      const prev = select.value;
      while (select.options.length > 1) select.remove(1);
      const allBotIds = new Set<string>();

      for (const adapter of adapters) {
        const group = document.createElement('optgroup');
        group.label = adapter.adapterName || adapter.adapterId || 'Unknown';

        // Active bots
        for (const bot of adapter.bots) {
          allBotIds.add(bot.botId);
          const opt = document.createElement('option');
          opt.value = bot.botId;
          const displayName = getBotDisplayName(bot.botId);
          const suffix = bot.isActive ? '' : ' (archived)';
          opt.textContent = `${displayName} (${bot.messageCount} msgs)${suffix}`;
          group.appendChild(opt);
        }

        // Archived ephemeral bots
        if (adapter.archivedBots) {
          for (const bot of adapter.archivedBots) {
            allBotIds.add(bot.botId);
            const opt = document.createElement('option');
            opt.value = bot.botId;
            const label = bot.summary
              ? `#${bot.index} ${bot.summary}`
              : `#${bot.index}`;
            opt.textContent = `${label} (${bot.messageCount} msgs)`;
            group.appendChild(opt);
          }
        }

        select.appendChild(group);
      }

      if (prev && allBotIds.has(prev)) {
        select.value = prev;
      }
    }
  } catch (_e) { /* silent */ }
}

function renderHistorySearchEmpty(text: string): void {
  if (!historySearchResults) return;
  historySearchResults.innerHTML = `<div class="history-search-empty">${escHtml(text)}</div>`;
}

function _parseTsForSort(ts?: string): number {
  const raw = String(ts || '').trim();
  if (!raw) return 0;
  if (/^\d{11,}$/.test(raw)) return Number(raw) || 0;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

function _makeSearchSnippet(text: string, idx: number, qLen: number, radius = 34): string {
  const src = String(text || '');
  if (!src) return '';
  if (idx < 0) return src.slice(0, Math.min(src.length, 100));
  const start = Math.max(0, idx - radius);
  const end = Math.min(src.length, idx + Math.max(1, qLen) + radius);
  const pre = start > 0 ? '...' : '';
  const suf = end < src.length ? '...' : '';
  return `${pre}${src.slice(start, end)}${suf}`;
}

async function jumpToHistoryHit(hit: HistorySearchHit): Promise<void> {
  const botId = String(hit.botId || '').trim();
  const eventKey = String(hit.eventKey || '').trim();
  if (!botId || !eventKey) return;
  setHistorySearchPanelOpen(false);
  settingsOverlay?.classList.remove('open');
  bus.emit('bot:switch', botId);
  syncManager.schedule(botId, 40);

  const { scrollToMessageByEventKey, renderChat } = await import('../ui/chat-renderer');
  let attempts = 0;
  const maxAttempts = 6;
  const locate = () => {
    attempts += 1;
    const ok = scrollToMessageByEventKey(eventKey, true);
    if (ok) {
      // Add highlight animation
      setTimeout(() => {
        const el = document.querySelector(`[data-event-key="${CSS.escape(eventKey)}"]`);
        if (el) {
          el.classList.add('highlight-jump');
          setTimeout(() => el.classList.remove('highlight-jump'), 2000);
        }
      }, 300);
      return;
    }
    syncManager.schedule(botId, 60);
    if (attempts < maxAttempts) {
      setTimeout(locate, 140);
      return;
    }
    // Fallback: use loadAroundMessage if serverSeq is available
    if (hit.serverSeq != null) {
      syncManager.loadAroundMessage(botId, hit.serverSeq).then((loaded) => {
        if (loaded) {
          renderChat(botId);
          setTimeout(() => {
            let msgEl: Element | null = document.querySelector(`[data-event-key="${CSS.escape(eventKey)}"]`);
            if (!msgEl) msgEl = document.querySelector(`[data-server-seq="${hit.serverSeq}"]`);
            if (msgEl) {
              msgEl.scrollIntoView({ block: 'center' });
              msgEl.classList.add('highlight-jump');
              setTimeout(() => msgEl!.classList.remove('highlight-jump'), 2000);
            } else {
              showToast(t('toast.not_found_retry'));
            }
          }, 100);
        } else {
          showToast(t('toast.not_found_retry'));
        }
      });
    } else {
      showToast(t('toast.not_found_retry'));
    }
  };
  setTimeout(locate, 70);
}

function renderHistorySearchHits(hits: HistorySearchHit[]): void {
  if (!historySearchResults) return;
  if (!hits.length) {
    renderHistorySearchEmpty(t('settings.no_results'));
    return;
  }
  historySearchResults.innerHTML = '';
  const names = getBotNames();
  for (const hit of hits) {
    const botName = names[hit.botId] || hit.botId;
    const roleText = hit.role === 'user' ? t('chat.you') : botName;
    const when = formatHistoryTime(hit.ts);
    const btn = document.createElement('button');
    btn.className = 'history-hit';
    btn.type = 'button';
    btn.innerHTML = `
      <div class="history-hit-meta">${escHtml(botName)} · ${escHtml(roleText)}${when ? ` · ${escHtml(when)}` : ''}</div>
      <div class="history-hit-text">${escHtml(hit.snippet || hit.text || '')}</div>
    `;
    btn.addEventListener('click', () => {
      void jumpToHistoryHit(hit);
    });
    historySearchResults.appendChild(btn);
  }
}

async function runHistorySearch(): Promise<void> {
  if (!historySearchInput || !historySearchBtn) return;
  const q = historySearchInput.value.trim();
  if (!q) {
    renderHistorySearchEmpty(t('settings.enter_keyword'));
    return;
  }
  if (historySearchInFlight) return;
  historySearchInFlight = true;
  historySearchBtn.disabled = true;
  historySearchBtn.textContent = '...';
  try {
    const qLower = q.toLowerCase();
    const selectedBot = historySearchBot?.value || '';
    let targetBots: string[];
    if (selectedBot) {
      targetBots = [selectedBot];
    } else {
      targetBots = [...BOT_IDS];
    }
    const hits: HistorySearchHit[] = [];
    for (const bid of targetBots) {
      const msgs = chatStore.getMessages(bid);
      for (const m of msgs) {
        if (!m || !m.eventKey) continue;
        const text = String(m.text || '').trim();
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(qLower);
        if (idx < 0) continue;
        hits.push({
          botId: bid,
          role: String(m.role || ''),
          text,
          eventKey: String(m.eventKey || ''),
          ts: String(m.ts || ''),
          snippet: _makeSearchSnippet(text, idx, q.length),
        });
      }
    }
    hits.sort((a, b) => _parseTsForSort(b.ts) - _parseTsForSort(a.ts));
    renderHistorySearchHits(hits);
  } catch (_e) {
    renderHistorySearchEmpty(t('toast.search_failed'));
  } finally {
    historySearchInFlight = false;
    historySearchBtn.disabled = false;
    historySearchBtn.textContent = t('settings.search');
  }
}

async function exportAllHistory(): Promise<void> {
  if (!historyExportBtn) return;
  historyExportBtn.disabled = true;
  const selectedBot = (historyExportBot?.value || '').trim();
  const oldText = historyExportBtn.textContent || t('settings.export');
  historyExportBtn.textContent = t('settings.exporting');
  try {
    const params = new URLSearchParams();
    if (selectedBot) params.set('botId', selectedBot);
    const exportApi = params.toString() ? `/history/export?${params.toString()}` : '/history/export';
    const resp = await fetch(exportApi);
    if (!resp.ok) {
      showToast(t('toast.export_failed'));
      return;
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('content-disposition') || '';
    const m = cd.match(/filename="?([^";]+)"?/i);
    const filename = m?.[1] || `tryvoice-history-${Date.now()}.json`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(selectedBot ? t('toast.bot_export_started') : t('toast.export_started'));
  } catch (_e) {
    showToast(t('toast.export_failed'));
  } finally {
    historyExportBtn.disabled = false;
    historyExportBtn.textContent = oldText;
  }
}

async function runFullHistorySync(): Promise<void> {
  if (!historyFullSyncBtn) return;
  const ok = confirm(t('settings.full_sync_confirm'));
  if (!ok) return;
  historyFullSyncBtn.disabled = true;
  const old = historyFullSyncBtn.textContent || t('settings.start_sync');
  historyFullSyncBtn.textContent = t('settings.syncing');
  try {
    const summary = await syncManager.fullSyncAll([...BOT_IDS]);
    const total = summary.reduce((acc, s) => acc + Number(s.fetched || 0), 0);
    showToast(t('toast.full_sync_done', { total }));
  } catch (_e) {
    showToast(t('toast.full_sync_failed'));
  } finally {
    historyFullSyncBtn.disabled = false;
    historyFullSyncBtn.textContent = old;
  }
}

function _getPvDeviceTagForDebug(): string {
  const key = STORAGE_KEY + 'pvDeviceTag';
  try {
    let tag = localStorage.getItem(key);
    if (!tag) {
      tag = 'dev_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
      localStorage.setItem(key, tag);
    }
    return tag;
  } catch (_e) {
    return 'default';
  }
}

function _openPvDbForDebug(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('pv_db', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pv_file')) db.createObjectStore('pv_file');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_e) {
      resolve(null);
    }
  });
}

async function _countLocalPvDbEntries(): Promise<number> {
  try {
    const db = await _openPvDbForDebug();
    if (!db) return -1;
    if (!db.objectStoreNames.contains('pv_file')) {
      try { db.close(); } catch (_e) { /* ignore */ }
      return 0;
    }
    return await new Promise((resolve) => {
      const tx = db.transaction('pv_file', 'readonly');
      const store = tx.objectStore('pv_file');
      const req = store.count();
      req.onsuccess = () => {
        try { db.close(); } catch (_e) { /* ignore */ }
        resolve(Number(req.result || 0));
      };
      req.onerror = () => {
        try { db.close(); } catch (_e) { /* ignore */ }
        resolve(-1);
      };
    });
  } catch (_e) {
    return -1;
  }
}

function _deleteLocalPvDb(): Promise<'ok' | 'blocked' | 'error'> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase('pv_db');
      let done = false;
      const settle = (state: 'ok' | 'blocked' | 'error') => {
        if (done) return;
        done = true;
        resolve(state);
      };
      req.onsuccess = () => settle('ok');
      req.onblocked = () => settle('blocked');
      req.onerror = () => settle('error');
    } catch (_e) {
      resolve('error');
    }
  });
}

async function _fetchServerPvBackupCount(deviceTag: string): Promise<number | null> {
  try {
    const resp = await fetch('/pv-device/restore/' + encodeURIComponent(deviceTag), { cache: 'no-store' });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.data)) return 0;
    return data.data.length;
  } catch (_e) {
    return null;
  }
}

type PvBackupItem = {
  deviceTag: string;
  entries: number;
  sizeBytes: number;
  mtimeMs: number;
};

async function _fetchServerPvBackups(): Promise<PvBackupItem[] | null> {
  try {
    const resp = await fetch('/pv-device/backups', { cache: 'no-store' });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.items)) return [];
    return data.items
      .map((it: Record<string, unknown>) => ({
        deviceTag: String(it.deviceTag || ''),
        entries: Number(it.entries || 0),
        sizeBytes: Number(it.sizeBytes || 0),
        mtimeMs: Number(it.mtimeMs || 0),
      }))
      .filter((it: PvBackupItem) => !!it.deviceTag);
  } catch (_e) {
    return null;
  }
}

function _refreshPvAdoptSourceOptions(items: PvBackupItem[], currentTag: string): void {
  if (!pvAdoptSource) return;
  const prev = pvAdoptSource.value || '';
  let html = `<option value="">${t('settings.auto_select_latest')}</option>`;
  for (const it of items) {
    if (!it.deviceTag || it.deviceTag === currentTag) continue;
    html += `<option value="${it.deviceTag}">${escHtml(it.deviceTag)} (${Math.max(0, Number(it.entries || 0))})</option>`;
  }
  pvAdoptSource.innerHTML = html;
  if (prev && Array.from(pvAdoptSource.options).some((o) => o.value === prev)) {
    pvAdoptSource.value = prev;
  }
}

async function runPvAdoptLegacy(): Promise<void> {
  if (!pvAdoptBtn) return;
  pvAdoptBtn.disabled = true;
  const oldText = pvAdoptBtn.textContent || t('settings.adopt');
  pvAdoptBtn.textContent = t('settings.adopting');
  try {
    const source = (pvAdoptSource?.value || '').trim();
    const ok = await adoptLegacyPvDeviceRegistration(source);
    if (ok) showToast(t('toast.adopted_old_device'));
    else showToast(t('toast.adopt_failed'));
    await runPvDebugCheck();
  } finally {
    pvAdoptBtn.disabled = false;
    pvAdoptBtn.textContent = oldText;
  }
}

async function runPvClearLocalData(): Promise<void> {
  if (!pvClearBtn) return;
  const currentTag = _getPvDeviceTagForDebug();
  const confirmed = confirm(t('settings.pv_clear_confirm', { tag: currentTag }));
  if (!confirmed) return;

  pvClearBtn.disabled = true;
  const oldText = pvClearBtn.textContent || t('settings.clear');
  pvClearBtn.textContent = t('settings.clearing');
  try {
    stopWakeWord();
    const result = await _deleteLocalPvDb();
    try { localStorage.removeItem(STORAGE_KEY + 'lastWakewordError'); } catch (_e) { /* ignore */ }

    if (result === 'ok') {
      showToast(t('toast.pv_cleared'));
    } else if (result === 'blocked') {
      showToast(t('toast.pv_clear_busy'));
    } else {
      showToast(t('toast.pv_clear_failed'));
    }
    await runPvDebugCheck();
  } finally {
    pvClearBtn.disabled = false;
    pvClearBtn.textContent = oldText;
  }
}

async function runPvDebugCheck(): Promise<void> {
  if (!pvDebugBtn || !pvDebugOutput) return;
  pvDebugBtn.disabled = true;
  const oldText = pvDebugBtn.textContent || t('settings.check');
  pvDebugBtn.textContent = t('settings.checking');
  try {
    const lines: string[] = [];
    const ua = navigator.userAgent || '';
    const isMobile = /iphone|ipad|android|mobile/i.test(ua);
    const now = new Date();
    const deviceTag = _getPvDeviceTagForDebug();

    lines.push(`${t('debug.time')}: ${now.toLocaleString()}`);
    lines.push(`${t('debug.device')}: ${isMobile ? 'Mobile' : 'Desktop'}`);
    lines.push(`${t('debug.ws_label')}: ${ws.isConnected() ? t('debug.ws_connected') : t('debug.ws_disconnected')}`);
    lines.push(`SecureContext: ${window.isSecureContext ? t('debug.yes') : t('debug.no')}`);
    lines.push(`crossOriginIsolated: ${window.crossOriginIsolated ? t('debug.yes') : t('debug.no')}`);
    lines.push(`pvDeviceTag: ${deviceTag}`);

    const localCount = await _countLocalPvDbEntries();
    lines.push(`${t('debug.local_pv_entries')}: ${localCount >= 0 ? String(localCount) : t('debug.read_failed')}`);

    const backupCount = await _fetchServerPvBackupCount(deviceTag);
    if (backupCount === null) lines.push(`${t('debug.server_backup')}: ${t('debug.read_failed_network')}`);
    else lines.push(`${t('debug.server_backup_entries')}: ${backupCount}`);

    const backups = await _fetchServerPvBackups();
    if (backups === null) {
      lines.push(`${t('debug.server_backup_list')}: ${t('debug.read_failed')}`);
      _refreshPvAdoptSourceOptions([], deviceTag);
    } else {
      _refreshPvAdoptSourceOptions(backups, deviceTag);
      const shown = backups.slice(0, 4).map((b) => `${b.deviceTag}(${b.entries})`);
      lines.push(`${t('debug.server_backup_files')}: ${backups.length}${shown.length ? ` | ${shown.join(', ')}` : ''}`);
    }

    try {
      const configResp = await fetch('/config', { cache: 'no-store' });
      if (!configResp.ok) {
        lines.push(`/config: HTTP ${configResp.status}`);
      } else {
        const cfg = await configResp.json();
        const exposed = !!cfg?.picovoiceKeyExposed;
        const hasKey = !!cfg?.picovoiceAccessKey;
        const ppn = String(cfg?.picovoicePpn || '');
        lines.push(`/config key${t('debug.exposed')}: ${exposed ? t('debug.yes') : t('debug.no')}`);
        lines.push(`/config key${t('debug.exists')}: ${hasKey ? t('debug.yes') : t('debug.no')}`);
        lines.push(`/config PPN: ${ppn || t('debug.empty')}`);
      }
    } catch (e) {
      lines.push(`/config: ${t('debug.request_failed')} (${String((e as Error).message || e)})`);
    }

    try {
      const g = window as unknown as {
        PorcupineWeb?: { Porcupine?: unknown };
        Porcupine?: { Porcupine?: unknown };
        WebVoiceProcessor?: { WebVoiceProcessor?: unknown };
      };
      const porcupineLoaded = !!(g.PorcupineWeb?.Porcupine || g.Porcupine?.Porcupine);
      const wvpLoaded = !!g.WebVoiceProcessor?.WebVoiceProcessor;
      lines.push(`Porcupine SDK${t('debug.loaded')}: ${porcupineLoaded ? t('debug.yes') : t('debug.no')}`);
      lines.push(`WebVoiceProcessor${t('debug.loaded')}: ${wvpLoaded ? t('debug.yes') : t('debug.no')}`);
    } catch (_e) {
      lines.push(`SDK${t('debug.load_status')}: ${t('debug.check_failed')}`);
    }

    try {
      const lastErr = (localStorage.getItem(STORAGE_KEY + 'lastWakewordError') || '').trim();
      lines.push(`${t('debug.last_ww_error')}: ${lastErr || t('debug.none')}`);
    } catch (_e) {
      lines.push(`${t('debug.last_ww_error')}: ${t('debug.read_failed')}`);
    }

    pvDebugOutput.textContent = lines.join('\n');
  } finally {
    pvDebugBtn.disabled = false;
    pvDebugBtn.textContent = oldText;
  }
}

function bindHistoryTools(): void {
  if (historySearchBound) return;
  historySearchBound = true;
  refreshHistoryBotOptions();
  syncHistorySearchLayout();
  historySearchBtn?.addEventListener('click', () => {
    void runHistorySearch();
  });
  historySearchInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    void runHistorySearch();
  });
  historySearchBot?.addEventListener('change', () => {
    if ((historySearchInput?.value || '').trim()) void runHistorySearch();
  });
  historyExportBtn?.addEventListener('click', () => {
    void exportAllHistory();
  });
  historyFullSyncBtn?.addEventListener('click', () => {
    void runFullHistorySync();
  });
  historySearchToggle?.addEventListener('click', () => {
    const isOpen = !!historySearchSidebar?.classList.contains('open');
    setHistorySearchPanelOpen(!isOpen);
  });
  historySearchClose?.addEventListener('click', () => setHistorySearchPanelOpen(false));
  historySearchBackdrop?.addEventListener('click', () => setHistorySearchPanelOpen(false));
  window.addEventListener('resize', syncHistorySearchLayout);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setHistorySearchPanelOpen(false);
  });
}

function renderBotSettingsTabs(): void {
  if (!botSettingsTabs) return;
  if (!BOT_IDS.includes(settingsBotId)) settingsBotId = _firstBotId();
  botSettingsTabs.innerHTML = '';
  BOT_IDS.forEach(id => {
    const b = document.createElement('button');
    b.className = 'bot-settings-tab' + (id === settingsBotId ? ' active' : '');
    b.textContent = getBotDisplayName(id);
    b.addEventListener('click', () => {
      settingsBotId = id;
      try { localStorage.setItem(STORAGE_KEY + 'settingsBotId', id); } catch (_e) { /* ignore */ }
      renderBotSettingsTabs();
      renderBotSettingsPanel(id);
    });
    botSettingsTabs.appendChild(b);
    if (id === settingsBotId) {
      requestAnimationFrame(() => b.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }));
    }
  });
}

function renderBotSettingsPanel(botId: string): void {
  if (!botSettingsPanel) return;
  const names = getBotNames();
  const src = getBotAvatar(botId);
  const voiceSelected = getBotVoiceSelections()[botId] || '';
  const rate = getBotTtsRates()[botId] || '1.0';
  const defaultVoice = getDefaultVoice();
  const voicesList = getVoicesList();

  botSettingsPanel.innerHTML = `
    <div class="setting-item">
      <div class="setting-row" style="gap:10px">
        <div class="avatar-preview" style="width:54px;height:54px">${src ? `<img src="${src}">` : '\u{1F916}'}</div>
        <div style="flex:1">
          <div class="setting-row" style="margin-bottom:4px;align-items:center;gap:4px">
            <input type="text" id="bot-name-input" value="${escHtml(names[botId])}" placeholder="${t('settings.bot_name_placeholder')}" style="width:100px;padding:4px 8px;border-radius:6px;background:#2a2a4a;color:#edf4ff;border:1px solid #444;font-size:13px;font-weight:700;outline:none">${getBotSuffixes()[botId] ? `<span style="color:#888;font-size:11px;white-space:nowrap">(${escHtml(getBotSuffixes()[botId])})</span>` : ''}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="avatar-upload-btn" id="bot-avatar-change">${t('settings.change_avatar')}</button>
            ${src ? `<button class="avatar-reset-btn" id="bot-avatar-reset">${t('settings.reset_avatar')}</button>` : ''}
            <button class="new-session-btn" id="bot-new-session">New Session</button>
          </div>
          <div id="avatar-picker" class="avatar-picker" style="display:none"></div>
        </div>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-row">
        <span class="setting-label">${t('settings.voice_label')}</span>
        <button class="preview-btn" id="bot-voice-preview">${t('settings.preview')}</button>
        <select id="bot-voice-select"></select>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-row">
        <span class="setting-label">${t('settings.rate_label')}</span>
        <div class="setting-controls">
          <button class="step-btn" id="rate-minus">-</button>
          <input type="range" class="slider-fixed slider-range" id="bot-rate-slider" min="0.8" max="2.0" step="0.1" value="${rate}">
          <button class="step-btn" id="rate-plus">+</button>
          <span id="bot-rate-value" class="setting-value-label setting-value-label-wide">${rate}x</span>
        </div>
      </div>
    </div>
    <div class="setting-item" id="bot-wakeword-setting" style="display:${getInputMode() === 'wakeword' ? '' : 'none'}">
      <div class="setting-row">
        <span class="setting-label">${t('settings.wakeword_label')}</span>
        <select id="bot-wakeword-select"></select>
      </div>
    </div>
    <div class="setting-item" id="bot-wakeword-hint" style="display:${getInputMode() === 'wakeword' ? 'none' : ''}">
      <div style="font-size:11px;color:var(--text-dim);">
        切换到<a href="#" id="bot-wakeword-hint-link" style="color:var(--accent, #3d9bff);text-decoration:underline;cursor:pointer;">唤醒词模式</a>后可为每个 Bot 分配唤醒词
      </div>
    </div>
    <div id="bot-mirror-container"></div>
  `;

  // Bot name
  const nameInput = document.getElementById('bot-name-input') as HTMLInputElement;
  let nameDebounce: ReturnType<typeof setTimeout> | null = null;
  nameInput?.addEventListener('input', () => {
    if (nameDebounce) clearTimeout(nameDebounce);
    nameDebounce = setTimeout(async () => {
      const newName = nameInput.value.trim();
      if (newName && newName !== names[botId]) {
        const updated = { ...names, [botId]: newName };
        setBotNames(updated);
        refreshAllBotNameDisplays();
        renderBotSettingsTabs();
        refreshHistoryBotOptions();
        await saveSharedSettings({ botNames: updated });
      }
    }, 500);
  });

  // Avatar
  document.getElementById('bot-avatar-change')?.addEventListener('click', () => {
    const picker = document.getElementById('avatar-picker');
    if (!picker) return;
    if (picker.style.display !== 'none') { picker.style.display = 'none'; return; }
    const defaultAvatars = ['main.jpeg', 'coder.jpeg', 'tester.jpeg', 'visual.jpeg', 'icon-claudecode.png', 'icon-openclaw.png'];
    picker.innerHTML = defaultAvatars.map(f =>
      `<img class="avatar-picker-item" src="/avatars/${f}" data-file="${f}" title="${f.replace(/\.\w+$/, '')}">`
    ).join('')
      + `<button class="avatar-picker-upload" id="avatar-picker-local">${t('settings.upload_local')}</button>`;
    picker.style.display = '';
    picker.querySelectorAll('.avatar-picker-item').forEach(img => {
      img.addEventListener('click', () => {
        const imgEl = new Image();
        imgEl.crossOrigin = 'anonymous';
        imgEl.onload = () => {
          const canvas = document.createElement('canvas');
          const size = 128;
          canvas.width = size; canvas.height = size;
          const ctx = canvas.getContext('2d')!;
          ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
          const minDim = Math.min(imgEl.width, imgEl.height);
          const sx = (imgEl.width - minDim) / 2;
          const sy = (imgEl.height - minDim) / 2;
          ctx.drawImage(imgEl, sx, sy, minDim, minDim, 0, 0, size, size);
          setBotAvatar(botId, canvas.toDataURL('image/png'));
          saveAvatars();
          refreshAvatars();
          renderBotSettingsPanel(botId);
        };
        imgEl.src = (img as HTMLImageElement).src;
      });
    });
    document.getElementById('avatar-picker-local')?.addEventListener('click', () => {
      avatarUploadTarget = botId; avatarFileInput?.click();
    });
  });
  document.getElementById('bot-avatar-reset')?.addEventListener('click', () => {
    const avatars = getBotAvatars();
    delete avatars[botId];
    saveAvatars();
    refreshAvatars();
    renderBotSettingsPanel(botId);
  });
  document.getElementById('bot-new-session')?.addEventListener('click', () => {
    if (confirm(t('settings.confirm_reset', { name: names[botId] }))) sendNewSession(botId);
  });

  // Voice select
  const sel = document.getElementById('bot-voice-select') as HTMLSelectElement;
  if (sel) {
    let opts = `<option value="">${t('settings.default_voice', { voice: defaultVoice })}</option>`;
    const zhVoices = voicesList.filter(v => v.locale.startsWith('zh'));
    const enVoices = voicesList.filter(v => v.locale.startsWith('en'));
    opts += `<optgroup label="${t('settings.chinese_group')}">`;
    for (const v of zhVoices) opts += `<option value="${v.id}" ${v.id === voiceSelected ? 'selected' : ''}>${v.name}·${v.gender === 'Female' ? t('settings.female') : t('settings.male')}</option>`;
    opts += `</optgroup><optgroup label="English">`;
    for (const v of enVoices) opts += `<option value="${v.id}" ${v.id === voiceSelected ? 'selected' : ''}>${v.name}·${v.gender}</option>`;
    opts += '</optgroup>';
    sel.innerHTML = opts;
    sel.addEventListener('change', async () => {
      setBotVoiceSelection(botId, sel.value);
      saveVoiceSelections();
      ws.send({ type: 'set_voice', botId, voiceId: sel.value });
      // Invalidate voice feedback cache so next wakeword uses new voice
      const { invalidateVoiceFeedback } = await import('../ui/mic-ui');
      invalidateVoiceFeedback(botId);
    });
  }

  // Voice preview
  document.getElementById('bot-voice-preview')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLButtonElement;
    const voiceId = getBotVoiceSelections()[botId] || defaultVoice;
    if (!voiceId) return;
    target.disabled = true; target.textContent = t('settings.loading');
    try {
      const audio = new Audio(`/preview_voice?voice_id=${encodeURIComponent(voiceId)}`);
      audio.onended = () => { target.disabled = false; target.textContent = t('settings.preview'); };
      audio.onerror = () => { target.disabled = false; target.textContent = t('settings.preview'); };
      await audio.play();
    } catch (_e) { target.disabled = false; target.textContent = t('settings.preview'); }
  });

  // Rate
  const rateSlider = document.getElementById('bot-rate-slider') as HTMLInputElement;
  const rateValue = document.getElementById('bot-rate-value');
  const sendRate = () => {
    const v = parseFloat(rateSlider.value).toFixed(1);
    if (rateValue) rateValue.textContent = v + 'x';
    setBotTtsRate(botId, v);
    saveBotTtsRates();
    ws.send({ type: 'set_tts_rate', botId, rate: v });
  };
  rateSlider?.addEventListener('input', sendRate);
  document.getElementById('rate-minus')?.addEventListener('click', () => stepRange(rateSlider, -1));
  document.getElementById('rate-plus')?.addEventListener('click', () => stepRange(rateSlider, +1));

  // Wakeword select
  const wwSel = document.getElementById('bot-wakeword-select') as HTMLSelectElement;
  if (wwSel) {
    const currentWw = wwMapping[botId] || '';
    let wwOpts = `<option value="">${t('settings.ww_none')}</option>`;
    if (getWwEngine() === 'openwakeword') {
      const usedOww = getUsedOwwKeywords('wake:' + botId);
      for (const kw of OWW_KEYWORDS) {
        // Skip keywords with endword/cancelword role — those belong in their own selects
        const role = OWW_MODEL_META[kw]?.role;
        if (role === 'endword' || role === 'cancelword') continue;
        const dis = usedOww.has(kw) ? ' disabled' : '';
        wwOpts += `<option value="${kw}"${kw === currentWw ? ' selected' : ''}${dis}>${kw}</option>`;
      }
    } else if (getWwEngine() === 'sherpa-onnx-kws') {
      const usedSkws = getUsedSkwsKeywords('wake:' + botId);
      for (const kw of SHERPA_KWS_KEYWORDS) {
        const dis = usedSkws.has(kw) ? ' disabled' : '';
        wwOpts += `<option value="${kw}"${kw === currentWw ? ' selected' : ''}${dis}>${kw}</option>`;
      }
    } else {
      const usedKws = getUsedPvKeywords('wake:' + botId);
      for (const kw of PV_BUILTIN_KEYWORDS) {
        const dis = usedKws.has(kw) ? ' disabled' : '';
        wwOpts += `<option value="${kw}"${kw === currentWw ? ' selected' : ''}${dis}>${kw}</option>`;
      }
    }
    wwSel.innerHTML = wwOpts;
    wwSel.addEventListener('change', () => {
      wwMapping[botId] = wwSel.value;
      saveWwMapping();
      if (getWwEngine() === 'openwakeword') refreshOwwEndwordSelects();
      if (getInputMode() === 'wakeword') { stopWakeWord(); setTimeout(() => startWakeWord(), 400); }
    });
  }

  // Hint link: navigate to interaction tab to switch input mode
  document.getElementById('bot-wakeword-hint-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    switchSettingsTab('interaction');
  });

  // Mirror settings — rendered from slot.mirrorChannels (populated at startup
  // from openclaw.json account→channel mapping), showing only the bot's own
  // IM platform. Per-bot enabled/config stored on slot.mirror.<channel>.
  const MIRROR_CHANNEL_FIELDS: Record<string, { label: string; fields: { key: string; placeholder: string; type: string }[] }> = {
    telegram: {
      label: 'Telegram',
      fields: [
        { key: 'target', placeholder: 'Chat ID (optional override)', type: 'text' },
        { key: 'token', placeholder: 'Bot Token (optional override)', type: 'password' },
      ],
    },
    feishu: {
      label: 'Feishu',
      fields: [
        { key: 'target', placeholder: 'Chat ID (optional override)', type: 'text' },
      ],
    },
    lark: {
      label: 'Lark',
      fields: [
        { key: 'target', placeholder: 'Chat ID (optional override)', type: 'text' },
      ],
    },
  };

  const mirrorContainer = document.getElementById('bot-mirror-container');
  if (mirrorContainer) {
    fetch('/slots').then(r => r.json()).then(slotsData => {
      const slot = (slotsData.slots || []).find((s: any) => s.slotId === botId);
      if (!slot) return;
      const mirrorChannels: string[] = slot.mirrorChannels || [];
      if (mirrorChannels.length === 0) return;

      for (const ch of mirrorChannels) {
        const chDef = MIRROR_CHANNEL_FIELDS[ch];
        const label = chDef?.label || ch.charAt(0).toUpperCase() + ch.slice(1);
        const chCfg = slot.mirror?.[ch] || {};

        const wrapper = document.createElement('div');
        wrapper.className = 'setting-item';

        const row = document.createElement('div');
        row.className = 'setting-row';
        row.innerHTML = `
          <span class="setting-label">Mirror → ${label}</span>
          <label class="toggle">
            <input type="checkbox" class="mirror-ch-toggle">
            <span class="slider"></span>
          </label>`;
        wrapper.appendChild(row);

        const toggle = row.querySelector('.mirror-ch-toggle') as HTMLInputElement;
        toggle.checked = chCfg.enabled === true;

        const fieldsDiv = document.createElement('div');
        fieldsDiv.style.cssText = 'display:none;margin-top:6px';
        const fieldInputs: Record<string, HTMLInputElement> = {};

        if (chDef?.fields) {
          for (const f of chDef.fields) {
            const inp = document.createElement('input');
            inp.type = f.type;
            inp.placeholder = f.placeholder;
            inp.value = chCfg[f.key] || '';
            inp.style.cssText = 'width:100%;padding:4px 8px;border-radius:6px;background:#2a2a4a;color:#edf4ff;border:1px solid #444;font-size:12px;outline:none;margin-bottom:4px;box-sizing:border-box';
            fieldsDiv.appendChild(inp);
            fieldInputs[f.key] = inp;
          }
        }
        wrapper.appendChild(fieldsDiv);
        mirrorContainer.appendChild(wrapper);

        if (toggle.checked) fieldsDiv.style.display = '';

        const saveMirrorConfig = () => {
          const cfg: Record<string, any> = { enabled: toggle.checked };
          for (const [key, inp] of Object.entries(fieldInputs)) {
            const v = inp.value.trim();
            if (v) cfg[key] = v;
          }
          fetch(`/slots/${encodeURIComponent(botId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mirror: { [ch]: cfg } }),
          }).catch(() => {});
        };

        toggle.addEventListener('change', () => {
          fieldsDiv.style.display = toggle.checked ? '' : 'none';
          saveMirrorConfig();
        });

        let debounce: ReturnType<typeof setTimeout> | null = null;
        for (const inp of Object.values(fieldInputs)) {
          inp.addEventListener('input', () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(saveMirrorConfig, 800);
          });
        }
      }
    }).catch(() => {});
  }
}

function sendNewSession(botId: string): void {
  if (ws.send({ type: 'new_session', botId })) {
    showToast(getBotNames()[botId] + ' ' + t('toast.reset_request_sent'));
  } else {
    showToast(t('toast.not_connected_cannot_reset'));
  }
}

function switchSettingsTab(tab: string): void {
  const nav = document.getElementById('settings-nav');
  const content = document.getElementById('settings-content');
  if (!nav || !content) return;
  nav.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-settings-tab') === tab);
  });
  content.querySelectorAll(':scope > .settings-group').forEach(group => {
    const isActive = group.id === `settings-tab-${tab}`;
    group.classList.toggle('settings-active', isActive);
    if (isActive) (group as HTMLDetailsElement).open = true;
  });
  try { localStorage.setItem(STORAGE_KEY + 'settingsTab', tab); } catch (_e) { /* ignore */ }
}

async function initSummaryLlmConfig(): Promise<void> {
  const urlInput = document.getElementById('summary-llm-url') as HTMLInputElement | null;
  const keyInput = document.getElementById('summary-llm-key') as HTMLInputElement | null;
  const modelInput = document.getElementById('summary-llm-model') as HTMLInputElement | null;
  const saveBtn = document.getElementById('summary-llm-save') as HTMLButtonElement | null;
  if (!urlInput || !keyInput || !modelInput || !saveBtn) return;

  // Load current config
  try {
    const resp = await fetch('/settings/summary-llm');
    if (resp.ok) {
      const data = await resp.json();
      urlInput.value = data.api_url || '';
      modelInput.value = data.model || '';
      // Don't populate key for security
    }
  } catch (_e) { /* silent */ }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const resp = await fetch('/settings/summary-llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_url: urlInput.value.trim(),
          api_key: keyInput.value.trim(),
          model: modelInput.value.trim(),
        }),
      });
      if (resp.ok) showToast(t('toast.summary_llm_saved'));
    } catch (_e) {
      showToast(t('toast.summary_llm_save_failed'), { severity: 'error' });
    } finally {
      saveBtn.disabled = false;
    }
  });
}

export function initSettings(): void {
  settingsBtn?.addEventListener('click', () => {
    settingsOverlay?.classList.add('open');
    renderBotSettingsTabs();
    renderBotSettingsPanel(settingsBotId);
    refreshHistoryBotOptions();
    if (historyExportBot) {
      historyExportBot.value = getCurrentBotId();
    }
    // Sync input mode select with current state (may have changed via main UI toggle)
    const inputModeSelect = document.getElementById('input-mode-select') as HTMLSelectElement | null;
    if (inputModeSelect) inputModeSelect.value = getInputMode();
    updateEndwordVisibility();
    renderVoiceHistoryList();
    // Ensure config loaded, then re-render so OWW keywords are up-to-date
    ensureWakewordConfigLoaded().then(() => {
      renderBotSettingsPanel(settingsBotId);
      updateEndwordVisibility();
    });
    // Wide screen: activate tab-based navigation
    if (window.innerWidth > 980) {
      const TAB_MIGRATION: Record<string, string> = { general: 'interaction', wakeword: 'interaction' };
      const savedTab = (() => { try { const t = localStorage.getItem(STORAGE_KEY + 'settingsTab') || 'interaction'; return TAB_MIGRATION[t] || t; } catch (_e) { return 'interaction'; } })();
      switchSettingsTab(savedTab);
    }
  });

  closeSettings?.addEventListener('click', () => settingsOverlay?.classList.remove('open'));

  // Settings nav tab switching (wide-screen sidebar)
  document.getElementById('settings-nav')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-settings-tab]') as HTMLElement | null;
    if (!btn) return;
    const tab = btn.getAttribute('data-settings-tab');
    if (tab) switchSettingsTab(tab);
  });

  // Re-render wakeword selects when server config arrives (async)
  bus.on('wakeword:config-loaded', () => {
    if (settingsOverlay?.classList.contains('open')) {
      renderBotSettingsPanel(settingsBotId);
      updateEndwordVisibility();
    }
  });

  // Adapter reconfiguration button
  document.getElementById('reconfigure-adapter-btn')?.addEventListener('click', async () => {
    settingsOverlay?.classList.remove('open');
    const { openSetupWizard } = await import('../ui/setup-wizard');
    await openSetupWizard();
  });
  settingsOverlay?.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) settingsOverlay.classList.remove('open');
  });

  // Avatar file input
  avatarFileInput?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file || !avatarUploadTarget) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const size = 128;
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d')!;
        ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
        setBotAvatar(avatarUploadTarget!, canvas.toDataURL('image/png'));
        saveAvatars();
        refreshAvatars();
        renderBotSettingsPanel(avatarUploadTarget!);
        avatarUploadTarget = null;
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
    avatarFileInput.value = '';
  });

  bindHistoryTools();
  renderHistorySearchEmpty(t('settings.search_hint'));

  // Global settings (volume, font, theme, etc.)
  initGlobalSettings();
  initVoiceHistory();
  initSummaryLlmConfig();
  applyI18nToDOM();
}

function initGlobalSettings(): void {
  // Volume slider
  const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
  const volumeValue = document.getElementById('volume-value');
  if (volumeSlider) {
    const saved = (() => { try { return localStorage.getItem(STORAGE_KEY + 'volume'); } catch (_e) { return null; } })();
    if (saved) volumeSlider.value = saved;
    const updateVol = () => {
      const v = Number(volumeSlider.value);
      if (volumeValue) volumeValue.textContent = v + '%';
      import('../audio/audio-player').then(({ audioPlayer }) => audioPlayer.setVolume(v));
      syncSetting('volume', v);
    };
    volumeSlider.addEventListener('input', updateVol);
    document.getElementById('vol-minus')?.addEventListener('click', () => stepRange(volumeSlider, -1));
    document.getElementById('vol-plus')?.addEventListener('click', () => stepRange(volumeSlider, +1));
  }

  // Announce voice select
  const announceVoiceSel = document.getElementById('announce-voice-select') as HTMLSelectElement;
  const announcePreviewBtn = document.getElementById('announce-voice-preview') as HTMLButtonElement;
  if (announceVoiceSel) {
    const voices = getVoicesList();
    if (voices.length > 0) {
      const current = getAnnounceVoice();
      const zhVoices = voices.filter(v => v.locale.startsWith('zh'));
      const enVoices = voices.filter(v => v.locale.startsWith('en'));
      let opts = `<optgroup label="${t('settings.chinese_group')}">`;
      for (const v of zhVoices) opts += `<option value="${v.id}" ${v.id === current ? 'selected' : ''}>${v.name}·${v.gender === 'Female' ? t('settings.female') : t('settings.male')}</option>`;
      opts += '</optgroup><optgroup label="English">';
      for (const v of enVoices) opts += `<option value="${v.id}" ${v.id === current ? 'selected' : ''}>${v.name}·${v.gender}</option>`;
      opts += '</optgroup>';
      announceVoiceSel.innerHTML = opts;
    }
    announceVoiceSel.addEventListener('change', () => {
      setAnnounceVoice(announceVoiceSel.value);
      syncSetting('announceVoice', announceVoiceSel.value);
    });
  }
  if (announcePreviewBtn) {
    announcePreviewBtn.addEventListener('click', async () => {
      announcePreviewBtn.disabled = true;
      announcePreviewBtn.textContent = '...';
      try {
        const resp = await fetch('/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: t('settings.preview_text'), voice: getAnnounceVoice(), rate: getAnnounceRate() }),
        });
        const data = await resp.json();
        if (data.audio) {
          const { audioPlayer } = await import('../audio/audio-player');
          audioPlayer.enqueue(null, data.audio, '');
        } else {
          showToast(t('toast.preview_failed'));
        }
      } catch (_e) { showToast(t('toast.preview_failed')); }
      announcePreviewBtn.disabled = false;
      announcePreviewBtn.textContent = t('settings.preview');
    });
  }

  // Announce rate slider
  const announceRateSlider = document.getElementById('announce-rate-slider') as HTMLInputElement;
  const announceRateValue = document.getElementById('announce-rate-value');
  if (announceRateSlider) {
    announceRateSlider.value = getAnnounceRate();
    if (announceRateValue) announceRateValue.textContent = getAnnounceRate() + 'x';
    announceRateSlider.addEventListener('input', () => {
      const v = announceRateSlider.value;
      if (announceRateValue) announceRateValue.textContent = v + 'x';
      setAnnounceRate(v);
      syncSetting('announceRate', v);
    });
  }
  document.getElementById('announce-rate-minus')?.addEventListener('click', () => { if (announceRateSlider) stepRange(announceRateSlider, -1); });
  document.getElementById('announce-rate-plus')?.addEventListener('click', () => { if (announceRateSlider) stepRange(announceRateSlider, +1); });

  // Unified granularity (display + read-aloud)
  const granSel = document.getElementById('granularity-select') as HTMLSelectElement;
  if (granSel) {
    const saved = (() => { try { return localStorage.getItem(STORAGE_KEY + 'granularity'); } catch (_e) { return null; } })();
    if (saved) granSel.value = saved;
    granSel.addEventListener('change', () => {
      setGranularity(granSel.value as Granularity);
      syncSetting('granularity', granSel.value);
      import('../ui/chat-renderer').then(({ renderChat }) => renderChat(getCurrentBotId()));
    });
  }

  // Font size
  const fontSlider = document.getElementById('font-size-slider') as HTMLInputElement;
  const fontValue = document.getElementById('font-size-value');
  if (fontSlider) {
    const saved = (() => { try { return localStorage.getItem(STORAGE_KEY + 'fontSize'); } catch (_e) { return null; } })();
    if (saved) fontSlider.value = saved;
    const updateFont = () => {
      const v = fontSlider.value;
      if (fontValue) fontValue.textContent = v + 'px';
      applyFontSize(v);
      syncSetting('fontSize', v);
    };
    fontSlider.addEventListener('input', updateFont);
    document.getElementById('font-minus')?.addEventListener('click', () => stepRange(fontSlider, -1));
    document.getElementById('font-plus')?.addEventListener('click', () => stepRange(fontSlider, +1));
    updateFont();
  }

  // Height scale (recording mode)
  const heightScaleSel = document.getElementById('height-scale-select') as HTMLSelectElement | null;
  if (heightScaleSel) {
    heightScaleSel.value = String(getHeightScale());
    heightScaleSel.addEventListener('change', () => {
      const scale = parseFloat(heightScaleSel.value);
      try { localStorage.setItem(STORAGE_KEY + 'heightScale', String(scale)); } catch (_e) { /* ignore */ }
      applyHeightScale(scale);
    });
  }

  // Theme toggle
  const themeToggle = document.getElementById('dark-mode-toggle') as HTMLInputElement;
  if (themeToggle) {
    const saved = (() => { try { return localStorage.getItem(STORAGE_KEY + 'theme'); } catch (_e) { return null; } })();
    const theme = saved || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.checked = theme === 'dark';
    themeToggle.addEventListener('change', () => {
      const theme = themeToggle.checked ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', theme);
      syncSetting('theme', theme);
    });
  }

  // Input mode select
  const inputModeSelect = document.getElementById('input-mode-select') as HTMLSelectElement;
  if (inputModeSelect) {
    inputModeSelect.value = getInputMode();
    inputModeSelect.addEventListener('change', () => {
      applyInputMode(inputModeSelect.value);
      updateEndwordVisibility();
    });
    // Sync wake word panel visibility on init (in case mode was persisted as 'wakeword')
    updateEndwordVisibility();
  }


  // WW engine
  const wwEngineSelect = document.getElementById('ww-engine-select') as HTMLSelectElement;
  if (wwEngineSelect) {
    wwEngineSelect.value = getWwEngine();
    wwEngineSelect.addEventListener('change', () => {
      const prev = getWwEngine();
      setWwEngine(wwEngineSelect.value as 'picovoice' | 'openwakeword' | 'sherpa-onnx-kws');
      syncSetting('wwEngine', wwEngineSelect.value);
      _migrateWwMapping(prev, wwEngineSelect.value);
      renderBotSettingsPanel(settingsBotId);
      updateEndwordVisibility();
      if (getInputMode() === 'wakeword') { stopWakeWord(true); startWakeWord(); }
    });
  }

  // WW threshold (OWW sensitivity)
  const wwThresholdSlider = document.getElementById('ww-threshold-slider') as HTMLInputElement;
  const wwThresholdValue = document.getElementById('ww-threshold-value') as HTMLElement;
  if (wwThresholdSlider) {
    const cur = getOwwThreshold();
    wwThresholdSlider.value = String(cur);
    if (wwThresholdValue) wwThresholdValue.textContent = cur.toFixed(2);
    wwThresholdSlider.addEventListener('input', () => {
      const v = parseFloat(wwThresholdSlider.value);
      setOwwThreshold(v);
      if (wwThresholdValue) wwThresholdValue.textContent = v.toFixed(2);
    });
  }

  // WW barge-in
  const wwBargeInToggle = document.getElementById('ww-bargein-toggle') as HTMLInputElement;
  if (wwBargeInToggle) {
    wwBargeInToggle.checked = !!wwAllowBargeIn;
    wwBargeInToggle.addEventListener('change', () => {
      setWwAllowBargeIn(wwBargeInToggle.checked);
      syncSetting('wwAllowBargeIn', wwBargeInToggle.checked ? '1' : '0');
      showToast(wwBargeInToggle.checked ? t('toast.ww_barge_in_on') : t('toast.ww_barge_in_off'));
    });
  }

  // WW mic AEC/noise suppression
  const wwMicAecToggle = document.getElementById('ww-mic-aec-toggle') as HTMLInputElement;
  if (wwMicAecToggle) {
    wwMicAecToggle.checked = !!wwMicAec;
    wwMicAecToggle.addEventListener('change', () => {
      setWwMicAec(wwMicAecToggle.checked);
      syncSetting('wwMicAec', wwMicAecToggle.checked ? '1' : '0');
      showToast(t(wwMicAecToggle.checked ? 'settings.ww_mic_aec.on' : 'settings.ww_mic_aec.off'));
    });
  }

  // WW VAD gate
  const wwVadGateToggle = document.getElementById('ww-vad-gate-toggle') as HTMLInputElement;
  if (wwVadGateToggle) {
    wwVadGateToggle.checked = !!wwVadGate;
    wwVadGateToggle.addEventListener('change', () => {
      setWwVadGate(wwVadGateToggle.checked);
      syncSetting('wwVadGate', wwVadGateToggle.checked ? '1' : '0');
      showToast(t(wwVadGateToggle.checked ? 'settings.ww_vad_gate.on' : 'settings.ww_vad_gate.off'));
    });
  }

  // Voiceprint settings
  const vpToggle = document.getElementById('voiceprint-toggle') as HTMLInputElement;
  const vpThresholdSlider = document.getElementById('voiceprint-threshold') as HTMLInputElement;
  const vpThresholdValue = document.getElementById('voiceprint-threshold-value');
  const vpThresholdRow = document.getElementById('voiceprint-threshold-row');
  const vpEnrollRow = document.getElementById('voiceprint-enroll-row');
  const vpStatus = document.getElementById('voiceprint-status');
  const vpEnrollBtn = document.getElementById('voiceprint-enroll-btn') as HTMLButtonElement;
  const vpClearBtn = document.getElementById('voiceprint-clear-btn') as HTMLButtonElement;
  const vpProgress = document.getElementById('voiceprint-enroll-progress');

  // Voiceprint verify section elements
  const vpVerifySection = document.getElementById('voiceprint-verify-section');
  const vpVerifyBtn = document.getElementById('voiceprint-verify-btn') as HTMLButtonElement;
  const vpIndicator = document.getElementById('voiceprint-indicator');
  const vpVerifyHint = document.getElementById('voiceprint-verify-hint');
  const vpScoreBarWrap = document.getElementById('voiceprint-score-bar-wrap');
  const vpScoreBarFill = document.getElementById('voiceprint-score-bar-fill') as HTMLElement | null;
  const vpScoreThresholdLine = document.getElementById('voiceprint-score-threshold-line') as HTMLElement | null;
  const vpScoreLabel = document.getElementById('voiceprint-score-label');

  // Verify mode state
  let vpVerifyActive = false;
  let vpVerifyStream: MediaStream | null = null;
  let vpVerifyCtx: AudioContext | null = null;
  let vpVerifyTimer: ReturnType<typeof setInterval> | null = null;
  const VP_VERIFY_BUF_SIZE = 24000; // 1.5s @ 16kHz
  const vpVerifyRollingBuf = new Float32Array(VP_VERIFY_BUF_SIZE);
  let vpVerifyWritePos = 0;

  function _vpSetIndicator(state: 'idle' | 'active' | 'matched'): void {
    if (!vpIndicator) return;
    vpIndicator.className = state === 'idle'
      ? 'voiceprint-indicator'
      : state === 'active'
        ? 'voiceprint-indicator vp-active'
        : 'voiceprint-indicator vp-matched';
  }

  function _vpUpdateScoreBar(score: number): void {
    const threshold = getVoiceprintThreshold();
    if (vpScoreBarFill) {
      vpScoreBarFill.style.width = (Math.min(score, 1) * 100).toFixed(1) + '%';
      vpScoreBarFill.className = score >= threshold
        ? 'voiceprint-score-bar-fill vp-bar-matched'
        : 'voiceprint-score-bar-fill';
    }
    if (vpScoreThresholdLine) {
      vpScoreThresholdLine.style.left = (threshold * 100).toFixed(1) + '%';
    }
    if (vpScoreLabel) vpScoreLabel.textContent = score.toFixed(2);
  }

  async function startVpVerify(): Promise<void> {
    if (vpVerifyActive) return;
    if (vpVerifyBtn) vpVerifyBtn.disabled = true;
    try {
      vpVerifyStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } });
      vpVerifyCtx = new AudioContext({ sampleRate: 16000 });
      const source = vpVerifyCtx.createMediaStreamSource(vpVerifyStream);
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const node = vpVerifyCtx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e: AudioProcessingEvent) => {
        const data = e.inputBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          vpVerifyRollingBuf[vpVerifyWritePos] = data[i];
          vpVerifyWritePos = (vpVerifyWritePos + 1) % VP_VERIFY_BUF_SIZE;
        }
      };
      source.connect(node);
      node.connect(vpVerifyCtx.destination);

      vpVerifyActive = true;
      if (vpVerifyBtn) { vpVerifyBtn.textContent = t('settings.voiceprint.verify_stop'); vpVerifyBtn.disabled = false; }
      _vpSetIndicator('active');
      if (vpScoreBarWrap) vpScoreBarWrap.style.display = '';
      if (vpVerifyHint) vpVerifyHint.textContent = t('settings.voiceprint.verify_hint_active');

      vpVerifyTimer = setInterval(async () => {
        if (!vpVerifyActive) return;
        const audio = new Float32Array(VP_VERIFY_BUF_SIZE);
        for (let i = 0; i < VP_VERIFY_BUF_SIZE; i++) {
          audio[i] = vpVerifyRollingBuf[(vpVerifyWritePos + i) % VP_VERIFY_BUF_SIZE];
        }
        try {
          const result = await verifySpeakerWithAudio(audio);
          _vpUpdateScoreBar(result.score);
          _vpSetIndicator(result.pass ? 'matched' : 'active');
          if (vpVerifyHint) {
            vpVerifyHint.textContent = result.pass
              ? t('settings.voiceprint.verify_hint_match')
              : t('settings.voiceprint.verify_hint_active');
          }
        } catch { /* ignore */ }
      }, 800);
    } catch (e) {
      showToast(t('settings.voiceprint.verify_mic_error', { error: (e as Error).message }));
      if (vpVerifyBtn) vpVerifyBtn.disabled = false;
    }
  }

  function stopVpVerify(): void {
    vpVerifyActive = false;
    if (vpVerifyTimer) { clearInterval(vpVerifyTimer); vpVerifyTimer = null; }
    if (vpVerifyStream) { vpVerifyStream.getTracks().forEach(tr => tr.stop()); vpVerifyStream = null; }
    if (vpVerifyCtx) { vpVerifyCtx.close(); vpVerifyCtx = null; }
    vpVerifyRollingBuf.fill(0);
    vpVerifyWritePos = 0;
    if (vpVerifyBtn) { vpVerifyBtn.textContent = t('settings.voiceprint.verify_start'); vpVerifyBtn.disabled = false; }
    _vpSetIndicator('idle');
    if (vpScoreBarWrap) vpScoreBarWrap.style.display = 'none';
    if (vpVerifyHint) vpVerifyHint.textContent = t('settings.voiceprint.verify_hint_idle');
    renderVoiceprintHistory();
  }

  function renderVoiceprintHistory(): void {
    const section = document.getElementById('voiceprint-history-section');
    const list = document.getElementById('voiceprint-history-list');
    if (!section || !list) return;

    const entries = getVoiceprintHistory();
    if (entries.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';
    const rows = [...entries].reverse().map((e: VoiceprintHistoryEntry) => {
      const d = new Date(e.ts);
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const date = d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
      const scoreStr = e.data.score !== undefined ? e.data.score.toFixed(3) : '—';
      const threshStr = e.data.threshold !== undefined ? e.data.threshold.toFixed(2) : '—';
      const triggerStr = e.data.trigger ?? '—';
      const errorStr = e.data.error ? ` · ${e.data.error}` : '';
      const levelClass = e.level === 'error' ? 'vp-hist-error' : e.level === 'warn' ? 'vp-hist-warn' : 'vp-hist-info';
      return `<div class="vp-hist-row ${levelClass}">
      <span class="vp-hist-time">${date} ${time}</span>
      <span class="vp-hist-msg">${e.message}</span>
      <span class="vp-hist-detail">score=${scoreStr} thr=${threshStr} via=${triggerStr}${errorStr}</span>
    </div>`;
    }).join('');

    list.innerHTML = rows;
  }

  function updateVoiceprintUI(): void {
    const enabled = isVoiceprintEnabled();
    if (vpToggle) vpToggle.checked = enabled;
    if (vpThresholdRow) vpThresholdRow.style.display = enabled ? '' : 'none';
    if (vpEnrollRow) vpEnrollRow.style.display = enabled ? '' : 'none';
    if (vpThresholdSlider) {
      vpThresholdSlider.value = String(getVoiceprintThreshold());
      if (vpThresholdValue) vpThresholdValue.textContent = getVoiceprintThreshold().toFixed(2);
    }
    const enrolled = hasEnrollment();
    if (vpStatus) vpStatus.textContent = enrolled
      ? t('settings.voiceprint.registered', { count: getEnrollCount() })
      : t('settings.voiceprint.unregistered');
    if (vpClearBtn) vpClearBtn.style.display = enrolled ? '' : 'none';
    // Verify section: always show when voiceprint is enabled; disable button until enrolled
    if (vpVerifySection) vpVerifySection.style.display = enabled ? '' : 'none';
    if (vpVerifyBtn) vpVerifyBtn.disabled = !enrolled;
    if (!enabled || !enrolled) stopVpVerify();
  }

  if (vpToggle) {
    updateVoiceprintUI();
    renderVoiceprintHistory();
    vpToggle.addEventListener('change', () => {
      setVoiceprintEnabled(vpToggle.checked);
      syncSetting('voiceprintEnabled', vpToggle.checked ? '1' : '0');
      updateVoiceprintUI();
      showToast(t(vpToggle.checked ? 'settings.voiceprint.on' : 'settings.voiceprint.off'));
    });
  }

  if (vpThresholdSlider) {
    vpThresholdSlider.addEventListener('input', () => {
      const v = parseFloat(vpThresholdSlider.value);
      if (vpThresholdValue) vpThresholdValue.textContent = v.toFixed(2);
    });
    vpThresholdSlider.addEventListener('change', () => {
      const v = parseFloat(vpThresholdSlider.value);
      setVoiceprintThreshold(v);
      syncSetting('voiceprintThreshold', v.toFixed(2));
    });
  }

  if (vpClearBtn) {
    vpClearBtn.addEventListener('click', () => {
      clearEnrollment();
      updateVoiceprintUI();
      showToast(t('settings.voiceprint.cleared'));
    });
  }

  const vpHistoryClearBtn = document.getElementById('voiceprint-history-clear-btn') as HTMLButtonElement | null;
  if (vpHistoryClearBtn) {
    vpHistoryClearBtn.addEventListener('click', () => {
      clearVoiceprintHistory();
      renderVoiceprintHistory();
    });
  }

  // ---- Enrollment wizard ----
  const vpEnrollWizard = document.getElementById('voiceprint-enroll-wizard');
  const vpWizardStepEls = [0, 1, 2].map(i => document.getElementById(`vp-step-${i}`));
  const vpWizardCancelBtn = document.getElementById('vp-wizard-cancel') as HTMLButtonElement | null;
  const vpEnrollWizardStatus = document.getElementById('vp-enroll-wizard-status');
  const vpWaveformCanvas = document.getElementById('vp-waveform-canvas') as HTMLCanvasElement | null;
  const vpProcessingDiv = document.getElementById('vp-processing');
  const vpRecordBtn = document.getElementById('vp-record-btn') as HTMLButtonElement | null;

  const ENROLL_TOTAL = 3;
  const ENROLL_RATE = 16000;
  let vpWizardActive = false;
  let vpWizardStep = 0;
  let vpWizardRecording = false;
  let vpWizardStream: MediaStream | null = null;
  let vpWizardCtx: AudioContext | null = null;
  let vpWizardAnalyser: AnalyserNode | null = null;
  let vpWizardRecNode: ScriptProcessorNode | null = null;
  let vpWizardSamples: number[] = [];
  let vpWizardUtterances: Float32Array[] = [];
  let vpWizardAnimFrame: number | null = null;

  function _vpUpdateWizardSteps(): void {
    vpWizardStepEls.forEach((el, i) => {
      if (!el) return;
      if (i < vpWizardStep) { el.className = 'vp-step vp-step-done'; el.textContent = '✓'; }
      else if (i === vpWizardStep) { el.className = 'vp-step vp-step-current'; el.textContent = String(i + 1); }
      else { el.className = 'vp-step'; el.textContent = String(i + 1); }
    });
  }

  function _vpDrawWaveform(): void {
    if (!vpWizardAnalyser || !vpWaveformCanvas) return;
    const canvas = vpWaveformCanvas;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const buf = new Float32Array(vpWizardAnalyser.fftSize);
    vpWizardAnalyser.getFloatTimeDomainData(buf);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.strokeStyle = '#4a9eff';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    const sw = canvas.width / buf.length;
    let x = 0;
    for (let i = 0; i < buf.length; i++) {
      const y = (buf[i] * 0.5 + 0.5) * canvas.height;
      if (i === 0) { ctx2d.moveTo(x, y); } else { ctx2d.lineTo(x, y); }
      x += sw;
    }
    ctx2d.stroke();
    vpWizardAnimFrame = requestAnimationFrame(_vpDrawWaveform);
  }

  function _vpStartRecording(): void {
    if (!vpWizardStream || !vpWizardCtx) return;
    vpWizardRecording = true;
    vpWizardSamples = [];
    const source = vpWizardCtx.createMediaStreamSource(vpWizardStream);
    vpWizardAnalyser = vpWizardCtx.createAnalyser();
    vpWizardAnalyser.fftSize = 1024;
    source.connect(vpWizardAnalyser);
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    vpWizardRecNode = vpWizardCtx.createScriptProcessor(4096, 1, 1);
    vpWizardRecNode.onaudioprocess = (e: AudioProcessingEvent) => {
      const data = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) vpWizardSamples.push(data[i]);
    };
    source.connect(vpWizardRecNode);
    vpWizardRecNode.connect(vpWizardCtx.destination);
    if (vpWaveformCanvas) vpWaveformCanvas.style.display = '';
    _vpDrawWaveform();
    if (vpRecordBtn) vpRecordBtn.textContent = t('settings.voiceprint.enroll_stop');
    if (vpEnrollWizardStatus) vpEnrollWizardStatus.textContent = t('settings.voiceprint.enroll_recording', { current: vpWizardStep + 1, total: ENROLL_TOTAL });
  }

  function _vpStopRecording(): void {
    vpWizardRecording = false;
    if (vpWizardAnimFrame) { cancelAnimationFrame(vpWizardAnimFrame); vpWizardAnimFrame = null; }
    if (vpWizardRecNode) { vpWizardRecNode.disconnect(); vpWizardRecNode = null; }
    if (vpWizardAnalyser) { vpWizardAnalyser.disconnect(); vpWizardAnalyser = null; }
    if (vpWaveformCanvas) {
      const ctx2d = vpWaveformCanvas.getContext('2d');
      if (ctx2d) ctx2d.clearRect(0, 0, vpWaveformCanvas.width, vpWaveformCanvas.height);
      vpWaveformCanvas.style.display = 'none';
    }
    vpWizardUtterances.push(new Float32Array(vpWizardSamples));
    vpWizardSamples = [];
    vpWizardStep++;
    _vpUpdateWizardSteps();
    if (vpWizardStep < ENROLL_TOTAL) {
      if (vpRecordBtn) { vpRecordBtn.textContent = t('settings.voiceprint.enroll_start'); vpRecordBtn.disabled = false; }
      if (vpEnrollWizardStatus) vpEnrollWizardStatus.textContent = t('settings.voiceprint.enroll_next', { current: vpWizardStep + 1, total: ENROLL_TOTAL });
    } else {
      _vpRunProcessing();
    }
  }

  async function _vpRunProcessing(): Promise<void> {
    if (vpWizardStream) { vpWizardStream.getTracks().forEach(tr => tr.stop()); vpWizardStream = null; }
    if (vpWizardCtx) { vpWizardCtx.close(); vpWizardCtx = null; }
    if (vpRecordBtn) vpRecordBtn.style.display = 'none';
    if (vpProcessingDiv) vpProcessingDiv.style.display = '';
    if (vpEnrollWizardStatus) vpEnrollWizardStatus.textContent = t('settings.voiceprint.processing');
    const result = await enrollSpeaker(vpWizardUtterances);
    if (vpProcessingDiv) vpProcessingDiv.style.display = 'none';
    if (result.success) {
      if (vpEnrollWizardStatus) vpEnrollWizardStatus.textContent = t('settings.voiceprint.success_progress');
      showToast(t('settings.voiceprint.success_toast'));
    } else {
      if (vpEnrollWizardStatus) vpEnrollWizardStatus.textContent = t('settings.voiceprint.failed_progress', { error: result.error || '' });
      showToast(t('settings.voiceprint.failed_toast', { error: result.error || '' }));
    }
    setTimeout(() => { _vpCloseWizard(); updateVoiceprintUI(); }, 1500);
  }

  async function _vpOpenWizard(): Promise<void> {
    try {
      vpWizardStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: ENROLL_RATE } });
      vpWizardCtx = new AudioContext({ sampleRate: ENROLL_RATE });
    } catch (e) {
      showToast(t('settings.voiceprint.record_failed', { error: (e as Error).message }));
      return;
    }
    vpWizardActive = true;
    vpWizardStep = 0;
    vpWizardUtterances = [];
    if (vpEnrollRow) vpEnrollRow.style.display = 'none';
    if (vpEnrollWizard) vpEnrollWizard.style.display = '';
    _vpUpdateWizardSteps();
    if (vpRecordBtn) { vpRecordBtn.style.display = ''; vpRecordBtn.textContent = t('settings.voiceprint.enroll_start'); vpRecordBtn.disabled = false; }
    if (vpEnrollWizardStatus) vpEnrollWizardStatus.textContent = t('settings.voiceprint.enroll_ready', { current: 1, total: ENROLL_TOTAL });
    if (vpWaveformCanvas) vpWaveformCanvas.style.display = 'none';
    if (vpProcessingDiv) vpProcessingDiv.style.display = 'none';
  }

  function _vpCloseWizard(): void {
    vpWizardActive = false;
    if (vpWizardAnimFrame) { cancelAnimationFrame(vpWizardAnimFrame); vpWizardAnimFrame = null; }
    if (vpWizardStream) { vpWizardStream.getTracks().forEach(tr => tr.stop()); vpWizardStream = null; }
    if (vpWizardCtx) { vpWizardCtx.close(); vpWizardCtx = null; }
    if (vpEnrollWizard) vpEnrollWizard.style.display = 'none';
    if (vpEnrollRow) vpEnrollRow.style.display = '';
  }

  if (vpEnrollBtn) {
    vpEnrollBtn.addEventListener('click', () => _vpOpenWizard());
  }

  if (vpRecordBtn) {
    vpRecordBtn.addEventListener('click', () => {
      if (vpWizardRecording) _vpStopRecording();
      else _vpStartRecording();
    });
  }

  if (vpWizardCancelBtn) {
    vpWizardCancelBtn.addEventListener('click', () => _vpCloseWizard());
  }

  if (vpVerifyBtn) {
    vpVerifyBtn.addEventListener('click', () => {
      if (vpVerifyActive) stopVpVerify();
      else startVpVerify();
    });
  }

  // Personalization wizard
  const personalizeRow = document.getElementById('oww-personalize-row');
  const personalizeBtn = document.getElementById('oww-personalize-btn');

  function updatePersonalizeVisibility() {
    if (personalizeRow) {
      // Personalized wake word training UI hidden until feature is stable
      personalizeRow.style.display = 'none';
    }
  }
  updatePersonalizeVisibility();

  personalizeBtn?.addEventListener('click', () => {
    startPersonalizationWizard(OWW_KEYWORDS, OWW_KEYWORD_TO_MODEL, OWW_MODEL_META);
  });

  // Wakeword training tool
  const trainingBtn = document.getElementById('wakeword-training-btn');
  trainingBtn?.addEventListener('click', () => {
    startTrainingTool();
  });

  // Pipeline debug selector
  const pipelineDebugRow = document.getElementById('oww-pipeline-debug');
  const pipelineSelect = document.getElementById('oww-pipeline-select') as HTMLSelectElement;
  function updatePipelineDebugVisibility() {
    if (!pipelineDebugRow) return;
    const pipelines = getOwwPipelines();
    // Show if pipelines are available (regardless of engine — it's a debug tool)
    pipelineDebugRow.style.display = pipelines.length > 0 ? 'block' : 'none';
    if (pipelineSelect && pipelines.length > 0) {
      const current = getActivePipeline();
      let opts = '<option value="">(default)</option>';
      for (const p of pipelines) {
        opts += `<option value="${p}"${p === current ? ' selected' : ''}>${p}</option>`;
      }
      pipelineSelect.innerHTML = opts;
    }
  }
  updatePipelineDebugVisibility();
  // Re-check after server config loads (pipelines come from /config)
  bus.on('wakeword:config-loaded', updatePipelineDebugVisibility);
  pipelineSelect?.addEventListener('change', async () => {
    const label = pipelineSelect.value || 'default';
    showToast(`Pipeline: ${label} — reloading models…`, { severity: 'info', id: 'pipeline-switch' });
    const result = await setActivePipeline(pipelineSelect.value);
    if (result.error) {
      showToast(`Pipeline: ${label} — load failed: ${result.error}`, { severity: 'error', id: 'pipeline-switch' });
    } else if (result.reloaded) {
      const models = result.loadedModels || [];
      const summary = models.length > 0 ? models.join(', ') : 'none';
      showToast(`Pipeline: ${label} — ${models.length} model(s) loaded: ${summary}`, { severity: 'success', id: 'pipeline-switch' });
    } else {
      showToast(`Pipeline: ${label} (wakeword not active)`, { severity: 'info', id: 'pipeline-switch' });
    }
    // Refresh endword/cancelword dropdowns and bot keyword panel after pipeline switch
    refreshOwwEndwordSelects();
    renderBotSettingsPanel(settingsBotId);
  });

  // Text reply toggle
  const textReplyToggle = document.getElementById('text-reply-toggle') as HTMLInputElement;
  if (textReplyToggle) {
    import('../ui/app-state').then(({ isTextReplyEnabled, setTextReplyEnabled }) => {
      textReplyToggle.checked = isTextReplyEnabled();
      textReplyToggle.addEventListener('change', () => {
        setTextReplyEnabled(textReplyToggle.checked);
        syncSetting('textReplyEnabled', textReplyToggle.checked ? '1' : '0');
        const bar = document.getElementById('text-reply-bar');
        if (bar) bar.classList.toggle('show', textReplyToggle.checked);
      });
    });
  }

  // App language selector
  const appLangSelect = document.getElementById('app-language-select') as HTMLSelectElement | null;
  if (appLangSelect) {
    appLangSelect.value = getLocale();
    appLangSelect.addEventListener('change', () => {
      const newLocale = appLangSelect.value;
      setLocale(newLocale);
      syncSetting('locale', newLocale);
      applyI18nToDOM();
      // Sync STT language select to match app language
      // (only syncs zh-CN↔zh and en↔en; other STT values like 'auto'/'ja' are preserved)
      const sttLangSel = document.getElementById('stt-language-select') as HTMLSelectElement | null;
      if (sttLangSel) {
        const sttMap: Record<string, string> = { 'zh-CN': 'zh', 'en': 'en' };
        const sttLang = sttMap[newLocale];
        if (sttLang && sttLangSel.value !== sttLang) {
          sttLangSel.value = sttLang;
          syncSetting('sttLang', sttLang);
          ws.send({ type: 'set_stt_language', language: sttLang });
        }
      }
      // Sync TTS default voice for new locale
      import('../audio/azure-tts').then(({ azureTTS }) => {
        if ('setDefaultVoiceForLocale' in azureTTS) {
          (azureTTS as any).setDefaultVoiceForLocale(newLocale);
        }
      });
      showToast(t('toast.language_changed'));
      // Invalidate voice feedback cache so next wakeword play uses new locale's audio
      import('../ui/mic-ui').then(({ invalidateVoiceFeedback }) => {
        for (const id of BOT_IDS) invalidateVoiceFeedback(id);
      });
    });
  }

  // STT language select
  const sttLangSelect = document.getElementById('stt-language-select') as HTMLSelectElement;
  if (sttLangSelect) {
    const savedLang = (() => { try { return localStorage.getItem(STORAGE_KEY + 'sttLang') || 'en'; } catch (_e) { return 'en'; } })();
    sttLangSelect.value = savedLang;
    sttLangSelect.addEventListener('change', () => {
      const lang = sttLangSelect.value;
      syncSetting('sttLang', lang);
      ws.send({ type: 'set_stt_language', language: lang });
      showToast(t('toast.stt_lang_changed') + ': ' + sttLangSelect.options[sttLangSelect.selectedIndex].text);
    });
  }

  // STT model select
  const sttModelSelect = document.getElementById('stt-model-select') as HTMLSelectElement;
  if (sttModelSelect) {
    const savedModel = (() => { try { return localStorage.getItem(STORAGE_KEY + 'sttModel') || 'whisper-large-v3-turbo'; } catch (_e) { return 'whisper-large-v3-turbo'; } })();
    sttModelSelect.value = savedModel;
    sttModelSelect.addEventListener('change', () => {
      const model = sttModelSelect.value;
      syncSetting('sttModel', model);
      ws.send({ type: 'set_stt_model', model });
      showToast(t('toast.stt_model_changed') + ': ' + sttModelSelect.options[sttModelSelect.selectedIndex].text);
    });
  }

  // STT chunk duration (dropdown: 10/30/60/0=no-split)
  const sttChunkInput = document.getElementById('stt-chunk-duration') as HTMLSelectElement;
  if (sttChunkInput) {
    const savedSec = (() => { try { return localStorage.getItem(STORAGE_KEY + 'sttChunkMinSec') || '60'; } catch (_e) { return '60'; } })();
    // Match saved value to closest option
    const opts = Array.from(sttChunkInput.options).map(o => o.value);
    sttChunkInput.value = opts.includes(savedSec) ? savedSec : '60';
    sttChunkInput.addEventListener('change', () => {
      const sec = parseFloat(sttChunkInput.value);
      syncSetting('sttChunkMinSec', String(sec));
      if (sec > 0) {
        import('../recording/recording-utils').then(m => m.setChunkMinDurationMs(sec * 1000));
        showToast(t('settings.stt_chunk_toast', { sec }));
      } else {
        // 0 = no chunking — set very large value
        import('../recording/recording-utils').then(m => m.setChunkMinDurationMs(999999000));
        showToast(t('settings.stt_chunk_toast_no_split') || 'No chunking');
      }
    });
  }

  // STT custom vocabulary
  const sttVocabEl = document.getElementById('stt-vocab') as HTMLTextAreaElement;
  if (sttVocabEl) {
    const saved = (() => { try { return localStorage.getItem(STORAGE_KEY + 'sttVocab') || ''; } catch (_e) { return ''; } })();
    sttVocabEl.value = saved;
    sttVocabEl.addEventListener('change', () => {
      syncSetting('sttVocab', sttVocabEl.value);
      showToast(t('settings.stt_vocab_saved'));
    });
  }

  // Terminal mirror (tmux) toggle
  const tmuxMirrorToggle = document.getElementById('tmux-mirror-toggle') as HTMLInputElement | null;
  if (tmuxMirrorToggle) {
    // Load initial state from shared settings
    const stored = localStorage.getItem(STORAGE_KEY + 'sessionMode');
    tmuxMirrorToggle.checked = stored === 'observer';

    tmuxMirrorToggle.addEventListener('change', () => {
      const mode = tmuxMirrorToggle.checked ? 'observer' : 'controller';
      syncSetting('sessionMode', mode);
      showToast(tmuxMirrorToggle.checked
        ? t('settings.hint.tmux_mirror')
        : 'Headless mode enabled');
    });
  }

  // Groq Key management
  const groqKeyInput = document.getElementById('groq-key-input') as HTMLInputElement;
  const groqKeySaveBtn = document.getElementById('groq-key-save-btn') as HTMLButtonElement;
  const groqKeyStatus = document.getElementById('groq-key-status') as HTMLElement;

  async function refreshGroqKeyStatus(): Promise<void> {
    if (!groqKeyStatus) return;
    const sttModeStatus = document.getElementById('stt-mode-status');
    try {
      const resp = await fetch('/stt-config');
      const data = await resp.json();
      if (data.enabled || data.keyMasked) {
        groqKeyStatus.textContent = '\u2713 Connected';
        groqKeyStatus.style.color = '#4ade80';
        if (groqKeyInput) groqKeyInput.placeholder = data.keyMasked || 'gsk_...';
      } else {
        groqKeyStatus.textContent = 'Not configured';
        groqKeyStatus.style.color = '#eb4d4b';
        if (groqKeyInput) groqKeyInput.placeholder = 'gsk_...';
      }
      // STT mode indicator
      if (sttModeStatus) {
        if (data.apiKey) {
          sttModeStatus.textContent = 'Browser Direct';
          sttModeStatus.style.color = '#4ade80';
        } else if (data.enabled) {
          sttModeStatus.textContent = 'Server Relay';
          sttModeStatus.style.color = '#f59e0b';
        } else {
          sttModeStatus.textContent = '';
        }
      }
    } catch (_e) {
      if (groqKeyStatus) { groqKeyStatus.textContent = 'Error'; groqKeyStatus.style.color = '#eb4d4b'; }
    }
  }

  if (groqKeySaveBtn && groqKeyInput) {
    groqKeySaveBtn.addEventListener('click', async () => {
      const key = groqKeyInput.value.trim();
      if (!key) return;
      groqKeySaveBtn.disabled = true;
      groqKeySaveBtn.textContent = '...';
      try {
        const resp = await fetch('/setup/groq-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groqApiKey: key }),
        });
        const data = await resp.json();
        if (data.ok) {
          groqKeyInput.value = '';
          showToast('Groq Key saved');
        } else {
          showToast(data.error || 'Failed to save');
        }
      } catch (e) {
        showToast(String(e));
      }
      groqKeySaveBtn.disabled = false;
      groqKeySaveBtn.textContent = 'Save';
      refreshGroqKeyStatus();
    });
  }
  refreshGroqKeyStatus();

  // Azure Key management
  const azureKeyInput = document.getElementById('azure-key-input') as HTMLInputElement;
  const azureRegionInput = document.getElementById('azure-region-input') as HTMLInputElement;
  const azureKeySaveBtn = document.getElementById('azure-key-save-btn') as HTMLButtonElement;
  const azureKeyStatus = document.getElementById('azure-key-status') as HTMLElement;

  async function refreshAzureKeyStatus(): Promise<void> {
    if (!azureKeyStatus) return;
    try {
      const resp = await fetch('/speech-config');
      const data = await resp.json();
      if (data.azureEnabled) {
        azureKeyStatus.textContent = '\u2713 Browser Direct';
        azureKeyStatus.style.color = '#4ade80';
        if (azureKeyInput) azureKeyInput.placeholder = data.keyMasked || 'Key...';
      } else {
        azureKeyStatus.textContent = 'Edge TTS (server)';
        azureKeyStatus.style.color = '#f59e0b';
        if (azureKeyInput) azureKeyInput.placeholder = 'Key...';
      }
      if (azureRegionInput && data.regionValue) {
        azureRegionInput.placeholder = data.regionValue;
      }
    } catch (_e) {
      if (azureKeyStatus) { azureKeyStatus.textContent = 'Error'; azureKeyStatus.style.color = '#eb4d4b'; }
    }
  }

  if (azureKeySaveBtn && azureKeyInput) {
    azureKeySaveBtn.addEventListener('click', async () => {
      const key = azureKeyInput.value.trim();
      const region = azureRegionInput?.value.trim() || '';
      if (!key && !region) return;
      azureKeySaveBtn.disabled = true;
      azureKeySaveBtn.textContent = '...';
      try {
        const resp = await fetch('/setup/azure-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ azureKey: key, azureRegion: region }),
        });
        const data = await resp.json();
        if (data.ok) {
          azureKeyInput.value = '';
          if (azureRegionInput) azureRegionInput.value = '';
          showToast('Azure Speech Key saved');
        } else {
          showToast(data.error || 'Failed to save');
        }
      } catch (e) {
        showToast(String(e));
      }
      azureKeySaveBtn.disabled = false;
      azureKeySaveBtn.textContent = 'Save';
      refreshAzureKeyStatus();
    });
  }
  refreshAzureKeyStatus();

  // Azure TTS connection test
  const azureTtsTestBtn = document.getElementById('azure-tts-test-btn') as HTMLButtonElement;
  const azureTtsTestResult = document.getElementById('azure-tts-test-result') as HTMLElement;

  if (azureTtsTestBtn) {
    azureTtsTestBtn.addEventListener('click', async () => {
      azureTtsTestBtn.disabled = true;
      azureTtsTestBtn.textContent = 'Testing...';
      if (azureTtsTestResult) {
        azureTtsTestResult.textContent = '';
        azureTtsTestResult.style.color = '';
      }

      const testText = t('settings.preview_text');
      const { azureTTS } = await import('../audio/azure-tts');
      const { audioPlayer } = await import('../audio/audio-player');

      // Attempt 1: Azure browser-direct
      const t0 = performance.now();
      const azureAudio = await azureTTS.speak(testText);
      const azureLatency = Math.round(performance.now() - t0);

      if (azureAudio) {
        audioPlayer.enqueue(null, azureAudio, '');
        if (azureTtsTestResult) {
          azureTtsTestResult.textContent = `\u2713 Azure Direct \u00b7 ${azureLatency}ms`;
          azureTtsTestResult.style.color = '#4ade80';
        }
      } else {
        // Attempt 2: fallback to server-side Edge TTS
        const t1 = performance.now();
        try {
          const resp = await fetch('/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: testText }),
          });
          const data = await resp.json();
          const edgeLatency = Math.round(performance.now() - t1);
          if (data.audio) {
            audioPlayer.enqueue(null, data.audio, '');
            if (azureTtsTestResult) {
              azureTtsTestResult.textContent = `\u2717 Azure Failed \u00b7 Fallback Edge TTS \u00b7 ${edgeLatency}ms`;
              azureTtsTestResult.style.color = '#f59e0b';
            }
          } else {
            if (azureTtsTestResult) {
              azureTtsTestResult.textContent = '\u2717 TTS Unavailable';
              azureTtsTestResult.style.color = '#eb4d4b';
            }
          }
        } catch (_e) {
          if (azureTtsTestResult) {
            azureTtsTestResult.textContent = '\u2717 TTS Unavailable';
            azureTtsTestResult.style.color = '#eb4d4b';
          }
        }
      }

      azureTtsTestBtn.disabled = false;
      azureTtsTestBtn.textContent = 'Test Azure TTS';
    });
  }

  // Wake lock (screen always on)
  const wakeLockToggle = document.getElementById('wake-lock-toggle') as HTMLInputElement;
  if (wakeLockToggle) {
    let wakeLockSentinel: WakeLockSentinel | null = null;
    let iosWakeLockVideo: HTMLVideoElement | null = null;
    let nativeKeepAwake = false;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const IOS_SILENT_MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAW1bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAjt0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGzbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAR5zdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2Mi4xMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAe/+EAGGdCwB7ZH4iIwEQAAAMABAAAAwAIPFi5IAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAFDAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAEAAEAAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAAoYAAAABAAAAFHN0Y28AAAAAAAAAAQAABfoAAAKldHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAgAAAAAAAAH0AAAAAAAAAAAAAAABAQAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAB9AAABAAAAQAAAAACHW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAArEQAAFoiVcQAAAAAAC1oZGxyAAAAAAAAAABzb3VuAAAAAAAAAAAAAAAAU291bmRIYW5kbGVyAAAAAchtaW5mAAAAEHNtaGQAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYxzdGJsAAAAfnN0c2QAAAAAAAAAAQAAAG5tcDRhAAAAAAAAAAEAAAAAAAAAAAABABAAAAAArEQAAAAAADZlc2RzAAAAAAOAgIAlAAIABICAgBdAFQAAAAAAPoAAAAaCBYCAgAUSCFblAAaAgIABAgAAABRidHJ0AAAAAAAAPoAAAAaCAAAAIHN0dHMAAAAAAAAAAgAAABYAAAQAAAAAAQAAAiIAAAAoc3RzYwAAAAAAAAACAAAAAQAAAAEAAAABAAAAAgAAABYAAAABAAAAcHN0c3oAAAAAAAAAAAAAABcAAAAVAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAABhzdGNvAAAAAAAAAAIAAAXlAAAIgAAAABpzZ3BkAQAAAHJvbGwAAAACAAAAAf//AAAAHHNiZ3AAAAAAcm9sbAAAAAEAAAAXAAAAAQAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDAAAAAIZnJlZQAAAvttZGF03gIATGF2YzYyLjExLjEwMAACMEAOAAACcAYF//9s3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MToweDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAA5liIQFf///D0UAAULfgAEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAc=';

    function isIOS(): boolean {
      return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function ensureIosVideo(): HTMLVideoElement {
      if (iosWakeLockVideo) return iosWakeLockVideo;
      const v = document.createElement('video');
      v.setAttribute('playsinline', '');
      v.loop = true;
      v.style.cssText = 'position:fixed;left:-1px;top:-1px;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1';
      v.src = IOS_SILENT_MP4;
      document.body.appendChild(v);
      iosWakeLockVideo = v;
      return v;
    }

    async function requestWL(): Promise<void> {
      // Prefer native idle timer on iOS Capacitor — guaranteed to work
      nativeKeepAwake = await nativeSetKeepAwake(true);
      if (nativeKeepAwake) return;

      // Web fallback: Wake Lock API + iOS silent video hack
      if (navigator.wakeLock) {
        try {
          wakeLockSentinel = await navigator.wakeLock.request('screen');
          wakeLockSentinel.addEventListener('release', () => {
            wakeLockSentinel = null;
            if (wakeLockToggle.checked && document.visibilityState === 'visible') {
              setTimeout(() => requestWL(), 500);
            }
          });
        } catch (_e) { /* ignore */ }
      }
      if (isIOS()) {
        try { const v = ensureIosVideo(); await v.play(); } catch (_e) { /* deferred */ }
      }
    }

    function releaseWL(): void {
      if (nativeKeepAwake) { nativeSetKeepAwake(false); nativeKeepAwake = false; }
      if (wakeLockSentinel) { wakeLockSentinel.release(); wakeLockSentinel = null; }
      if (iosWakeLockVideo) { iosWakeLockVideo.pause(); }
    }

    const savedWL = (() => { try { return localStorage.getItem(STORAGE_KEY + 'wakeLock') !== 'off'; } catch (_e) { return true; } })();
    wakeLockToggle.checked = savedWL;
    if (savedWL) requestWL();

    // 30s heartbeat to re-acquire if lost
    setInterval(() => {
      if (!wakeLockToggle.checked || document.visibilityState !== 'visible') return;
      if (navigator.wakeLock && !wakeLockSentinel) requestWL();
      if (isIOS() && iosWakeLockVideo && iosWakeLockVideo.paused) {
        iosWakeLockVideo.play().catch(() => {});
      }
    }, 30000);

    // iOS: activate on first touch (video.play requires user gesture)
    if (isIOS()) {
      document.addEventListener('touchstart', function iosWLActivate() {
        document.removeEventListener('touchstart', iosWLActivate);
        if (wakeLockToggle.checked) requestWL();
      }, { once: true });
    }

    wakeLockToggle.addEventListener('change', () => {
      syncSetting('wakeLock', wakeLockToggle.checked ? 'on' : 'off');
      if (wakeLockToggle.checked) requestWL();
      else releaseWL();
    });
  }

  // Car mode button
  const carModeBtn = document.getElementById('car-mode-btn');
  carModeBtn?.addEventListener('click', () => bus.emit('ui:enter-car-mode'));

  pvDebugBtn?.addEventListener('click', () => {
    void runPvDebugCheck();
  });
  pvAdoptBtn?.addEventListener('click', () => {
    void runPvAdoptLegacy();
  });
  pvClearBtn?.addEventListener('click', () => {
    void runPvClearLocalData();
  });
}

// ---- End word / Cancel word bindings ----
const _endwordInput = document.getElementById('endword-input') as HTMLInputElement | null;
const _pvEndwordSelect = document.getElementById('pv-endword-select') as HTMLSelectElement | null;
const _cancelwordInput = document.getElementById('cancelword-input') as HTMLInputElement | null;
const _pvCancelwordSelect = document.getElementById('pv-cancelword-select') as HTMLSelectElement | null;

// Restore saved values
(() => {
  try {
    const ew = localStorage.getItem(STORAGE_KEY + 'endWord') || t('wakeword.default_end_word');
    if (_endwordInput) _endwordInput.value = ew;
  } catch (_e) { /* ignore */ }
  try {
    const cw = localStorage.getItem(STORAGE_KEY + 'cancelWord') || t('wakeword.default_cancel_word');
    if (_cancelwordInput) _cancelwordInput.value = cw;
  } catch (_e) { /* ignore */ }
})();

// Text input change handlers (for OWW engine)
_endwordInput?.addEventListener('change', () => {
  try { localStorage.setItem(STORAGE_KEY + 'endWord', _endwordInput.value); } catch (_e) { /* ignore */ }
  saveSharedSettings({ endWord: _endwordInput.value });
});
_cancelwordInput?.addEventListener('change', () => {
  try { localStorage.setItem(STORAGE_KEY + 'cancelWord', _cancelwordInput.value); } catch (_e) { /* ignore */ }
  saveSharedSettings({ cancelWord: _cancelwordInput.value });
});

// Rebuild PV endword/cancelword select options (disable already-used keywords)
function refreshPvEndwordSelects(): void {
  if (!_pvEndwordSelect || !_pvCancelwordSelect) return;
  const usedEw = getUsedPvKeywords('endword');
  const usedCw = getUsedPvKeywords('cancelword');
  [
    { sel: _pvEndwordSelect, current: pvEndword, used: usedEw },
    { sel: _pvCancelwordSelect, current: pvCancelword, used: usedCw },
  ].forEach(({ sel, current, used }) => {
    sel.innerHTML = `<option value="">${t('settings.announce_voice_none')}</option>`;
    for (const kw of PV_BUILTIN_KEYWORDS) {
      const opt = document.createElement('option');
      opt.value = kw; opt.textContent = kw;
      if (used.has(kw)) opt.disabled = true;
      if (kw === current) opt.selected = true;
      sel.appendChild(opt);
    }
  });
}

// PV select change handlers
_pvEndwordSelect?.addEventListener('change', () => {
  setPvEndword(_pvEndwordSelect.value);
  try { localStorage.setItem(STORAGE_KEY + 'pvEndword', _pvEndwordSelect.value); } catch (_e) { /* ignore */ }
  saveSharedSettings({ pvEndword: _pvEndwordSelect.value });
  refreshPvEndwordSelects();
  if (getInputMode() === 'wakeword') {
    stopWakeWord(); setTimeout(() => startWakeWord(), 400);
  }
});
_pvCancelwordSelect?.addEventListener('change', () => {
  setPvCancelword(_pvCancelwordSelect.value);
  try { localStorage.setItem(STORAGE_KEY + 'pvCancelword', _pvCancelwordSelect.value); } catch (_e) { /* ignore */ }
  saveSharedSettings({ pvCancelword: _pvCancelwordSelect.value });
  refreshPvEndwordSelects();
  if (getInputMode() === 'wakeword') {
    stopWakeWord(); setTimeout(() => startWakeWord(), 400);
  }
});

// ---- OWW end/cancel word select bindings ----
const _owwEndwordSelect = document.getElementById('oww-endword-select') as HTMLSelectElement | null;
const _owwCancelwordSelect = document.getElementById('oww-cancelword-select') as HTMLSelectElement | null;

function refreshOwwEndwordSelects(): void {
  if (_owwEndwordSelect) {
    const usedEw = getUsedOwwKeywords('endword');
    _owwEndwordSelect.innerHTML = '<option value="">' + t('settings.announce_voice_none') + '</option>';
    for (const kw of OWW_KEYWORDS) {
      const opt = document.createElement('option');
      opt.value = kw; opt.textContent = kw;
      if (kw === owwEndwordKeyword) opt.selected = true;
      if (usedEw.has(kw)) opt.disabled = true;
      _owwEndwordSelect.appendChild(opt);
    }
  }
  if (_owwCancelwordSelect) {
    const usedCw = getUsedOwwKeywords('cancelword');
    _owwCancelwordSelect.innerHTML = '<option value="">' + t('settings.announce_voice_none') + '</option>';
    for (const kw of OWW_KEYWORDS) {
      const opt = document.createElement('option');
      opt.value = kw; opt.textContent = kw;
      if (kw === owwCancelwordKeyword) opt.selected = true;
      if (usedCw.has(kw)) opt.disabled = true;
      _owwCancelwordSelect.appendChild(opt);
    }
  }
}

_owwEndwordSelect?.addEventListener('change', () => {
  setOwwEndwordKeyword(_owwEndwordSelect.value);
  try { localStorage.setItem(STORAGE_KEY + 'owwEndword', _owwEndwordSelect.value); } catch (_e) { /* ignore */ }
  refreshOwwEndwordSelects();
  renderBotSettingsPanel(settingsBotId);
  if (getInputMode() === 'wakeword') {
    stopWakeWord(); setTimeout(() => startWakeWord(), 400);
  }
});
_owwCancelwordSelect?.addEventListener('change', () => {
  setOwwCancelwordKeyword(_owwCancelwordSelect.value);
  try { localStorage.setItem(STORAGE_KEY + 'owwCancelword', _owwCancelwordSelect.value); } catch (_e) { /* ignore */ }
  refreshOwwEndwordSelects();
  renderBotSettingsPanel(settingsBotId);
  if (getInputMode() === 'wakeword') {
    stopWakeWord(); setTimeout(() => startWakeWord(), 400);
  }
});

// ---- SKWS end/cancel word select bindings ----
const _skwsEndwordSelect = document.getElementById('skws-endword-select') as HTMLSelectElement | null;
const _skwsCancelwordSelect = document.getElementById('skws-cancelword-select') as HTMLSelectElement | null;

function refreshSkwsEndwordSelects(): void {
  if (_skwsEndwordSelect) {
    const usedEw = getUsedSkwsKeywords('endword');
    _skwsEndwordSelect.innerHTML = '<option value="">' + t('settings.announce_voice_none') + '</option>';
    for (const kw of SHERPA_KWS_KEYWORDS) {
      const opt = document.createElement('option');
      opt.value = kw; opt.textContent = kw;
      if (kw === skwsEndwordKeyword) opt.selected = true;
      if (usedEw.has(kw)) opt.disabled = true;
      _skwsEndwordSelect.appendChild(opt);
    }
  }
  if (_skwsCancelwordSelect) {
    const usedCw = getUsedSkwsKeywords('cancelword');
    _skwsCancelwordSelect.innerHTML = '<option value="">' + t('settings.announce_voice_none') + '</option>';
    for (const kw of SHERPA_KWS_KEYWORDS) {
      const opt = document.createElement('option');
      opt.value = kw; opt.textContent = kw;
      if (kw === skwsCancelwordKeyword) opt.selected = true;
      if (usedCw.has(kw)) opt.disabled = true;
      _skwsCancelwordSelect.appendChild(opt);
    }
  }
}

_skwsEndwordSelect?.addEventListener('change', () => {
  setSkwsEndwordKeyword(_skwsEndwordSelect.value);
  try { localStorage.setItem(STORAGE_KEY + 'skwsEndword', _skwsEndwordSelect.value); } catch (_e) { /* ignore */ }
  refreshSkwsEndwordSelects();
  renderBotSettingsPanel(settingsBotId);
  if (getInputMode() === 'wakeword') {
    stopWakeWord(); setTimeout(() => startWakeWord(), 400);
  }
});
_skwsCancelwordSelect?.addEventListener('change', () => {
  setSkwsCancelwordKeyword(_skwsCancelwordSelect.value);
  try { localStorage.setItem(STORAGE_KEY + 'skwsCancelword', _skwsCancelwordSelect.value); } catch (_e) { /* ignore */ }
  refreshSkwsEndwordSelects();
  renderBotSettingsPanel(settingsBotId);
  if (getInputMode() === 'wakeword') {
    stopWakeWord(); setTimeout(() => startWakeWord(), 400);
  }
});

function updateEndwordVisibility(): void {
  const wwMode = getInputMode() === 'wakeword';
  const pvAvailable = isPicovoiceKeyExposed();
  // Auto-downgrade: if user had picovoice selected but key is no longer exposed
  if (getWwEngine() === 'picovoice' && !pvAvailable) {
    setWwEngine('openwakeword');
  }
  const engine = getWwEngine();
  const isPv = engine === 'picovoice';
  const isOww = engine === 'openwakeword';
  const isSkws = engine === 'sherpa-onnx-kws';
  const endwordSetting = document.getElementById('endword-setting');
  const cancelwordSetting = document.getElementById('cancelword-setting');
  const wwEngineSetting = document.getElementById('ww-engine-setting');
  const wwBargeInSetting = document.getElementById('ww-bargein-setting');
  const botWwSetting = document.getElementById('bot-wakeword-setting');
  const voiceprintSetting = document.getElementById('voiceprint-setting');
  const wwThresholdSetting = document.getElementById('ww-threshold-setting');
  const hasOwwModels = OWW_KEYWORDS.length > 0;
  // Endword/cancelword: show for PV, OWW (with models), or SKWS
  const showEndCancel = wwMode && (isPv || (isOww && hasOwwModels) || isSkws);
  if (endwordSetting) endwordSetting.style.display = showEndCancel ? '' : 'none';
  if (cancelwordSetting) cancelwordSetting.style.display = showEndCancel ? '' : 'none';
  // Show engine selector when PicoVoice key is exposed OR Sherpa KWS models are available
  if (wwEngineSetting) wwEngineSetting.style.display = (wwMode && (pvAvailable || isSherpaKwsAvailable())) ? '' : 'none';
  if (wwThresholdSetting) wwThresholdSetting.style.display = (wwMode && !isPv) ? '' : 'none';
  if (wwBargeInSetting) wwBargeInSetting.style.display = wwMode ? '' : 'none';
  const wwMicAecSetting = document.getElementById('ww-mic-aec-setting');
  if (wwMicAecSetting) wwMicAecSetting.style.display = wwMode ? '' : 'none';
  const wwVadGateSetting = document.getElementById('ww-vad-gate-setting');
  if (wwVadGateSetting) wwVadGateSetting.style.display = (wwMode && !isPv) ? '' : 'none';
  if (botWwSetting) botWwSetting.style.display = wwMode ? '' : 'none';
  const botWwHint = document.getElementById('bot-wakeword-hint');
  if (botWwHint) botWwHint.style.display = wwMode ? 'none' : '';
  if (voiceprintSetting) voiceprintSetting.style.display = wwMode ? '' : 'none';
  // Only show PicoVoice debug section when key is exposed (developer mode)
  const pvDebugSection = document.getElementById('pv-debug-section');
  if (pvDebugSection) pvDebugSection.style.display = pvAvailable ? '' : 'none';
  // Toggle controls per engine: text input always hidden
  if (_endwordInput) _endwordInput.style.display = 'none';
  if (_pvEndwordSelect) _pvEndwordSelect.style.display = (wwMode && isPv) ? '' : 'none';
  if (_owwEndwordSelect) _owwEndwordSelect.style.display = (wwMode && isOww && hasOwwModels) ? '' : 'none';
  if (_skwsEndwordSelect) _skwsEndwordSelect.style.display = (wwMode && isSkws) ? '' : 'none';
  if (_cancelwordInput) _cancelwordInput.style.display = 'none';
  if (_pvCancelwordSelect) _pvCancelwordSelect.style.display = (wwMode && isPv) ? '' : 'none';
  if (_owwCancelwordSelect) _owwCancelwordSelect.style.display = (wwMode && isOww && hasOwwModels) ? '' : 'none';
  if (_skwsCancelwordSelect) _skwsCancelwordSelect.style.display = (wwMode && isSkws) ? '' : 'none';
  if (wwMode && isPv) refreshPvEndwordSelects();
  if (wwMode && isOww && hasOwwModels) refreshOwwEndwordSelects();
  if (wwMode && isSkws) refreshSkwsEndwordSelects();
}

// ---- Voice History ----

function _formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const isToday = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (isToday) return time;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function _statusBadge(entry: VoiceHistoryEntry): string {
  if (entry.cancelled) return `<span class="vh-badge vh-cancelled">${t('vh.status.cancelled')}</span>`;
  if (entry.status === 'sent') return `<span class="vh-badge vh-sent">${t('vh.status.sent')}</span>`;
  if (entry.status === 'transcribed') return `<span class="vh-badge vh-transcribed">${t('vh.status.transcribed')}</span>`;
  return `<span class="vh-badge vh-recorded">${t('vh.status.recorded')}</span>`;
}

function renderVoiceHistoryList(): void {
  const container = document.getElementById('voice-history-list');
  const countEl = document.getElementById('voice-history-count');
  if (!container) return;

  voiceHistoryStore.getAll().then(entries => {
    if (entries.length === 0) {
      container.innerHTML = `<div style="padding:12px;text-align:center;color:var(--text-dim);font-size:var(--user-font-size);">${t('vh.no_records')}</div>`;
      if (countEl) countEl.textContent = '';
      return;
    }
    if (countEl) countEl.textContent = t('vh.count', { count: entries.length });

    container.innerHTML = entries.map(e => {
      const id = e.id!;
      const name = getBotDisplayName(e.botId);
      const preview = e.transcript ? escHtml(e.transcript.slice(0, 50)) + (e.transcript.length > 50 ? '…' : '') : `<i style="color:var(--text-dim)">${t('vh.no_text')}</i>`;
      return `<div class="vh-entry" data-vh-id="${id}" style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:var(--user-font-size);">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;">
          <span style="font-weight:600;">${escHtml(name)}</span>
          <span style="color:var(--text-dim);">${_formatTime(e.createdAt)}</span>
          ${_statusBadge(e)}
        </div>
        <div style="margin-bottom:6px;line-height:1.4;user-select:text;cursor:text;">${preview}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="vh-btn vh-play" data-vh-id="${id}" title="${t('vh.btn.play')}">${t('vh.btn.play')}</button>
          <button class="vh-btn vh-copy" data-vh-id="${id}" title="${t('vh.btn.copy')}">${t('vh.btn.copy')}</button>
          <button class="vh-btn vh-retranscribe" data-vh-id="${id}" title="${t('vh.btn.retranscribe')}">${t('vh.btn.retranscribe')}</button>
          <button class="vh-btn vh-resend" data-vh-id="${id}" title="${t('vh.btn.resend')}">${t('vh.btn.resend')}</button>
          <button class="vh-btn vh-delete" data-vh-id="${id}" title="${t('vh.btn.delete')}">🗑</button>
        </div>
      </div>`;
    }).join('');
  });
}

// Re-encode audio buffer into a proper webm blob via Web Audio API.
// Useful for legacy recordings saved without the webm header — browsers can decode
// them but STT APIs (Groq) reject them.  We decode → re-encode via MediaRecorder.
async function _reencodeAudio(buffer: ArrayBuffer): Promise<Blob> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(buffer.slice(0)); // slice to avoid detach
  const offCtx = new OfflineAudioContext(decoded.numberOfChannels, decoded.length, decoded.sampleRate);
  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offCtx.destination);
  src.start();
  const rendered = await offCtx.startRendering();

  // Play rendered buffer through a MediaStreamDestination to capture via MediaRecorder
  const playCtx = new AudioContext();
  const dest = playCtx.createMediaStreamDestination();
  const playSrc = playCtx.createBufferSource();
  playSrc.buffer = rendered;
  playSrc.connect(dest);

  return new Promise<Blob>((resolve, reject) => {
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    rec.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) chunks.push(e.data); };
    rec.onstop = () => {
      playCtx.close().catch(() => {});
      ctx.close().catch(() => {});
      if (chunks.length) resolve(new Blob(chunks, { type: 'audio/webm;codecs=opus' }));
      else reject(new Error('re-encode produced no data'));
    };
    rec.onerror = () => reject(new Error('MediaRecorder error during re-encode'));
    rec.start();
    playSrc.start();
    playSrc.onended = () => rec.stop();
  });
}

function initVoiceHistory(): void {
  const container = document.getElementById('voice-history-list');
  const clearBtn = document.getElementById('voice-history-clear-btn');

  clearBtn?.addEventListener('click', () => {
    voiceHistoryStore.clearAll().then(() => renderVoiceHistoryList());
  });

  container?.addEventListener('click', async (ev) => {
    const btn = (ev.target as HTMLElement).closest('[data-vh-id]') as HTMLElement | null;
    if (!btn || !btn.classList.contains('vh-btn')) return;
    const id = Number(btn.getAttribute('data-vh-id'));
    if (!id || id < 0) return;

    const entry = await voiceHistoryStore.getEntry(id);
    if (!entry) return;

    if (btn.classList.contains('vh-play')) {
      const { audioPlayer } = await import('../audio/audio-player');
      audioPlayer.enqueue(null, entry.audioB64, '');
    } else if (btn.classList.contains('vh-copy')) {
      if (entry.transcript) {
        try { await navigator.clipboard.writeText(entry.transcript); showToast(t('toast.copied')); } catch (_e) { showToast(t('toast.copy_failed')); }
      } else {
        showToast(t('toast.no_text_to_copy'));
      }
    } else if (btn.classList.contains('vh-retranscribe')) {
      btn.textContent = '⏳';
      btn.classList.add('vh-loading');
      try {
        const b = atob(entry.audioB64);
        const arr = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
        let blob: Blob = new Blob([arr], { type: 'audio/webm;codecs=opus' });
        const { browserSTT } = await import('../audio/browser-stt');
        const sttLang = (document.getElementById('stt-language-select') as HTMLSelectElement | null)?.value || 'en';
        let text: string | null = null;
        try {
          text = await browserSTT.transcribe(blob, sttLang);
        } catch (_e1) {
          // First attempt failed (e.g. headerless webm) — re-encode via Web Audio API
          blob = await _reencodeAudio(arr.buffer);
          text = await browserSTT.transcribe(blob, sttLang);
        }
        if (text) {
          await voiceHistoryStore.updateTranscript(id, text);
          showToast(t('toast.transcription_done', { text: text.slice(0, 30) }));
        } else {
          showToast(t('toast.no_content_recognized'));
        }
      } catch (_e) {
        showToast(t('toast.transcription_failed'));
      }
      renderVoiceHistoryList();
    } else if (btn.classList.contains('vh-resend')) {
      const { outbox } = await import('../network/outbox');
      if (entry.transcript) {
        const msgId = ws.nextMsgId();
        bus.emit('chat:add-user-msg', { botId: entry.botId, text: entry.transcript, clientMsgId: msgId });
        outbox.enqueue({ type: 'text', text: entry.transcript, botId: entry.botId }, msgId);
      } else {
        outbox.enqueue({ type: 'audio', audioB64: entry.audioB64, botId: entry.botId });
      }
      await voiceHistoryStore.updateStatus(id, 'sent');
      showToast(t('toast.resent'));
      renderVoiceHistoryList();
    } else if (btn.classList.contains('vh-delete')) {
      await voiceHistoryStore.deleteEntry(id);
      const row = container?.querySelector(`.vh-entry[data-vh-id="${id}"]`);
      if (row) row.remove();
      const countEl = document.getElementById('voice-history-count');
      const remaining = container?.querySelectorAll('.vh-entry').length || 0;
      if (countEl) countEl.textContent = remaining ? t('vh.count', { count: remaining }) : '';
      if (!remaining && container) {
        container.innerHTML = `<div style="padding:12px;text-align:center;color:var(--text-dim);font-size:var(--user-font-size);">${t('vh.no_records')}</div>`;
      }
    }
  });
}
