// Wakeword Manager — dispatches between Picovoice and OpenWakeWord engines
// Ported from app.js wakeword section

import { bus } from '../core/event-bus';
import { createLogger } from '../logging/logger';
import { BOT_IDS, STORAGE_KEY } from '../core/types';
import { isNativeWakeWordAvailable, startNativeWakeWord, stopNativeWakeWord, saveNativeWakeWordConfig } from '../platform/native-wakeword';
import type { WakewordEngine } from '../core/types';
import {
  getCurrentBotId, setCurrentBotId, getInputMode, setInputMode,
  getWwEngine, setWwEngine, getBotNames, getUnreadCount, setUnreadCount,
  showToast, syncSetting,
  flushDeferredReads, interruptBot,
} from '../ui/app-state';
import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import { updateWwToggle, updateListeningBanner, updateBadges, setVoiceRipple, playVoiceFeedback, getHintEl, setWwToggleLoading } from '../ui/mic-ui';
import { setInitOverlay } from '../ui/app-state';
import { audioPlayer } from '../audio/audio-player';
import {
  getMicStream, newRecorder, buildRecordingBlob, blobToBase64, createStreamAnalyser, computeRMS,
  createSilenceDetector, createChunkedTranscriptionSession,
  getChunkMinDurationMs, SILENCE_THRESHOLD, SILENCE_TRIGGER_MS,
} from '../recording/recording-utils';
import type { ChunkedTranscriptionSession } from '../recording/recording-utils';
import * as ws from '../network/ws-client';
import { outbox } from '../network/outbox';
import { voiceHistoryStore } from '../store/voice-history-store';
import { t } from '../i18n';
import {
  feedAudioSamples, verifySpeaker, isVoiceprintEnabled, hasEnrollment, initVoiceprint,
} from './voiceprint-verifier';
import { ensureWakewordScripts } from '../core/script-loader';

function _saveToHistory(b64: string, botId: string, opts: { transcript?: string; cancelled?: boolean; status?: 'recorded' | 'transcribed' | 'sent' } = {}): void {
  voiceHistoryStore.saveRecording({
    botId,
    audioB64: b64,
    transcript: opts.transcript || '',
    status: opts.status || 'sent',
    cancelled: opts.cancelled || false,
    createdAt: Date.now(),
  }).catch(() => {});
}

// Constants
const PV_BUILTIN_KEYWORDS = ['Jarvis','Alexa','Computer','Terminator','Blueberry','Bumblebee','Grapefruit','Americano','Grasshopper','Picovoice','Porcupine'];
let OWW_KEYWORDS = ['Hey Jarvis','Alexa','Hey Mycroft','Hey Rhasspy','Timer','Weather'];
let OWW_KEYWORD_TO_MODEL: Record<string, string> = {
  'Hey Jarvis': 'hey_jarvis_v0.1.onnx',
  'Alexa': 'alexa_v0.1.onnx',
  'Hey Mycroft': 'hey_mycroft_v0.1.onnx',
  'Hey Rhasspy': 'hey_rhasspy_v0.1.onnx',
  'Timer': 'timer_v0.1.onnx',
  'Weather': 'weather_v0.1.onnx',
};
const OWW_DEFAULT_THRESHOLD = 0.3;
const OWW_MIN_THRESHOLD = 0.05;
const OWW_MAX_THRESHOLD = 0.9;
let OWW_THRESHOLD = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + 'owwThreshold');
    const v = Number.parseFloat(raw || '');
    if (Number.isFinite(v) && v >= OWW_MIN_THRESHOLD && v <= OWW_MAX_THRESHOLD) return v;
  } catch (_e) { /* ignore */ }
  return OWW_DEFAULT_THRESHOLD;
})();
const DEFAULT_WW_MAPPING: Record<string, string> = {};
const SPEECH_GATE_VAD_THRESHOLD = 0.6; // Pause TTS when VAD speech prob exceeds this
const SPEECH_GATE_MIN_FRAMES = 6; // Require consecutive frames above threshold before pausing (~192ms at 32ms/frame)
const VAD_GATE_THRESHOLD = 0.3; // Skip keyword inference when VAD speech prob is below this (eliminates non-speech FP)
const VAD_GATE_HOLDOVER_MS = 2000; // Keep gate open for this duration after last speech detected
const VP_ENERGY_GATE_RMS = 0.01; // Picovoice path: minimum RMS to write into voiceprint ring buffer
const SPEECH_GATE_TIMEOUT_MS = 4000;    // Resume TTS after this timeout if no wake word detected
const IS_MOBILE_UA = /iphone|ipad|android|mobile/.test((navigator.userAgent || '').toLowerCase());
const DEFAULT_PV_SENSITIVITY = IS_MOBILE_UA ? 0.85 : 0.78;

// State
const wwMapping: Record<string, string> = (() => {
  try { const s = localStorage.getItem(STORAGE_KEY + 'wwMapping'); return s ? JSON.parse(s) : {...DEFAULT_WW_MAPPING}; } catch (_e) { return {...DEFAULT_WW_MAPPING}; }
})();
let wwPaused = false;
let wakeWordActive = false;

// iOS hybrid engine state: foreground uses JS OWW pipeline, background uses native AVAudioEngine.
// visibilitychange drives the switch; _iosKwToModel caches the keyword map for the native engine.
let _iosInBackground = false;
let _iosLifecycleSetup = false;
let _iosKwToModel: Record<string, string> = {};
let porcupineInstance: unknown = null;
let wakeWordStream: MediaStream | null = null;
let wakeWordRecorder: MediaRecorder | null = null;
let wakeWordChunks: Blob[] = [];
let wakeWordRecordingCancelled = false;
let _wwChunkRestart = false;
let _wwChunkSession: ChunkedTranscriptionSession | null = null;
let wakewordStarting = false;
let keywordIndexToBotId: string[] = [];
let wwSpeechRecog: { stop: () => void; abort?: () => void } | null = null;
let wwAllowBargeIn = (() => {
  try { return localStorage.getItem(STORAGE_KEY + 'wwAllowBargeIn') === '1'; } catch (_e) { return false; }
})();
let wwMicAec = (() => {
  try { return localStorage.getItem(STORAGE_KEY + 'wwMicAec') === '1'; } catch (_e) { return false; }
})();
let wwVadGate = (() => {
  try { return localStorage.getItem(STORAGE_KEY + 'wwVadGate') === '1'; } catch (_e) { return false; }
})();

// sherpa-onnx KWS engine state
let skwsInstance: unknown = null;
let skwsStream: unknown = null;
let skwsAudioCtx: AudioContext | null = null;
let skwsScriptNode: ScriptProcessorNode | null = null;
let skwsMicStream: MediaStream | null = null;
let skwsActive = false;
let skwsChunkQueue: Float32Array[] = [];
let skwsProcessing = false;
let skwsKeywordToBotId: Map<string, string> = new Map();

let SHERPA_KWS_KEYWORDS: string[] = [];
let SHERPA_KWS_AVAILABLE = false;

// Pipeline debug state
let OWW_PIPELINES: string[] = [];
let OWW_PIPELINE_MODELS: Record<string, Record<string, string>> = {};
let OWW_PIPELINE_META: Record<string, Record<string, { inputShape?: string }>> = {};
let _baseOwwKeywords: string[] = [];
let _baseOwwKeywordToModel: Record<string, string> = {};
let _baseOwwModelMeta: Record<string, { inputShape?: string; role?: string }> = {};
let _activePipeline: string = (() => {
  try { return localStorage.getItem(STORAGE_KEY + 'owwPipeline') || ''; } catch (_e) { return ''; }
})();
const SKWS_DEFAULT_THRESHOLD = 0.25;
const SKWS_MIN_THRESHOLD = 0.05;
const SKWS_MAX_THRESHOLD = 0.9;
let SKWS_THRESHOLD = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + 'skwsThreshold');
    const v = Number.parseFloat(raw || '');
    if (Number.isFinite(v) && v >= SKWS_MIN_THRESHOLD && v <= SKWS_MAX_THRESHOLD) return v;
  } catch (_e) { /* ignore */ }
  return SKWS_DEFAULT_THRESHOLD;
})();

let PICOVOICE_ACCESS_KEY = '';
let PICOVOICE_PPN = 'jarvis_wasm.ppn';
const ASSET_VERSION = (() => {
  try { return String((window as unknown as { ASSET_VERSION?: string }).ASSET_VERSION || ''); } catch (_e) { return ''; }
})();
const PICOVOICE_MODEL_VERSION = (() => {
  const n = Number.parseInt(ASSET_VERSION, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

function withAssetVersion(url: string): string {
  if (!ASSET_VERSION) return url;
  return url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(ASSET_VERSION);
}

let pvEndword = (() => { try { return localStorage.getItem(STORAGE_KEY + 'pvEndword') || ''; } catch (_e) { return ''; } })();
let pvCancelword = (() => { try { return localStorage.getItem(STORAGE_KEY + 'pvCancelword') || ''; } catch (_e) { return ''; } })();
let _pvEndwordEnabled = false;
let pvVoiceprintStream: MediaStream | null = null;
let pvVoiceprintCtx: AudioContext | null = null;
const KW_ENDWORD = '__endword__';
const KW_CANCELWORD = '__cancelword__';

// OWW end/cancel word state — unified model meta (inputShape, role hint)
let OWW_MODEL_META: Record<string, { inputShape?: string; role?: string }> = {};
let owwEndwordSession: unknown = null;
let owwCancelwordSession: unknown = null;
let owwEndwordKeyword = (() => { try { return localStorage.getItem(STORAGE_KEY + 'owwEndword') || ''; } catch (_e) { return ''; } })();
let owwCancelwordKeyword = (() => { try { return localStorage.getItem(STORAGE_KEY + 'owwCancelword') || ''; } catch (_e) { return ''; } })();
let skwsEndwordKeyword = (() => { try { return localStorage.getItem(STORAGE_KEY + 'skwsEndword') || ''; } catch (_e) { return ''; } })();
let skwsCancelwordKeyword = (() => { try { return localStorage.getItem(STORAGE_KEY + 'skwsCancelword') || ''; } catch (_e) { return ''; } })();
let _owwEndwordEnabled = false;

const PV_SENSITIVITY = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY + 'pvSensitivity');
    const v = Number.parseFloat(raw || '');
    if (Number.isFinite(v) && v >= 0.3 && v <= 0.95) return v;
  } catch (_e) { /* ignore */ }
  return DEFAULT_PV_SENSITIVITY;
})();

// Config from server (lazy-loaded so auth-protected deployments can login first)
let _configLoaded = false;
let _configLoading: Promise<void> | null = null;
let _configLoadError = '';
let _configKeyExposed = false;
export function isPicovoiceKeyExposed(): boolean { return _configKeyExposed; }
export function isSherpaKwsAvailable(): boolean { return SHERPA_KWS_AVAILABLE; }

// Pipeline debug exports
export function getOwwPipelines(): string[] { return OWW_PIPELINES; }
export function getActivePipeline(): string { return _activePipeline; }

function _applyPipeline(pipeline: string): void {
  if (!pipeline) {
    // Reset to base (no pipeline)
    OWW_KEYWORDS = [..._baseOwwKeywords];
    OWW_KEYWORD_TO_MODEL = {..._baseOwwKeywordToModel};
    OWW_MODEL_META = {..._baseOwwModelMeta};
    return;
  }
  const pipelineModels = OWW_PIPELINE_MODELS[pipeline];
  if (!pipelineModels) return;
  const pipelineMeta = OWW_PIPELINE_META[pipeline] || {};
  // Merge pipeline keywords into the base list, suffixing with pipeline name
  // so dropdowns show e.g. "Americano (A)" instead of bare "Americano"
  const pipelineKeywords = Object.keys(pipelineModels);
  const mergedKeywords = [..._baseOwwKeywords];
  const mergedModels = {..._baseOwwKeywordToModel};
  const mergedMeta: Record<string, { inputShape?: string; role?: string }> = {..._baseOwwModelMeta};
  for (const kw of pipelineKeywords) {
    const displayKw = `${kw} (${pipeline})`;
    mergedModels[displayKw] = pipelineModels[kw];
    if (pipelineMeta[kw]) mergedMeta[displayKw] = pipelineMeta[kw];
    // Replace base keyword with pipeline-suffixed version if it exists
    const baseIdx = mergedKeywords.indexOf(kw);
    if (baseIdx !== -1) {
      mergedKeywords[baseIdx] = displayKw;
    } else {
      mergedKeywords.push(displayKw);
    }
    // Remove the unsuffixed key from merged maps
    if (kw in mergedModels) delete mergedModels[kw];
    if (kw in mergedMeta) delete mergedMeta[kw];
  }
  OWW_KEYWORDS = mergedKeywords;
  OWW_KEYWORD_TO_MODEL = mergedModels;
  OWW_MODEL_META = mergedMeta;
}

export async function setActivePipeline(pipeline: string): Promise<{ reloaded: boolean; error?: string; loadedModels?: string[] }> {
  _activePipeline = pipeline;
  try { localStorage.setItem(STORAGE_KEY + 'owwPipeline', pipeline); } catch (_e) { /* ignore */ }
  _applyPipeline(pipeline);
  // Migrate keyword names (wwMapping, endword, cancelword) to match new pipeline suffix.
  // e.g. "Americano (A)" → "Americano (B)" when switching from A to B,
  // or "Americano" → "Americano (B)" when switching from default to B.
  const pipelineSuffix = pipeline ? ` (${pipeline})` : '';
  const pipelinePattern = / \([A-Za-z0-9]+\)$/;
  const migrateKw = (kw: string): string | null => {
    if (!kw || OWW_KEYWORD_TO_MODEL[kw]) return null; // already valid
    const baseKw = kw.replace(pipelinePattern, '');
    const newKw = pipeline ? baseKw + pipelineSuffix : baseKw;
    return (newKw !== kw && OWW_KEYWORD_TO_MODEL[newKw]) ? newKw : null;
  };
  let mappingChanged = false;
  for (const botId of Object.keys(wwMapping)) {
    const newKw = migrateKw(wwMapping[botId]);
    if (newKw) { wwMapping[botId] = newKw; mappingChanged = true; }
  }
  if (mappingChanged) saveWwMapping();
  // Migrate endword / cancelword selections
  const newEndword = migrateKw(owwEndwordKeyword);
  if (newEndword) { owwEndwordKeyword = newEndword; try { localStorage.setItem(STORAGE_KEY + 'owwEndword', newEndword); } catch (_e) { /* ignore */ } }
  const newCancelword = migrateKw(owwCancelwordKeyword);
  if (newCancelword) { owwCancelwordKeyword = newCancelword; try { localStorage.setItem(STORAGE_KEY + 'owwCancelword', newCancelword); } catch (_e) { /* ignore */ } }
  // Invalidate cached keyword sessions — model files change across pipelines
  // but cache keys are keyword names (e.g. "Americano"), so stale sessions
  // would be reused without this.
  for (const sess of Object.values(_owwCachedKeywordSessions)) { try { (sess as { release: () => void }).release(); } catch (_e) { /* ignore */ } }
  _owwCachedKeywordSessions = {};
  if (_owwCachedEndwordSession) { try { (_owwCachedEndwordSession as { release: () => void }).release(); } catch (_e) { /* ignore */ } _owwCachedEndwordSession = null; _owwCachedEndwordKw = ''; }
  if (_owwCachedCancelwordSession) { try { (_owwCachedCancelwordSession as { release: () => void }).release(); } catch (_e) { /* ignore */ } _owwCachedCancelwordSession = null; _owwCachedCancelwordKw = ''; }
  // Reload wakeword sessions if currently active
  if (wakeWordActive && getWwEngine() === 'openwakeword') {
    stopWakeWord();
    try {
      await new Promise(r => setTimeout(r, 400));
      await startWakeWord();
      // Collect which models were actually loaded
      const loaded = Object.keys(owwKeywordSessions);
      return { reloaded: true, loadedModels: loaded };
    } catch (e) {
      return { reloaded: true, error: (e as Error).message };
    }
  }
  return { reloaded: false };
}

function _applyServerConfig(c: Record<string, unknown>): void {
  PICOVOICE_ACCESS_KEY = (c.picovoiceAccessKey as string) || '';
  PICOVOICE_PPN = (c.picovoicePpn as string) || PICOVOICE_PPN;
  _configKeyExposed = !!c.picovoiceKeyExposed;
  _configLoadError = '';
  if (Array.isArray(c.owwKeywords)) OWW_KEYWORDS = c.owwKeywords as string[];
  if (c.owwKeywordToModel && typeof c.owwKeywordToModel === 'object') {
    OWW_KEYWORD_TO_MODEL = c.owwKeywordToModel as Record<string, string>;
  }
  if (typeof c.owwThreshold === 'number' && c.owwThreshold > 0 && c.owwThreshold <= 1) {
    // Only use server threshold as default; user's local preference takes priority
    const userSaved = (() => { try { const r = localStorage.getItem(STORAGE_KEY + 'owwThreshold'); const v = Number.parseFloat(r || ''); return Number.isFinite(v) && v >= OWW_MIN_THRESHOLD && v <= OWW_MAX_THRESHOLD ? v : null; } catch (_e) { return null; } })();
    OWW_THRESHOLD = userSaved ?? c.owwThreshold as number;
  }
  // OWW unified model meta (inputShape, role hint for auto-assignment)
  if (c.owwModelMeta && typeof c.owwModelMeta === 'object') {
    OWW_MODEL_META = c.owwModelMeta as Record<string, { inputShape?: string; role?: string; externalData?: string }>;
  }
  if (Array.isArray(c.sherpaKwsKeywords)) SHERPA_KWS_KEYWORDS = c.sherpaKwsKeywords as string[];
  SHERPA_KWS_AVAILABLE = !!c.sherpaKwsAvailable;
  // Pipeline debug data
  if (Array.isArray(c.owwPipelines)) OWW_PIPELINES = c.owwPipelines as string[];
  if (c.owwPipelineModels && typeof c.owwPipelineModels === 'object') {
    OWW_PIPELINE_MODELS = c.owwPipelineModels as Record<string, Record<string, string>>;
  }
  if (c.owwPipelineMeta && typeof c.owwPipelineMeta === 'object') {
    OWW_PIPELINE_META = c.owwPipelineMeta as Record<string, Record<string, { inputShape?: string }>>;
  }
  // Save base (non-pipeline) keywords for pipeline switching
  _baseOwwKeywords = [...OWW_KEYWORDS];
  _baseOwwKeywordToModel = {...OWW_KEYWORD_TO_MODEL};
  _baseOwwModelMeta = {...OWW_MODEL_META};
  // Apply saved pipeline if available
  if (_activePipeline && OWW_PIPELINES.includes(_activePipeline)) {
    _applyPipeline(_activePipeline);
  }
  // Auto-assign endword/cancelword from role hints if none saved or saved keyword no longer in pool
  if (!owwEndwordKeyword || !OWW_KEYWORDS.includes(owwEndwordKeyword)) {
    const ew = OWW_KEYWORDS.find(kw => OWW_MODEL_META[kw]?.role === 'endword');
    if (ew) owwEndwordKeyword = ew;
    else owwEndwordKeyword = '';
  }
  if (!owwCancelwordKeyword || !OWW_KEYWORDS.includes(owwCancelwordKeyword)) {
    const cw = OWW_KEYWORDS.find(kw => OWW_MODEL_META[kw]?.role === 'cancelword');
    if (cw) owwCancelwordKeyword = cw;
    else owwCancelwordKeyword = '';
  }
}

async function ensureWakewordConfigLoaded(): Promise<void> {
  if (_configLoaded) return;
  if (_configLoading) {
    await _configLoading;
    return;
  }
  _configLoading = fetch(withAssetVersion('/config'))
    .then(async (r) => {
      if (!r.ok) throw new Error('/config ' + r.status);
      return r.json();
    })
    .then((c: Record<string, unknown>) => {
      _applyServerConfig(c);
      _configLoaded = true;
      bus.emit('wakeword:config-loaded');
    })
    .catch((e: unknown) => {
      _configLoadError = String((e as Error)?.message || e || 'config fetch failed');
      /* keep defaults and allow retry on next call */
    })
    .finally(() => {
      if (!_configLoaded) _configLoading = null;
    });
  await _configLoading;
}

const log = createLogger('wakeword');

function _persistWakewordError(msg: string): void {
  try { localStorage.setItem(STORAGE_KEY + 'lastWakewordError', String(msg || '').slice(0, 300)); } catch (_e) { /* ignore */ }
}

function _clearWakewordError(): void {
  try { localStorage.removeItem(STORAGE_KEY + 'lastWakewordError'); } catch (_e) { /* ignore */ }
}

// Cross-engine keyword mapping
const _OWW_TO_PV: Record<string, string> = { 'Hey Jarvis': 'Jarvis', 'Alexa': 'Alexa' };
const _PV_TO_OWW: Record<string, string> = { 'Jarvis': 'Hey Jarvis', 'Alexa': 'Alexa' };
const _OWW_TO_SKWS: Record<string, string | undefined> = { 'Hey Jarvis': 'jarvis' };
const _PV_TO_SKWS: Record<string, string | undefined> = {
  'Jarvis': 'jarvis', 'Terminator': 'terminator', 'Bumblebee': 'bumblebee',
  'Americano': 'americano', 'Grasshopper': 'grasshopper',
};
const _SKWS_TO_OWW: Record<string, string | undefined> = { 'jarvis': 'Hey Jarvis' };
const _SKWS_TO_PV: Record<string, string | undefined> = {
  'jarvis': 'Jarvis', 'terminator': 'Terminator', 'bumblebee': 'Bumblebee',
  'americano': 'Americano', 'grasshopper': 'Grasshopper',
};

function _migrateWwMapping(fromEngine: string, toEngine: string): void {
  if (fromEngine === toEngine) return;
  let map: Record<string, string | undefined> | null = null;
  if (toEngine === 'picovoice' && fromEngine === 'openwakeword') map = _OWW_TO_PV;
  else if (toEngine === 'openwakeword' && fromEngine === 'picovoice') map = _PV_TO_OWW;
  else if (toEngine === 'sherpa-onnx-kws' && fromEngine === 'openwakeword') map = _OWW_TO_SKWS;
  else if (toEngine === 'sherpa-onnx-kws' && fromEngine === 'picovoice') map = _PV_TO_SKWS;
  else if (toEngine === 'openwakeword' && fromEngine === 'sherpa-onnx-kws') map = _SKWS_TO_OWW;
  else if (toEngine === 'picovoice' && fromEngine === 'sherpa-onnx-kws') map = _SKWS_TO_PV;
  if (!map) return;
  const validTargets =
    toEngine === 'picovoice' ? PV_BUILTIN_KEYWORDS
    : toEngine === 'openwakeword' ? OWW_KEYWORDS
    : SHERPA_KWS_KEYWORDS;
  let changed = false;
  for (const botId of Object.keys(wwMapping)) {
    const kw = wwMapping[botId];
    if (!kw || validTargets.includes(kw)) continue;
    const mapped = map[kw];
    wwMapping[botId] = mapped ?? '';
    changed = true;
  }
  if (changed) saveWwMapping();
}

function saveWwMapping(): void {
  try { localStorage.setItem(STORAGE_KEY + 'wwMapping', JSON.stringify(wwMapping)); } catch (_e) { /* ignore */ }
  syncSetting('wwMapping', wwMapping);
}

function notifyWakeBlockedByReading(): void {
  showToast(t('toast.wakeword_heard_need_barge_in'));
}

// ---- PV DB backup/restore ----
const PV_DB_NAME = 'pv_db';
const PV_FILE_STORE = 'pv_file';
const PV_DB_VERSION = 3;

function _pvDeviceTag(): string {
  const KEY = STORAGE_KEY + 'pvDeviceTag';
  try {
    let tag = localStorage.getItem(KEY);
    if (!tag) {
      tag = 'dev_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
      localStorage.setItem(KEY, tag);
    }
    return tag;
  } catch (_e) { return 'default'; }
}

function _openPvDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PV_DB_NAME, PV_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PV_FILE_STORE)) db.createObjectStore(PV_FILE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _pvDbIsEmpty(): Promise<boolean> {
  try {
    const db = await _openPvDb();
    return new Promise((resolve) => {
      const tx = db.transaction(PV_FILE_STORE, 'readonly');
      const store = tx.objectStore(PV_FILE_STORE);
      const countReq = store.count();
      countReq.onsuccess = () => resolve(countReq.result === 0);
      countReq.onerror = () => resolve(true);
    });
  } catch (_e) { return true; }
}

async function _pvDbHasActivationMarkers(): Promise<boolean> {
  try {
    const db = await _openPvDb();
    return new Promise((resolve) => {
      const tx = db.transaction(PV_FILE_STORE, 'readonly');
      const store = tx.objectStore(PV_FILE_STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(false); return; }
        const k = String(cursor.key || '');
        if (k.includes('/etc/machine-id') || k.startsWith('~/.pv/') || k.includes('-porcupine')) {
          resolve(true);
          return;
        }
        cursor.continue();
      };
      req.onerror = () => resolve(false);
    });
  } catch (_e) { return false; }
}

async function _pvDbExportAll(): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  const db = await _openPvDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PV_FILE_STORE, 'readonly');
    const store = tx.objectStore(PV_FILE_STORE);
    const entries: Array<{ key: IDBValidKey; value: unknown }> = [];
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        let val = cursor.value;
        if (val instanceof Uint8Array) {
          val = { __type: 'Uint8Array', data: _uint8ToB64(val) };
        } else if (val instanceof ArrayBuffer) {
          val = { __type: 'ArrayBuffer', data: _uint8ToB64(new Uint8Array(val)) };
        } else if (val && typeof val === 'object') {
          val = JSON.parse(JSON.stringify(val, (_k, v) => {
            if (v instanceof Uint8Array) return { __type: 'Uint8Array', data: _uint8ToB64(v) };
            if (v instanceof ArrayBuffer) return { __type: 'ArrayBuffer', data: _uint8ToB64(new Uint8Array(v)) };
            return v;
          }));
        }
        entries.push({ key: cursor.key, value: val });
        cursor.continue();
      } else { resolve(entries); }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

function _uint8ToB64(u8: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

function _b64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function _reviveValue(val: unknown): unknown {
  if (val && typeof val === 'object' && (val as { __type?: string }).__type === 'Uint8Array') return _b64ToUint8Array((val as { data: string }).data);
  if (val && typeof val === 'object' && (val as { __type?: string }).__type === 'ArrayBuffer') return _b64ToUint8Array((val as { data: string }).data).buffer;
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    for (const k of Object.keys(val as Record<string, unknown>)) (val as Record<string, unknown>)[k] = _reviveValue((val as Record<string, unknown>)[k]);
  }
  return val;
}

async function _pvDbImportAll(entries: Array<{ key: IDBValidKey; value: unknown }>): Promise<void> {
  const db = await _openPvDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PV_FILE_STORE, 'readwrite');
    const store = tx.objectStore(PV_FILE_STORE);
    for (const entry of entries) store.put(_reviveValue(entry.value), entry.key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function pvDbBackupToServer(): Promise<void> {
  try {
    const entries = await _pvDbExportAll();
    if (!entries.length) return;
    const tag = _pvDeviceTag();
    await fetch('/pv-device/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceTag: tag, data: entries }),
    });
  } catch (_e) { /* ignore */ }
}

type PvDbRestoreResult = 'restored' | 'skip_local_ready' | 'no_backup' | 'error';

async function pvDbRestoreFromServer(): Promise<PvDbRestoreResult> {
  try {
    const empty = await _pvDbIsEmpty();
    if (!empty) {
      const hasActivation = await _pvDbHasActivationMarkers();
      if (hasActivation) return 'skip_local_ready';
      // Non-empty but looks like cache-only model files; allow server restore overlay.
    }
    const tag = _pvDeviceTag();
    const resp = await fetch('/pv-device/restore/' + encodeURIComponent(tag));
    if (!resp.ok) return 'error';
    const { data } = await resp.json();
    if (!data?.length) return 'no_backup';
    await _pvDbImportAll(data);
    log.debug('pvDbRestore: restored entries', { count: data.length, tag });
    return 'restored';
  } catch (_e) { return 'error'; }
}

async function _adoptServerBackupToCurrentTag(sourceTag = ''): Promise<boolean> {
  try {
    const tag = _pvDeviceTag();
    const body: Record<string, string> = { targetTag: tag };
    if (sourceTag.trim()) body.sourceTag = sourceTag.trim();
    const resp = await fetch('/pv-device/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data?.ok) return false;
    log.debug('pvDbAdopt', { sourceTag: String(data.sourceTag || '(auto)'), tag, entries: String(data.entries || 0) });
    return true;
  } catch (_e) { return false; }
}

export async function adoptLegacyPvDeviceRegistration(sourceTag = ''): Promise<boolean> {
  const adopted = await _adoptServerBackupToCurrentTag(sourceTag);
  if (!adopted) return false;
  const restored = await pvDbRestoreFromServer();
  return restored === 'restored' || restored === 'skip_local_ready';
}

// ---- Picovoice engine ----
async function startPicovoiceWakeWord(earlyMicP?: Promise<MediaStream | null> | null): Promise<void> {
  if (porcupineInstance) return;
  try {
    await ensureWakewordConfigLoaded();
    if (!PICOVOICE_ACCESS_KEY) {
      if (_configLoadError) {
        throw new Error(t('wakeword.err_config_failed', { error: _configLoadError }));
      }
      if (!_configKeyExposed) {
        throw new Error(t('wakeword.err_key_not_exposed'));
      }
      throw new Error(t('wakeword.err_key_empty'));
    }
    let restoreResult = await pvDbRestoreFromServer();
    if (restoreResult === 'no_backup') {
      const adopted = await _adoptServerBackupToCurrentTag();
      if (adopted) restoreResult = await pvDbRestoreFromServer();
    }

    // Warm-up mic permission: use early stream if available, otherwise request now
    const warmStream = earlyMicP ? await earlyMicP : await navigator.mediaDevices.getUserMedia({ audio: true });
    if (warmStream) warmStream.getTracks().forEach(t => t.stop());

    const activeKws: Array<{ botId: string; keyword: string }> = [];
    keywordIndexToBotId = [];
    for (const [botId, kw] of Object.entries(wwMapping)) {
      if (!BOT_IDS.includes(botId)) continue; // skip phantom/deleted bots
      if (!kw) continue;
      let resolved = kw;
      if (!PV_BUILTIN_KEYWORDS.includes(kw)) {
        resolved = _OWW_TO_PV[kw] || '';
        if (resolved) { wwMapping[botId] = resolved; saveWwMapping(); }
        else continue;
      }
      activeKws.push({ botId, keyword: resolved });
    }
    if (activeKws.length === 0) throw new Error(t('wakeword.err_no_keywords'));

    const hasEnglish = activeKws.some(k => PV_BUILTIN_KEYWORDS.includes(k.keyword));

    _pvEndwordEnabled = false;
    if (pvEndword && PV_BUILTIN_KEYWORDS.includes(pvEndword)) {
      activeKws.push({ botId: KW_ENDWORD, keyword: pvEndword });
      _pvEndwordEnabled = true;
    }
    if (pvCancelword && PV_BUILTIN_KEYWORDS.includes(pvCancelword)) {
      activeKws.push({ botId: KW_CANCELWORD, keyword: pvCancelword });
    }

    const keywords: Array<{ base64: string; label: string; sensitivity: number; forceWrite: boolean; version: number }> = [];
    for (let i = 0; i < activeKws.length; i++) {
      const { botId, keyword } = activeKws[i];
      keywordIndexToBotId[i] = botId;
      const ppnFilename = keyword.toLowerCase() + '_wasm.ppn';
      const ppnResp = await fetch(withAssetVersion('/wakeword/' + encodeURIComponent(ppnFilename)));
      if (!ppnResp.ok) throw new Error(`Failed to fetch ${ppnFilename}: ${ppnResp.status}`);
      const u8 = new Uint8Array(await ppnResp.arrayBuffer());
      let bin = '';
      for (let j = 0; j < u8.length; j++) bin += String.fromCharCode(u8[j]);
      keywords.push({ base64: btoa(bin), label: keyword, sensitivity: PV_SENSITIVITY, forceWrite: false, version: PICOVOICE_MODEL_VERSION });
    }

    const modelFilename = 'porcupine_params.pv';
    const pvResp = await fetch(withAssetVersion('/wakeword/' + modelFilename));
    if (!pvResp.ok) throw new Error(`Failed to fetch ${modelFilename}`);
    const pvU8 = new Uint8Array(await pvResp.arrayBuffer());
    let pvBin = '';
    for (let i = 0; i < pvU8.length; i++) pvBin += String.fromCharCode(pvU8[i]);
    const model = { base64: btoa(pvBin), forceWrite: false, version: PICOVOICE_MODEL_VERSION };

    const PorcupineWeb = (window as unknown as { PorcupineWeb?: { Porcupine: unknown }; Porcupine?: { Porcupine: unknown } }).PorcupineWeb?.Porcupine
      || (window as unknown as { Porcupine?: { Porcupine: unknown } }).Porcupine?.Porcupine;
    if (!PorcupineWeb) throw new Error('Porcupine SDK not loaded');

    porcupineInstance = await (PorcupineWeb as { create: (...args: unknown[]) => Promise<unknown> }).create(
      PICOVOICE_ACCESS_KEY,
      keywords,
      (detection: { index?: number; label?: string }) => {
        const keywordIndex = detection.index ?? 0;
        const role = keywordIndexToBotId[keywordIndex];
        if (role === KW_ENDWORD) {
          if (!micState.isActive) return;
          _wwChunkRestart = false;
          if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
          return;
        }
        if (role === KW_CANCELWORD) {
          if (micState.isActive) {
            _wwChunkRestart = false;
            wakeWordRecordingCancelled = true;
            if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
            showToast(t('toast.cancelled_recording'));
          }
          if (audioPlayer.state === 'playing' || audioPlayer.state === 'paused') {
            interruptBot(getCurrentBotId(), 'stopped_reading');
            showToast(t('toast.stopped_reading'));
          }
          // INV-WW-01: Do NOT cancel during processing states (awaiting/receiving/sending).
          // Cancel word only handles active recording and TTS playback (handled above).
          // During processing the user hasn't spoken, so detection is a false positive.
          return;
        }
        if (audioPlayer.state !== 'idle') {
          if (!wwAllowBargeIn) { notifyWakeBlockedByReading(); return; }
          // Voiceprint gate: verify speaker BEFORE interrupting playback
          if (isVoiceprintEnabled() && hasEnrollment()) {
            verifySpeaker('barge_in').then((match) => {
              if (!match) { log.debug('PV barge-in: voiceprint mismatch, keeping playback'); return; }
              interruptBot(getCurrentBotId());
              setTimeout(() => { if (!micState.isActive && getInputMode() === 'wakeword' && !wwPaused) handleWakeWithUnreadCheck(role); }, 80);
            });
          } else {
            interruptBot(getCurrentBotId());
            setTimeout(() => { if (!micState.isActive && getInputMode() === 'wakeword' && !wwPaused) handleWakeWithUnreadCheck(role); }, 80);
          }
          return;
        }
        if (micState.isActive || getInputMode() !== 'wakeword') return;
        handleWakeWithVoiceprintGate(role);
      },
      model,
    );

    const WebVoiceProcessor = (window as unknown as { WebVoiceProcessor?: { WebVoiceProcessor: { subscribe: (inst: unknown) => Promise<void> } } }).WebVoiceProcessor?.WebVoiceProcessor;
    if (!WebVoiceProcessor) throw new Error('WebVoiceProcessor not loaded');
    await WebVoiceProcessor.subscribe(porcupineInstance);

    // Tap mic stream for voiceprint ring buffer (Picovoice mode)
    if (isVoiceprintEnabled() && hasEnrollment()) {
      try {
        const vpStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } });
        const vpCtx = new AudioContext({ sampleRate: 16000 });
        const vpSource = vpCtx.createMediaStreamSource(vpStream);
        const vpNode = vpCtx.createScriptProcessor(4096, 1, 1);
        vpNode.onaudioprocess = (e) => {
          if (!wakeWordActive) return;
          const samples = e.inputBuffer.getChannelData(0);
          let sumSq = 0;
          for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
          const rms = Math.sqrt(sumSq / samples.length);
          // Feed voiceprint ring buffer only when energy indicates speech activity.
          if (rms >= VP_ENERGY_GATE_RMS) feedAudioSamples(samples);
          bus.emit('wakeword:audio-level', rms);
        };
        vpSource.connect(vpNode);
        vpNode.connect(vpCtx.destination);
        // Store refs for cleanup
        pvVoiceprintStream = vpStream;
        pvVoiceprintCtx = vpCtx;
      } catch (_e) { log.debug('PV voiceprint tap failed', { detail: String(_e) }); }
    }

    wakeWordActive = true;
    _clearWakewordError();
    pvDbBackupToServer();
  } catch (e) {
    const err = e as { name?: string; message?: string };
    const errType = String(err?.name || 'Error');
    const msg = String(err?.message || e || 'unknown error');
    const keyType = /iphone|ipad|android|mobile/i.test(navigator.userAgent) ? 'Mobile' : 'PC';
    const shortMsg = errType.includes('ActivationLimit')
      ? t('wakeword.err_device_limit', { keyType })
      : errType.includes('ActivationRefused')
        ? t('wakeword.err_key_rejected', { keyType })
        : errType.includes('ActivationThrottled')
          ? t('wakeword.err_rate_limited', { keyType })
          : errType.includes('Activation')
            ? t('wakeword.err_activation_failed', { keyType }) + errType
            : msg;
    _persistWakewordError(shortMsg);
    showToast(t('wakeword.init_failed') + shortMsg);
  }
}

// ---- openWakeWord ----
let owwActive = false;
let owwStream: MediaStream | null = null;
let owwAudioCtx: AudioContext | null = null;
let owwScriptNode: ScriptProcessorNode | null = null;
let owwMelSession: unknown = null;
let owwEmbSession: unknown = null;
let owwVadSession: unknown = null;
let owwKeywordSessions: Record<string, unknown> = {};
let owwKeywordToBotId: Record<string, string> = {};
let owwMelBuffer: Float32Array[] = [];
let owwEmbBuffer: Float32Array[] = [];
let owwVadState: { h: unknown; c: unknown } | null = null;
let owwVadSpeechProb = 0;
let owwVadLastSpeechTs = 0; // timestamp of last VAD frame above gate threshold
// Speech gate: pause TTS on human speech, resume after timeout
let speechGateActive = false;
let speechGateTimer: ReturnType<typeof setTimeout> | null = null;
let speechGateConsecutiveFrames = 0; // consecutive VAD frames above SPEECH_GATE_VAD_THRESHOLD
let owwVadSr: unknown = null;
let owwPrevChunkTail: Float32Array | null = null; // last 480 samples for mel overlap
let owwStartedAt = 0;
let _owwDebugCounter = 0;
const OWW_INIT_COOLDOWN_MS = 1500;
// EMA smoothing for keyword scores (matches reference implementation α=0.35)
const OWW_EMA_ALPHA = 0.35;
let owwEmaScores: Record<string, number> = {};
// Per-keyword detection cooldown (2s, matches reference implementation)
const OWW_DETECTION_COOLDOWN_MS = 2000;
let owwLastDetection: Record<string, number> = {};
// Recording feed bridge: lets recording stream audio feed into OWW pipeline for end/cancel word detection
let _owwPushChunk: ((chunk: Float32Array) => void) | null = null;
let _owwMuteOwnStream = false; // mute OWW's own mic stream chunk processing while recording feed is active
let _owwRecFeedCtx: AudioContext | null = null;
let _owwRecFeedNode: ScriptProcessorNode | null = null;
let _owwRecFeedSource: MediaStreamAudioSourceNode | null = null;

// Recording feed bridge: pipes recording stream audio into OWW pipeline
// so end/cancel word detection uses the same high-quality audio as recording.
function _startRecordingFeed(stream: MediaStream): void {
  if (!_owwPushChunk || !owwActive) return;
  _stopRecordingFeed(); // clean up any prior feed
  _owwMuteOwnStream = true;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    _owwRecFeedCtx = new AC({ sampleRate: 16000 });
    _owwRecFeedSource = _owwRecFeedCtx.createMediaStreamSource(stream);
    _owwRecFeedNode = _owwRecFeedCtx.createScriptProcessor(4096, 1, 1);
    const accum: number[] = [];
    const CHUNK_SIZE = 1280; // 80ms at 16kHz, matches OWW pipeline
    _owwRecFeedNode.onaudioprocess = (e) => {
      if (!owwActive || !_owwPushChunk) return;
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) accum.push(input[i]);
      while (accum.length >= CHUNK_SIZE) {
        _owwPushChunk(new Float32Array(accum.splice(0, CHUNK_SIZE)));
      }
    };
    _owwRecFeedSource.connect(_owwRecFeedNode);
    _owwRecFeedNode.connect(_owwRecFeedCtx.destination);
    log.debug('Recording feed bridge started');
  } catch (e) {
    log.warn('Failed to start recording feed bridge', { error: (e as Error).message });
    _owwMuteOwnStream = false; // fall back to OWW's own stream
  }
}

function _stopRecordingFeed(): void {
  if (!_owwRecFeedNode && !_owwRecFeedCtx) return;
  try { _owwRecFeedNode?.disconnect(); } catch (_e) { /* ignore */ }
  try { _owwRecFeedSource?.disconnect(); } catch (_e) { /* ignore */ }
  try { _owwRecFeedCtx?.close(); } catch (_e) { /* ignore */ }
  _owwRecFeedNode = null;
  _owwRecFeedSource = null;
  _owwRecFeedCtx = null;
  _owwMuteOwnStream = false;
  log.debug('Recording feed bridge stopped');
}

// Soft restart: reuse existing mic stream to avoid getUserMedia() permission
// prompts on mobile browsers.  Falls back to full restart when the engine's
// pipeline or stream is no longer alive.
function _restartWakeWord(): void {
  if (getInputMode() !== 'wakeword' || wwPaused) return;
  const engine = getWwEngine();

  // OWW soft restart: pipeline still active, stream still live
  if (engine === 'openwakeword' && owwActive && owwStream?.active && owwAudioCtx && owwAudioCtx.state !== 'closed') {
    owwEmaScores = {};
    owwLastDetection = {};
    if (owwAudioCtx.state === 'suspended') owwAudioCtx.resume().catch(() => {});
    log.debug('OWW soft restart (stream reused)');
    return;
  }

  // Sherpa KWS soft restart: pipeline still active, stream still live
  if (engine === 'sherpa-onnx-kws' && skwsActive && skwsMicStream?.active && skwsAudioCtx && skwsAudioCtx.state !== 'closed') {
    if (skwsAudioCtx.state === 'suspended') skwsAudioCtx.resume().catch(() => {});
    log.debug('Sherpa KWS soft restart (stream reused)');
    return;
  }

  // Full restart for Picovoice or when stream/pipeline is dead
  stopWakeWord();
  setTimeout(() => { if (getInputMode() === 'wakeword' && !wwPaused && !micState.isActive) startWakeWord(); }, 500);
}

function _clearSpeechGate(): void {
  if (speechGateTimer) { clearTimeout(speechGateTimer); speechGateTimer = null; }
  speechGateActive = false;
  speechGateConsecutiveFrames = 0;
}

function _activateSpeechGate(vadProb: number): void {
  speechGateActive = true;
  audioPlayer.pause();
  log.info('Speech gate: paused TTS for wake word detection', { vadProb, frames: SPEECH_GATE_MIN_FRAMES });
  speechGateTimer = setTimeout(() => {
    if (speechGateActive) {
      _clearSpeechGate();
      audioPlayer.resume();
      log.info('Speech gate timeout: resumed TTS');
    }
  }, SPEECH_GATE_TIMEOUT_MS);
}

// Cached ONNX sessions — survive stop/start cycles so restart is instant
let _owwCachedInfra: { mel: unknown; emb: unknown; vad: unknown } | null = null;
let _owwCachedKeywordSessions: Record<string, unknown> = {};
let _owwCachedEndwordSession: unknown = null;
let _owwCachedCancelwordSession: unknown = null;
let _owwCachedActiveKws: string[] = [];
let _owwCachedEndwordKw = '';
let _owwCachedCancelwordKw = '';

/**
 * Replace a keyword's ONNX session with one using personalized weights.
 * Uses the same .onnx graph but with custom .onnx.data from the personalization API.
 */
async function owwHotSwapKeywordWeights(
  keyword: string,
  graphUrl: string,
  weightsUrl: string,
): Promise<void> {
  const ort = (window as any).ort;
  const graphBuf = await fetch(graphUrl).then(r => r.arrayBuffer());
  const weightsBuf = await fetch(weightsUrl).then(r => r.arrayBuffer());

  // Determine the external data filename the .onnx graph references
  // This must match the data_location path in the ONNX model
  const dataFilename = graphUrl.split('/').pop()!.replace('.onnx', '.onnx.data');

  const session = await ort.InferenceSession.create(new Uint8Array(graphBuf), {
    executionProviders: ['wasm'],
    externalData: [{ path: dataFilename, data: new Uint8Array(weightsBuf) }],
  });

  // Dispose old session if it has a release method
  const oldSession = owwKeywordSessions[keyword] as any;
  if (oldSession?.release) {
    try { await oldSession.release(); } catch (_) { /* ignore */ }
  }

  owwKeywordSessions[keyword] = session;
  _owwCachedKeywordSessions[keyword] = session;
  log.info('Hot-swapped personalized weights', { keyword });
}

async function _owwLoadSessions(ort: { InferenceSession: { create: (url: string | Uint8Array, opts: unknown) => Promise<unknown> }; Tensor: new (type: string, data: unknown, dims: number[]) => unknown }, activeKws: string[]): Promise<void> {
  // Force single-threaded WASM — we only bundle non-threaded WASM files.
  // Also required for non-secure contexts (LAN over HTTP) where SharedArrayBuffer is unavailable.
  const ortEnv = (ort as unknown as { env?: { wasm?: { numThreads?: number; proxy?: boolean } } }).env;
  if (ortEnv?.wasm) {
    ortEnv.wasm.numThreads = 1;
    ortEnv.wasm.proxy = false;
  }

  const opts = { executionProviders: ['wasm'] };

  // Check if cached infra sessions can be reused
  if (!_owwCachedInfra) {
    log.info('OWW loading infrastructure models (first time)');
    const [melSess, embSess, vadSess] = await Promise.all([
      ort.InferenceSession.create(withAssetVersion('/wakeword/melspectrogram.onnx'), opts),
      ort.InferenceSession.create(withAssetVersion('/wakeword/embedding_model.onnx'), opts),
      ort.InferenceSession.create(withAssetVersion('/wakeword/silero_vad.onnx'), opts),
    ]);
    _owwCachedInfra = { mel: melSess, emb: embSess, vad: vadSess };
  } else {
    log.debug('OWW reusing cached infrastructure sessions');
  }
  owwMelSession = _owwCachedInfra.mel;
  owwEmbSession = _owwCachedInfra.emb;
  owwVadSession = _owwCachedInfra.vad;

  // Load keyword sessions (only load new ones, reuse cached)
  owwKeywordSessions = {};
  await Promise.all(activeKws.map(async (kw) => {
    if (_owwCachedKeywordSessions[kw]) {
      owwKeywordSessions[kw] = _owwCachedKeywordSessions[kw];
      return;
    }
    const modelFile = OWW_KEYWORD_TO_MODEL[kw];
    const url = withAssetVersion('/wakeword/' + modelFile);
    log.info('OWW loading model', { kw, modelFile, url });
    const sess = await ort.InferenceSession.create(url, opts);
    owwKeywordSessions[kw] = sess;
    _owwCachedKeywordSessions[kw] = sess;
    log.info('OWW model loaded OK', { kw });
  }));
  _owwCachedActiveKws = activeKws;

  // Load personalized weights if available
  try {
    const configResp = await fetch('/wakeword/personalized');
    if (configResp.ok) {
      const { keywords: personalizedKeywords } = await configResp.json();
      for (const [kw, info] of Object.entries(personalizedKeywords as Record<string, any>)) {
        if (owwKeywordSessions[kw]) {
          const modelFile = OWW_KEYWORD_TO_MODEL[kw];
          if (modelFile) {
            const graphUrl = `/wakeword/${modelFile}`;
            await owwHotSwapKeywordWeights(kw, graphUrl, (info as any).url);
          }
        }
      }
    }
  } catch (e) {
    log.warn('Failed to load personalized weights', { error: String(e) });
  }

  // End/cancel word sessions
  _owwEndwordEnabled = false;
  owwEndwordSession = null;
  owwCancelwordSession = null;

  if (owwEndwordKeyword && OWW_KEYWORD_TO_MODEL[owwEndwordKeyword]) {
    if (owwKeywordSessions[owwEndwordKeyword]) {
      owwEndwordSession = owwKeywordSessions[owwEndwordKeyword];
      _owwEndwordEnabled = true;
      log.debug('OWW endword reusing wake word session: ' + owwEndwordKeyword);
    } else if (_owwCachedEndwordSession && _owwCachedEndwordKw === owwEndwordKeyword) {
      owwEndwordSession = _owwCachedEndwordSession;
      _owwEndwordEnabled = true;
      log.debug('OWW endword reusing cached session: ' + owwEndwordKeyword);
    } else {
      try {
        const modelFile = OWW_KEYWORD_TO_MODEL[owwEndwordKeyword];
        owwEndwordSession = await ort.InferenceSession.create(withAssetVersion('/wakeword/' + modelFile), opts);
        _owwEndwordEnabled = true;
        _owwCachedEndwordSession = owwEndwordSession;
        _owwCachedEndwordKw = owwEndwordKeyword;
        log.debug('OWW endword loaded: ' + owwEndwordKeyword);
      } catch (e) { log.debug('OWW endword load failed: ' + (e as Error).message); }
    }
  }

  if (owwCancelwordKeyword && OWW_KEYWORD_TO_MODEL[owwCancelwordKeyword]) {
    if (owwKeywordSessions[owwCancelwordKeyword]) {
      owwCancelwordSession = owwKeywordSessions[owwCancelwordKeyword];
      log.debug('OWW cancelword reusing wake word session: ' + owwCancelwordKeyword);
    } else if (_owwCachedCancelwordSession && _owwCachedCancelwordKw === owwCancelwordKeyword) {
      owwCancelwordSession = _owwCachedCancelwordSession;
      log.debug('OWW cancelword reusing cached session: ' + owwCancelwordKeyword);
    } else {
      try {
        const modelFile = OWW_KEYWORD_TO_MODEL[owwCancelwordKeyword];
        owwCancelwordSession = await ort.InferenceSession.create(withAssetVersion('/wakeword/' + modelFile), opts);
        _owwCachedCancelwordSession = owwCancelwordSession;
        _owwCachedCancelwordKw = owwCancelwordKeyword;
        log.debug('OWW cancelword loaded: ' + owwCancelwordKeyword);
      } catch (e) { log.debug('OWW cancelword load failed: ' + (e as Error).message); }
    }
  }
}

/** Preload OWW ONNX sessions in background so mode switch is instant. */
export async function preloadOwwSessions(): Promise<void> {
  try {
    await ensureWakewordScripts('openwakeword');
    const ort = (window as unknown as { ort?: unknown }).ort as { InferenceSession: { create: (url: string | Uint8Array, opts: unknown) => Promise<unknown> }; Tensor: new (type: string, data: unknown, dims: number[]) => unknown } | undefined;
    if (!ort) return;
    await ensureWakewordConfigLoaded();
    const activeKws: string[] = [];
    for (const [, kw] of Object.entries(wwMapping)) {
      if (kw && OWW_KEYWORD_TO_MODEL[kw]) activeKws.push(kw);
    }
    if (activeKws.length === 0) activeKws.push('Hey Jarvis');
    await _owwLoadSessions(ort, activeKws);
    const preloadedModels = Object.keys(_owwCachedKeywordSessions);
    log.info(`OWW sessions preloaded — ${preloadedModels.length} model(s)`, { activeKws, loadedModels: preloadedModels, pipeline: _activePipeline || '(default)', cached: !!_owwCachedInfra });
  } catch (e) {
    log.debug('OWW preload failed (non-fatal)', { error: (e as Error).message });
  }
}

async function startSherpaKwsWakeWord(earlyMicP?: Promise<MediaStream | null> | null): Promise<void> {
  let _step = 'init';
  try {
    // --- 1. Config ---
    _step = 'config';
    await ensureWakewordConfigLoaded();
    if (!SHERPA_KWS_AVAILABLE) {
      showToast(t('wakeword.sherpa_kws_model_unavailable'));
      throw new Error('Sherpa KWS model files not available');
    }

    // --- 2. Build keyword → botId map ---
    _step = 'keyword-map';
    skwsKeywordToBotId = new Map();
    for (const [botId, kw] of Object.entries(wwMapping)) {
      if (!BOT_IDS.includes(botId)) continue;
      if (kw && SHERPA_KWS_KEYWORDS.includes(kw)) {
        skwsKeywordToBotId.set(kw.toLowerCase(), botId);
      }
    }
    if (skwsEndwordKeyword && SHERPA_KWS_KEYWORDS.includes(skwsEndwordKeyword)) {
      skwsKeywordToBotId.set(skwsEndwordKeyword.toLowerCase(), KW_ENDWORD);
    }
    if (skwsCancelwordKeyword && SHERPA_KWS_KEYWORDS.includes(skwsCancelwordKeyword)) {
      skwsKeywordToBotId.set(skwsCancelwordKeyword.toLowerCase(), KW_CANCELWORD);
    }

    if (skwsKeywordToBotId.size === 0) {
      showToast(t('wakeword.err_sherpa_kws_no_keywords'));
      throw new Error('No keywords configured for Sherpa KWS');
    }

    log.info('Sherpa KWS starting', { activeKws: [...skwsKeywordToBotId.keys()] });

    setInitOverlay(t('wakeword.step_1_5_mic'));

    // --- 3. Start mic request early (parallel with WASM init) ---
    _step = 'parallel-init';
    const micConstraints = {
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: wwMicAec,
        noiseSuppression: wwMicAec,
        autoGainControl: wwMicAec,
      },
    };
    // Use early mic promise if available, otherwise request mic now
    const micP = (earlyMicP
      ? earlyMicP.then(s => s || navigator.mediaDevices.getUserMedia(micConstraints))
      : navigator.mediaDevices.getUserMedia(micConstraints)
    ).then(s => {
      setInitOverlay(t('wakeword.step_2_5_prepare'));
      return s;
    });

    // --- 4. Fetch keywords.txt (parallel with mic) ---
    _step = 'keywords-txt';
    const kwResp = await fetch('/wakeword/sherpa-kws/keywords.txt');
    if (!kwResp.ok) throw new Error('Failed to fetch keywords.txt');
    const keywordsStr = (await kwResp.text()).trim();

    // --- 5. Wait for WASM Module to be ready, then create KWS instance ---
    _step = 'wasm-init';
    setInitOverlay(t('wakeword.step_3_5_load'));
    const createKws = (window as unknown as { createKws?: (m: unknown, cfg: unknown) => unknown }).createKws;
    if (!createKws) throw new Error('createKws not found — sherpa-onnx-kws.js not loaded');

    const SherpaModule = (window as unknown as { Module?: Record<string, unknown> }).Module;
    if (!SherpaModule) throw new Error('Sherpa WASM Module not found on window');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Sherpa WASM init timeout')), 30000);
      if ((SherpaModule as { calledRun?: boolean }).calledRun) {
        clearTimeout(timeout);
        resolve();
      } else {
        const origCb = SherpaModule['onRuntimeInitialized'] as (() => void) | undefined;
        SherpaModule['onRuntimeInitialized'] = () => { clearTimeout(timeout); origCb?.(); resolve(); };
      }
    });

    // Model files are baked into the .data preload at absolute VFS paths (/ prefix)
    _step = 'kws-create';
    setInitOverlay(t('wakeword.step_4_5_model'));
    const kws = createKws(SherpaModule, {
      featConfig: { samplingRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: '/encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
          decoder: '/decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
          joiner: '/joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
        },
        tokens: '/tokens.txt',
        provider: 'cpu',
        numThreads: 1,
        debug: 0,
        modelingUnit: 'bpe',   // REQUIRED for GigaSpeech English model
        bpeVocab: '',
      },
      maxActivePaths: 4,
      numTrailingBlanks: 1,
      keywordsScore: 1.0,
      keywordsThreshold: SKWS_THRESHOLD,
      keywords: keywordsStr,  // newline-separated BPE token sequences from keywords.txt
    });
    skwsInstance = kws;

    // --- 6. Create stream ---
    _step = 'kws-stream';
    setInitOverlay(t('wakeword.step_5_5_init'));
    const kwsTyped = kws as {
      createStream: () => unknown;
      isReady: (s: unknown) => boolean;
      decode: (s: unknown) => void;
      getResult: (s: unknown) => { keyword: string };
      reset: (s: unknown) => void;
      free: () => void;
    };
    skwsStream = kwsTyped.createStream();

    // --- 7. Await mic stream (should already be resolved by now) ---
    _step = 'mic';
    skwsMicStream = await micP;

    // --- 7. Audio pipeline ---
    _step = 'audio-ctx';
    skwsAudioCtx = new AudioContext({ sampleRate: 16000 });
    // Ensure AudioContext is running — may be suspended if user gesture expired during async init
    if (skwsAudioCtx.state === 'suspended') await skwsAudioCtx.resume();
    const source = skwsAudioCtx.createMediaStreamSource(skwsMicStream);
    skwsScriptNode = skwsAudioCtx.createScriptProcessor(4096, 1, 1);

    const sampleAccum: number[] = [];
    skwsScriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
      if (!skwsActive) return;
      const input = e.inputBuffer.getChannelData(0);
      // Compute RMS for wakeword ear icon animation
      let sumSq = 0;
      for (let i = 0; i < input.length; i++) { sumSq += input[i] * input[i]; sampleAccum.push(input[i]); }
      bus.emit('wakeword:audio-level', Math.sqrt(sumSq / input.length));
      while (sampleAccum.length >= 1600) {
        skwsChunkQueue.push(new Float32Array(sampleAccum.splice(0, 1600)));
      }
      if (!skwsProcessing) _skwsDrainQueue();
    };

    source.connect(skwsScriptNode);
    skwsScriptNode.connect(skwsAudioCtx.destination);

    // --- 8. Mark active BEFORE drain loop starts ---
    skwsActive = true;
    wakeWordActive = true;
    log.info('Sherpa KWS started', { activeKws: [...skwsKeywordToBotId.keys()] });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const detail = `[${_step}] ${msg}`;
    log.error('Sherpa KWS init failed', { step: _step, error: msg, stack: (e as Error).stack });
    showToast('Sherpa KWS init failed: ' + detail, { duration: 12000 });
    // Clean up early-obtained mic stream on failure
    if (skwsMicStream) { skwsMicStream.getTracks().forEach(t => t.stop()); skwsMicStream = null; }
    stopSherpaKwsWakeWord(true);
  }
}

async function _skwsDrainQueue(): Promise<void> {
  if (skwsProcessing) return;
  skwsProcessing = true;
  try {
    const kwsTyped = skwsInstance as {
      isReady: (s: unknown) => boolean;
      decode: (s: unknown) => void;
      getResult: (s: unknown) => { keyword: string };
      reset: (s: unknown) => void;
    };
    const streamTyped = skwsStream as { acceptWaveform: (sr: number, data: Float32Array) => void };
    while (skwsChunkQueue.length > 0 && skwsActive) {
      const chunk = skwsChunkQueue.shift()!;
      streamTyped.acceptWaveform(16000, chunk);
      // isReady loop: drain all ready frames before decode
      while (kwsTyped.isReady(skwsStream)) {
        kwsTyped.decode(skwsStream);
      }
      const result = kwsTyped.getResult(skwsStream);
      if (result.keyword && result.keyword.length > 0) {
        const kwLower = result.keyword.toLowerCase().trim();
        const botId = skwsKeywordToBotId.get(kwLower);
        if (botId) {
          log.info('Sherpa KWS detected', { keyword: result.keyword, botId });
          kwsTyped.reset(skwsStream);  // reset stream after detection
          if (botId === KW_ENDWORD) {
            // Mirror OWW endword pattern (stop recording without cancel flag)
            _wwChunkRestart = false;
            if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
          } else if (botId === KW_CANCELWORD) {
            // Mirror OWW cancelword pattern (set cancel flag then stop)
            if (micState.isActive) {
              _wwChunkRestart = false;
              wakeWordRecordingCancelled = true;
              if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
            }
          } else {
            if (wwAllowBargeIn && audioPlayer.state === 'playing') interruptBot(botId);
            await handleWakeWithVoiceprintGate(botId);
          }
        }
      }
    }
  } catch (_e) { /* ignore drain errors */ }
  skwsProcessing = false;
}

async function startOpenWakeWord(earlyMicP?: Promise<MediaStream | null> | null): Promise<void> {
  if (owwActive) return;
  const ort = (window as unknown as { ort?: unknown }).ort as { InferenceSession: { create: (url: string | Uint8Array, opts: unknown) => Promise<unknown> }; Tensor: new (type: string, data: unknown, dims: number[]) => unknown } | undefined;
  if (!ort) { showToast('onnxruntime-web not loaded'); return; }

  let _step = 'init';
  try {
    _step = 'config';
    await ensureWakewordConfigLoaded();

    const activeKws: string[] = [];
    owwKeywordToBotId = {};
    for (const [botId, kw] of Object.entries(wwMapping)) {
      if (!BOT_IDS.includes(botId)) continue; // skip phantom/deleted bots
      if (kw && OWW_KEYWORD_TO_MODEL[kw]) { activeKws.push(kw); owwKeywordToBotId[kw] = botId; }
    }
    log.info('OWW starting', { activeKws, wwMapping, botIds: BOT_IDS, availableKws: OWW_KEYWORDS, kwToModel: OWW_KEYWORD_TO_MODEL, pipeline: _activePipeline || '(default)', cached: !!_owwCachedInfra, endword: owwEndwordKeyword, cancelword: owwCancelwordKeyword });

    // Load ONNX sessions AND obtain mic in parallel
    _step = 'parallel-init';
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone requires HTTPS. Please access this page via https://');
    }
    setInitOverlay(t('wakeword.step_1_4_mic'));

    let stream: MediaStream;
    {
      const micConstraints = { audio: { sampleRate: 16000, channelCount: 1, echoCancellation: wwMicAec, noiseSuppression: wwMicAec, autoGainControl: wwMicAec } as MediaTrackConstraints };
      // Use early mic promise if available, otherwise request mic now
      const micP = (earlyMicP
        ? earlyMicP.then(s => s || navigator.mediaDevices.getUserMedia(micConstraints))
        : navigator.mediaDevices.getUserMedia(micConstraints)
      ).then(s => {
        setInitOverlay(t('wakeword.step_2_4_load'));
        return s;
      });
      const [, micStream] = await Promise.all([
        _owwLoadSessions(ort, activeKws),
        micP,
      ]);
      stream = micStream;
    }
    owwStream = stream;
    bus.emit('wakeword:mic-changed', stream);

    // Reset audio buffers
    _step = 'vad-tensors';
    owwVadState = {
      h: new ort.Tensor('float32', new Float32Array(2 * 64).fill(0), [2, 1, 64]),
      c: new ort.Tensor('float32', new Float32Array(2 * 64).fill(0), [2, 1, 64]),
    };
    owwVadSr = new ort.Tensor('int64', typeof BigInt64Array !== 'undefined'
      ? BigInt64Array.from([BigInt(16000)])
      : [BigInt(16000)] as unknown as BigInt64Array, []);

    owwMelBuffer = [];
    for (let i = 0; i < 76; i++) owwMelBuffer.push(new Float32Array(32));
    owwEmbBuffer = [];
    for (let i = 0; i < 16; i++) owwEmbBuffer.push(new Float32Array(96));

    // Wire up audio processing
    _step = 'audio-ctx';
    owwAudioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ sampleRate: 16000 });
    // Ensure AudioContext is running — may be suspended if user gesture expired during async model loading
    if (owwAudioCtx.state === 'suspended') await owwAudioCtx.resume();
    // Auto-resume if AudioContext gets suspended later (e.g. second getUserMedia, tab switch)
    owwAudioCtx.onstatechange = () => {
      const ctx = owwAudioCtx;
      if (!ctx || !owwActive) return;
      log.debug('OWW AudioContext state changed', { state: ctx.state });
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    };
    const source = owwAudioCtx.createMediaStreamSource(stream);
    owwScriptNode = owwAudioCtx.createScriptProcessor(4096, 1, 1);
    const sampleAccum: number[] = [];
    const CHUNK_SIZE = 1280;
    const owwChunkQueue: Float32Array[] = [];
    let owwProcessing = false;

    const _owwDrainQueue = async () => {
      if (owwProcessing) return;
      owwProcessing = true;
      try {
        while (owwChunkQueue.length > 0 && owwActive) {
          const chunk = owwChunkQueue.shift()!;
          await _owwProcessChunk(chunk, ort, activeKws);
        }
      } catch (_e) { /* ignore */ }
      owwProcessing = false;
    };

    let _owwAudioCallbackCount = 0;
    let _owwLastHealthLog = Date.now();
    owwScriptNode.onaudioprocess = (e) => {
      if (!owwActive) return;
      const input = e.inputBuffer.getChannelData(0);
      // Feed voiceprint ring buffer only during speech-active frames.
      // owwVadSpeechProb is the previous chunk's VAD result (one-frame delay, negligible).
      // This prevents background noise from contaminating the speaker embedding.
      if (owwVadSpeechProb >= VAD_GATE_THRESHOLD) feedAudioSamples(input);
      // Compute RMS for wakeword ear icon animation
      let sumSq = 0;
      for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i];
      const rms = Math.sqrt(sumSq / input.length);
      bus.emit('wakeword:audio-level', rms);
      _owwAudioCallbackCount++;
      // Periodic health log every 10s
      const now = Date.now();
      if (now - _owwLastHealthLog > 10000) {
        log.debug('OWW audio pipeline health', {
          callbacks: _owwAudioCallbackCount,
          rms: rms.toFixed(4),
          ctxState: owwAudioCtx?.state,
          streamActive: owwStream?.active,
          trackState: owwStream?.getAudioTracks()[0]?.readyState,
          recFeedActive: _owwMuteOwnStream,
        });
        _owwLastHealthLog = now;
      }
      // Skip OWW chunk accumulation when recording feed bridge is active
      // (recording stream feeds higher-quality audio directly)
      if (!_owwMuteOwnStream) {
        for (let i = 0; i < input.length; i++) sampleAccum.push(input[i]);
        while (sampleAccum.length >= CHUNK_SIZE) owwChunkQueue.push(new Float32Array(sampleAccum.splice(0, CHUNK_SIZE)));
        _owwDrainQueue();
      }
    };
    source.connect(owwScriptNode);
    owwScriptNode.connect(owwAudioCtx.destination);

    owwActive = true;
    _owwPushChunk = (chunk: Float32Array) => {
      owwChunkQueue.push(chunk);
      _owwDrainQueue();
    };
    _owwDebugCounter = 0;
    owwStartedAt = Date.now();
    owwEmaScores = {};
    owwLastDetection = {};
    wakeWordActive = true;
    const loadedSessions = Object.keys(owwKeywordSessions);
    const modelFiles = loadedSessions.map(kw => OWW_KEYWORD_TO_MODEL[kw] || '?');
    log.info(`OWW started successfully — ${loadedSessions.length} model(s) loaded`, {
      activeKws,
      loadedModels: loadedSessions,
      modelFiles,
      pipeline: _activePipeline || '(default)',
      endword: _owwEndwordEnabled ? owwEndwordKeyword : false,
      cancelword: owwCancelwordSession ? owwCancelwordKeyword : false,
      sessions: loadedSessions,
      actualSampleRate: owwAudioCtx.sampleRate,
      threshold: OWW_THRESHOLD,
      modelMeta: OWW_MODEL_META,
    });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const detail = `[${_step}] ${msg}`;
    log.error('OWW init failed', { step: _step, error: msg, stack: (e as Error).stack });
    showToast(t('wakeword.oww_init_failed') + detail, { duration: 12000 });
    // Clean up early-obtained mic stream on failure
    if (owwStream) { owwStream.getTracks().forEach(t => t.stop()); owwStream = null; bus.emit('wakeword:mic-changed', null); }
    stopOpenWakeWord(true);
  }
}

async function _owwProcessChunk(chunk: Float32Array, ort: { InferenceSession: { create: (url: string | Uint8Array, opts: unknown) => Promise<unknown> }; Tensor: new (type: string, data: unknown, dims: number[] | never[]) => unknown }, activeKws: string[]): Promise<void> {
  if (!owwMelSession || !owwActive) return;

  // VAD — capture speech probability for barge-in gating
  try {
    const vadInput = new ort.Tensor('float32', chunk, [1, chunk.length]);
    const vadFeeds = { input: vadInput, h: (owwVadState as { h: unknown }).h, c: (owwVadState as { c: unknown }).c, sr: owwVadSr };
    const vadOut = await (owwVadSession as { run: (feeds: unknown) => Promise<Record<string, { data: Float32Array; dims: number[] }>> }).run(vadFeeds);
    // Silero VAD output tensor contains speech probability [0..1]
    const outKey = Object.keys(vadOut).find(k => k !== 'hn' && k !== 'cn') || 'output';
    owwVadSpeechProb = outKey in vadOut ? vadOut[outKey].data[0] : 0;
    if (owwVadSpeechProb >= VAD_GATE_THRESHOLD) owwVadLastSpeechTs = Date.now();
    owwVadState = {
      h: new ort.Tensor('float32', new Float32Array(vadOut.hn.data), vadOut.hn.dims),
      c: new ort.Tensor('float32', new Float32Array(vadOut.cn.data), vadOut.cn.dims),
    };
    // Speech gate: pause TTS when sustained human speech detected during playback
    if (owwVadSpeechProb >= SPEECH_GATE_VAD_THRESHOLD) {
      speechGateConsecutiveFrames++;
    } else {
      speechGateConsecutiveFrames = 0;
    }
    if (audioPlayer.state === 'playing' && !speechGateActive && speechGateConsecutiveFrames >= SPEECH_GATE_MIN_FRAMES) {
      speechGateConsecutiveFrames = 0;
      // Voiceprint gate: if enrolled, verify speaker before pausing TTS
      if (isVoiceprintEnabled() && hasEnrollment()) {
        const match = await verifySpeaker('speech_gate');
        if (!match) {
          log.debug('Speech gate: voiceprint mismatch, ignoring', { vadProb: owwVadSpeechProb });
          // Do not activate speech gate — not the enrolled user
        } else {
          _activateSpeechGate(owwVadSpeechProb);
        }
      } else {
        _activateSpeechGate(owwVadSpeechProb);
      }
    }
  } catch (e) { log.warn('OWW VAD error', { error: (e as Error).message }); owwVadSpeechProb = 0; }

  // Mel — prepend previous chunk tail (480 samples) for overlap context, matching OWW Python behavior
  const MEL_OVERLAP = 480; // 160 * 3 = 30ms of overlap context
  const hasOverlap = owwPrevChunkTail && owwPrevChunkTail.length === MEL_OVERLAP;
  const melLen = hasOverlap ? MEL_OVERLAP + chunk.length : chunk.length;
  const melChunk = new Float32Array(melLen);
  let off = 0;
  if (hasOverlap) {
    for (let i = 0; i < MEL_OVERLAP; i++) melChunk[i] = owwPrevChunkTail![i] * 32768.0;
    off = MEL_OVERLAP;
  }
  for (let i = 0; i < chunk.length; i++) melChunk[off + i] = chunk[i] * 32768.0;
  // Save tail for next chunk
  owwPrevChunkTail = chunk.length >= MEL_OVERLAP ? chunk.slice(chunk.length - MEL_OVERLAP) : chunk.slice(0);
  const melInput = new ort.Tensor('float32', melChunk, [1, melLen]);
  const melOut = await (owwMelSession as { run: (feeds: unknown) => Promise<Record<string, { data: Float32Array; dims: number[] }>> }).run({ input: melInput });
  const melKey = Object.keys(melOut)[0];
  const melRaw = melOut[melKey];
  if (!(_owwDebugCounter % 100)) log.debug('OWW mel output', { dims: melRaw.dims, key: melKey, sampleValues: [melRaw.data[0], melRaw.data[1], melRaw.data[2]] });
  const nMelFrames = melRaw.dims[2];
  const melFeatureSize = melRaw.dims[3];
  for (let f = 0; f < nMelFrames; f++) {
    const frame = new Float32Array(melFeatureSize);
    for (let j = 0; j < melFeatureSize; j++) frame[j] = (melRaw.data[f * melFeatureSize + j] / 10.0) + 2.0;
    owwMelBuffer.push(frame);
  }

  // Embedding
  if (owwMelBuffer.length >= 76) {
    const embInputData = new Float32Array(76 * melFeatureSize);
    for (let i = 0; i < 76; i++) embInputData.set(owwMelBuffer[i], i * melFeatureSize);
    owwMelBuffer = owwMelBuffer.slice(8);

    const embInput = new ort.Tensor('float32', embInputData, [1, 76, melFeatureSize, 1]);
    const embInputName = (owwEmbSession as { inputNames: string[] }).inputNames[0];
    const embFeeds: Record<string, unknown> = {};
    embFeeds[embInputName] = embInput;
    const embOut = await (owwEmbSession as { run: (feeds: unknown) => Promise<Record<string, { data: Float32Array }>> }).run(embFeeds);
    const embKey = Object.keys(embOut)[0];
    const embedding = new Float32Array(96);
    for (let i = 0; i < 96; i++) embedding[i] = embOut[embKey].data[i];
    owwEmbBuffer.push(embedding);

    // Keyword detection
    if (owwEmbBuffer.length >= 16) {
      const kwInputData = new Float32Array(16 * 96);
      for (let i = 0; i < 16; i++) kwInputData.set(owwEmbBuffer[i], i * 96);
      owwEmbBuffer = owwEmbBuffer.slice(1);

      // VAD gate: skip keyword inference when no recent speech detected.
      // Uses holdover to keep gate open after speech ends, so trailing embeddings get inferred.
      if (wwVadGate && owwVadSpeechProb < VAD_GATE_THRESHOLD && (Date.now() - owwVadLastSpeechTs) > VAD_GATE_HOLDOVER_MS) {
        if (!(_owwDebugCounter % 25)) log.debug('OWW VAD gate: skipping keyword inference', { vadProb: owwVadSpeechProb, gate: VAD_GATE_THRESHOLD, holdoverMs: VAD_GATE_HOLDOVER_MS });
        _owwDebugCounter++;
        return;
      }

      // During recording: check end/cancel words instead of wake words
      if (micState.isActive) {
        await _owwCheckEndCancelWords(kwInputData, ort);
        return;
      }

      // Cancel word checked during TTS playback only (not processing).
      // During processing, the user hasn't spoken yet, so cancel word would
      // be a false positive from ambient noise. (ISSUE-13 fix)
      const _cwShouldCheck = audioPlayer.state !== 'idle';
      if (_cwShouldCheck && owwCancelwordSession) {
        try {
          const cancelShape = OWW_MODEL_META[owwCancelwordKeyword]?.inputShape || '3d';
          const cancelDims = cancelShape === '2d' ? [1, 1536] : [1, 16, 96];
          const cancelTensor = new ort.Tensor('float32', kwInputData, cancelDims);
          const cancelFeeds: Record<string, unknown> = {};
          cancelFeeds[(owwCancelwordSession as { inputNames: string[] }).inputNames[0]] = cancelTensor;
          const cancelOut = await (owwCancelwordSession as { run: (feeds: unknown) => Promise<Record<string, { data: Float32Array }>> }).run(cancelFeeds);
          const cancelScore = cancelOut[Object.keys(cancelOut)[0]].data[0];
          if (cancelScore > OWW_THRESHOLD) {
            const reason = audioPlayer.state !== 'idle' ? 'stopped_reading' : 'cancelled';
            log.info('OWW cancel word detected', { kw: owwCancelwordKeyword, score: cancelScore, reason });
            _clearSpeechGate();
            interruptBot(getCurrentBotId(), reason);
            showToast(reason === 'stopped_reading' ? t('toast.stopped_reading') : t('toast.cancelled_turn'));
            return;
          }
        } catch (e) { log.warn('OWW cancelword inference error', { error: (e as Error).message }); }
      }

      const _debugScores: Record<string, number> = {};
      const _debugEma: Record<string, number> = {};
      for (const kw of activeKws) {
        const session = owwKeywordSessions[kw] as { inputNames: string[]; run: (feeds: unknown) => Promise<Record<string, { data: Float32Array }>> };
        if (!session) continue;
        try {
          const shape = OWW_MODEL_META[kw]?.inputShape || '3d';
          let kwTensor: unknown;
          if (shape === '2d') {
            kwTensor = new ort.Tensor('float32', kwInputData, [1, 1536]);
          } else if (shape.startsWith('3d:')) {
            // Non-standard 3d: e.g. "3d:34" means [1, 34, 96]
            const nFrames = Number.parseInt(shape.split(':')[1], 10) || 16;
            const needed = nFrames * 96;
            // Pad or truncate embedding data to match expected frames
            const padded = new Float32Array(needed);
            padded.set(kwInputData.subarray(0, Math.min(kwInputData.length, needed)));
            kwTensor = new ort.Tensor('float32', padded, [1, nFrames, 96]);
          } else {
            kwTensor = new ort.Tensor('float32', kwInputData, [1, 16, 96]);
          }
          const kwFeeds: Record<string, unknown> = {};
          kwFeeds[session.inputNames[0]] = kwTensor;
          const kwOut = await session.run(kwFeeds);
          const rawScore = kwOut[Object.keys(kwOut)[0]].data[0];
          // EMA smoothing (matches reference implementation α=0.35)
          const prevEma = owwEmaScores[kw] ?? 0;
          const emaScore = OWW_EMA_ALPHA * rawScore + (1 - OWW_EMA_ALPHA) * prevEma;
          owwEmaScores[kw] = emaScore;
          _debugScores[kw] = rawScore;
          _debugEma[kw] = emaScore;
          if (emaScore > OWW_THRESHOLD) {
            const now = Date.now();
            // Per-keyword cooldown (2s, matches reference implementation)
            if (now - (owwLastDetection[kw] || 0) < OWW_DETECTION_COOLDOWN_MS) continue;
            const detectedBotId = owwKeywordToBotId[kw];
            if (now - owwStartedAt < OWW_INIT_COOLDOWN_MS) return;
            if (micState.isActive || getInputMode() !== 'wakeword') return;
            owwLastDetection[kw] = now;
            // Barge-in during active playback or speech-gate pause
            if (audioPlayer.state !== 'idle') {
              if (!wwAllowBargeIn) { notifyWakeBlockedByReading(); return; }
              log.info('OWW barge-in triggered during playback', { kw, emaScore, botId: detectedBotId });
              // Voiceprint gate: verify speaker BEFORE interrupting playback
              if (isVoiceprintEnabled() && hasEnrollment()) {
                verifySpeaker('barge_in').then((match) => {
                  if (!match) { log.debug('OWW barge-in: voiceprint mismatch, keeping playback'); return; }
                  _clearSpeechGate();
                  interruptBot(getCurrentBotId());
                  setTimeout(() => {
                    const canRecord = !micState.isActive && getInputMode() === 'wakeword' && !wwPaused;
                    if (canRecord) handleWakeWithUnreadCheck(detectedBotId);
                  }, 150);
                });
              } else {
                _clearSpeechGate();
                interruptBot(getCurrentBotId());
                setTimeout(() => {
                  const canRecord = !micState.isActive && getInputMode() === 'wakeword' && !wwPaused;
                  if (canRecord) handleWakeWithUnreadCheck(detectedBotId);
                }, 150);
              }
              return;
            }
            if (audioPlayer.isPaused && speechGateActive) {
              if (!wwAllowBargeIn) { notifyWakeBlockedByReading(); return; }
              log.info('OWW barge-in triggered during speech gate pause', { kw, emaScore, botId: detectedBotId });
              if (isVoiceprintEnabled() && hasEnrollment()) {
                verifySpeaker('barge_in_paused').then((match) => {
                  if (!match) { log.debug('OWW speech-gate barge-in: voiceprint mismatch, keeping playback'); return; }
                  _clearSpeechGate();
                  interruptBot(getCurrentBotId());
                  setTimeout(() => {
                    const canRecord = !micState.isActive && getInputMode() === 'wakeword' && !wwPaused;
                    if (canRecord) handleWakeWithUnreadCheck(detectedBotId);
                  }, 150);
                });
              } else {
                _clearSpeechGate();
                interruptBot(getCurrentBotId());
                setTimeout(() => {
                  const canRecord = !micState.isActive && getInputMode() === 'wakeword' && !wwPaused;
                  if (canRecord) handleWakeWithUnreadCheck(detectedBotId);
                }, 150);
              }
              return;
            }
            handleWakeWithVoiceprintGate(detectedBotId);
            return;
          }
        } catch (e) { log.warn('OWW keyword inference error', { kw, error: (e as Error).message }); }
      }
      // Debug: log scores periodically (every ~2s = 25 cycles at 80ms/chunk)
      if (!(_owwDebugCounter % 25)) log.debug('OWW scores', { raw: _debugScores, ema: _debugEma, threshold: OWW_THRESHOLD, vadProb: owwVadSpeechProb, vadGate: VAD_GATE_THRESHOLD, speechGateActive });
      _owwDebugCounter++;
    }
  }
}

async function _owwCheckEndCancelWords(
  kwInputData: Float32Array,
  ort: { Tensor: new (type: string, data: unknown, dims: number[]) => unknown },
): Promise<void> {
  type OrtSession = { inputNames: string[]; run: (feeds: unknown) => Promise<Record<string, { data: Float32Array }>> };

  const _runModel = async (session: unknown, inputShape: string): Promise<number> => {
    const sess = session as OrtSession;
    const dims = inputShape === '2d' ? [1, 1536] : [1, 16, 96];
    const tensor = new ort.Tensor('float32', kwInputData, dims);
    const feeds: Record<string, unknown> = {};
    feeds[sess.inputNames[0]] = tensor;
    const out = await sess.run(feeds);
    return out[Object.keys(out)[0]].data[0];
  };

  // Cancel word checked first (higher priority, same as PV behavior)
  let _cancelScore = -1;
  let _cancelEma = -1;
  let _endScore = -1;
  let _endEma = -1;
  if (owwCancelwordSession) {
    try {
      const rawScore = await _runModel(owwCancelwordSession, OWW_MODEL_META[owwCancelwordKeyword]?.inputShape || '3d');
      _cancelScore = rawScore;
      const emaKey = '__cancel__' + owwCancelwordKeyword;
      const prevEma = owwEmaScores[emaKey] ?? 0;
      const emaScore = OWW_EMA_ALPHA * rawScore + (1 - OWW_EMA_ALPHA) * prevEma;
      owwEmaScores[emaKey] = emaScore;
      _cancelEma = emaScore;
      if (emaScore > OWW_THRESHOLD) {
        log.debug('OWW cancel word detected: ' + owwCancelwordKeyword + ' (raw: ' + rawScore.toFixed(3) + ', ema: ' + emaScore.toFixed(3) + ')');
        owwEmaScores[emaKey] = 0; // reset EMA after detection to avoid re-triggering
        if (micState.isActive) {
          _wwChunkRestart = false;
          wakeWordRecordingCancelled = true;
          if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
        }
        const wasPlaying = audioPlayer.state === 'playing' || audioPlayer.state === 'paused';
        if (wasPlaying) interruptBot(getCurrentBotId(), 'stopped_reading');
        showToast(wasPlaying ? t('toast.cancelled_recording_and_reading') : t('toast.cancelled_recording'));
        return;
      }
    } catch (e) { log.warn('OWW cancelword inference error', { error: (e as Error).message }); }
  }

  // End word
  if (owwEndwordSession) {
    try {
      const rawScore = await _runModel(owwEndwordSession, OWW_MODEL_META[owwEndwordKeyword]?.inputShape || '3d');
      _endScore = rawScore;
      const emaKey = '__end__' + owwEndwordKeyword;
      const prevEma = owwEmaScores[emaKey] ?? 0;
      const emaScore = OWW_EMA_ALPHA * rawScore + (1 - OWW_EMA_ALPHA) * prevEma;
      owwEmaScores[emaKey] = emaScore;
      _endEma = emaScore;
      if (emaScore > OWW_THRESHOLD) {
        log.debug('OWW end word detected: ' + owwEndwordKeyword + ' (raw: ' + rawScore.toFixed(3) + ', ema: ' + emaScore.toFixed(3) + ')');
        owwEmaScores[emaKey] = 0; // reset EMA after detection
        _wwChunkRestart = false;
        if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
        return;
      }
    } catch (e) { log.warn('OWW endword inference error', { error: (e as Error).message }); }
  }

  // Debug: log end/cancel word scores periodically
  if (!(_owwDebugCounter % 25)) log.debug('OWW end/cancel scores', { cancelKw: owwCancelwordKeyword, cancelRaw: _cancelScore, cancelEma: _cancelEma, endKw: owwEndwordKeyword, endRaw: _endScore, endEma: _endEma, threshold: OWW_THRESHOLD, hasCancelSession: !!owwCancelwordSession, hasEndSession: !!owwEndwordSession });
  _owwDebugCounter++;
}

function stopSherpaKwsWakeWord(releaseModels = false): void {
  skwsActive = false;        // FIRST — stops drain loop iterations
  skwsProcessing = false;
  skwsChunkQueue = [];
  // Disconnect audio graph
  try { skwsScriptNode?.disconnect(); } catch (_e) { /* ignore */ }
  try { skwsAudioCtx?.close(); } catch (_e) { /* ignore */ }
  skwsScriptNode = null;
  skwsAudioCtx = null;
  // Stop mic tracks
  if (skwsMicStream) { skwsMicStream.getTracks().forEach(t => t.stop()); skwsMicStream = null; }
  // Release WASM objects
  if (releaseModels) {
    try { (skwsStream as { free?: () => void })?.free?.(); } catch (_e) { /* ignore */ }
    try { (skwsInstance as { free?: () => void })?.free?.(); } catch (_e) { /* ignore */ }
    skwsInstance = null;
    skwsStream = null;
  }
  skwsKeywordToBotId = new Map();
  log.debug('Sherpa KWS stopped', { releaseModels });
}

function stopOpenWakeWord(releaseSessions = false): void {
  owwActive = false;
  _owwPushChunk = null;
  _stopRecordingFeed();
  _clearSpeechGate();
  // Always disconnect audio pipeline
  if (owwScriptNode) { try { owwScriptNode.disconnect(); } catch (_e) { /* ignore */ } owwScriptNode = null; }
  if (owwAudioCtx) { try { owwAudioCtx.close(); } catch (_e) { /* ignore */ } owwAudioCtx = null; }
  if (owwStream) { owwStream.getTracks().forEach(t => t.stop()); owwStream = null; bus.emit('wakeword:mic-changed', null); }
  // Clear working references (sessions stay in cache)
  owwMelSession = null;
  owwEmbSession = null;
  owwVadSession = null;
  owwKeywordSessions = {};
  owwKeywordToBotId = {};
  owwEndwordSession = null;
  owwCancelwordSession = null;
  _owwEndwordEnabled = false;
  owwMelBuffer = [];
  owwEmbBuffer = [];
  owwVadState = null;
  owwVadSpeechProb = 0;
  owwVadLastSpeechTs = 0;
  owwPrevChunkTail = null;

  // Only release ONNX sessions when explicitly requested (e.g. engine switch)
  if (releaseSessions) {
    if (_owwCachedInfra) {
      try { (_owwCachedInfra.mel as { release: () => void }).release(); } catch (_e) { /* ignore */ }
      try { (_owwCachedInfra.emb as { release: () => void }).release(); } catch (_e) { /* ignore */ }
      try { (_owwCachedInfra.vad as { release: () => void }).release(); } catch (_e) { /* ignore */ }
      _owwCachedInfra = null;
    }
    for (const sess of Object.values(_owwCachedKeywordSessions)) { try { (sess as { release: () => void }).release(); } catch (_e) { /* ignore */ } }
    _owwCachedKeywordSessions = {};
    if (_owwCachedEndwordSession) { try { (_owwCachedEndwordSession as { release: () => void }).release(); } catch (_e) { /* ignore */ } _owwCachedEndwordSession = null; }
    if (_owwCachedCancelwordSession) { try { (_owwCachedCancelwordSession as { release: () => void }).release(); } catch (_e) { /* ignore */ } _owwCachedCancelwordSession = null; }
    _owwCachedActiveKws = [];
    _owwCachedEndwordKw = '';
    _owwCachedCancelwordKw = '';
    log.debug('OWW sessions fully released');
  }
}

// ---- Dispatcher ----
export async function startWakeWord(): Promise<void> {
  if (wakewordStarting) return;
  wakewordStarting = true;
  const engine = getWwEngine();
  log.info('startWakeWord', { engine });

  // Show loading UI immediately
  setWwToggleLoading(true);
  setInitOverlay(t('wakeword.initializing'));

  // Unlock the TTS AudioContext while still in the user-gesture call stack.
  // On iOS, AudioContext created outside a user gesture starts suspended and resume()
  // silently fails, so TTS audio never plays. Calling this here (synchronously, before
  // any await) ensures it's created and running before the first TTS chunk arrives.
  audioPlayer.getAudioContext();

  // Request mic early — runs in parallel with script loading and engine init
  let earlyMicP: Promise<MediaStream | null> | null = null;
  if (navigator.mediaDevices?.getUserMedia) {
    earlyMicP = navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1,
               echoCancellation: wwMicAec, noiseSuppression: wwMicAec,
               autoGainControl: wwMicAec } as MediaTrackConstraints,
    }).catch(e => { log.warn('Early mic request failed', { error: String(e) }); return null; });
  }

  try {
    // iOS hybrid: foreground uses the JS OWW pipeline (full feature parity with web).
    // Background uses native AVAudioEngine; visibilitychange drives the switch.
    const nativeAvail = isNativeWakeWordAvailable();
    log.info('Wakeword platform check', { nativeAvail, engine });
    if (nativeAvail) {
      await ensureWakewordScripts('openwakeword');
      initVoiceprint();
      // Pre-compute kwToModel for background engine switch (visibilitychange handler uses it)
      await ensureWakewordConfigLoaded();
      _iosKwToModel = {};
      for (const [botId, kw] of Object.entries(wwMapping)) {
        if (!BOT_IDS.includes(botId)) continue;
        if (kw && OWW_KEYWORD_TO_MODEL[kw]) _iosKwToModel[kw] = OWW_KEYWORD_TO_MODEL[kw];
      }
      log.info('iOS foreground: starting JS OWW pipeline', { keywords: Object.keys(_iosKwToModel) });
      // Persist config to UserDefaults so AppDelegate can start native engine on background
      // without relying on JS executing (WKWebView may freeze before any async JS fires).
      saveNativeWakeWordConfig(_iosKwToModel, OWW_THRESHOLD).catch(() => {});
      // Expose a hook for AppDelegate to call from applicationWillResignActive (Swift side).
      // When injected from native code while WKWebView is still fully active, track.stop()
      // is processed immediately by the WebContent process, releasing RemoteIO before
      // WakeWordPlugin.start() tries to acquire it. This is more reliable than waiting for
      // visibilitychange (which fires after WebContent may already be transitioning to suspended).
      (window as any)._iosReleaseAudioBeforeBackground = () => {
        if (!wakeWordActive || _iosInBackground) return;
        log.info('iOS: AppDelegate-injected early audio release (willResignActive)');
        stopOpenWakeWord(false);
      };
      // Foreground: run the same JS OWW pipeline as web (cancel word, sensitivity, all features)
      await startOpenWakeWord(earlyMicP);
      // Register once: switch to native on background, back to JS on foreground
      _setupIOSLifecycleListener();
    } else {
      await ensureWakewordScripts(engine);
      initVoiceprint();
      if (engine === 'picovoice') await startPicovoiceWakeWord(earlyMicP);
      else if (engine === 'openwakeword') await startOpenWakeWord(earlyMicP);
      else if (engine === 'sherpa-onnx-kws') await startSherpaKwsWakeWord(earlyMicP);
    }
  } catch (e) {
    log.error('Wakeword engine failed, attempting OWW fallback', { engine, error: String(e) });
    // If a non-OWW engine failed, fall back to openwakeword
    if (engine !== 'openwakeword') {
      setWwEngine('openwakeword');
      try {
        await ensureWakewordScripts('openwakeword');
        await startOpenWakeWord(earlyMicP);
        log.info('Fallback to OWW succeeded');
        showToast(t('wakeword.engine_fallback_oww'));
      } catch (e2) {
        log.error('OWW fallback also failed', { error: String(e2) });
      }
    }
  } finally {
    wakewordStarting = false;
    setWwToggleLoading(false);
    setInitOverlay(null);
  }
}

export function stopWakeWord(releaseModels = false): void {
  wakewordStarting = false;
  _pvEndwordEnabled = false;
  _iosInBackground = false;
  // Stop native engine if running
  stopNativeWakeWord().catch(() => {});
  // Cleanup PV voiceprint tap
  if (pvVoiceprintStream) { pvVoiceprintStream.getTracks().forEach(t => t.stop()); pvVoiceprintStream = null; }
  if (pvVoiceprintCtx) { try { pvVoiceprintCtx.close(); } catch (_e) { /* ignore */ } pvVoiceprintCtx = null; }
  stopOpenWakeWord(releaseModels);
  stopSherpaKwsWakeWord(releaseModels);
  if (micState.isActive || wakeWordRecorder?.state === 'recording') { _wwChunkRestart = false; wakeWordRecordingCancelled = true; }
  wakeWordActive = false;
  if (porcupineInstance) {
    try {
      const WVP = (window as unknown as { WebVoiceProcessor?: { WebVoiceProcessor: { unsubscribe: (inst: unknown) => void } } }).WebVoiceProcessor?.WebVoiceProcessor;
      if (WVP) WVP.unsubscribe(porcupineInstance);
      (porcupineInstance as { release: () => void }).release();
    } catch (_e) { /* ignore */ }
    porcupineInstance = null;
  }
  if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
  if (wakeWordStream) { wakeWordStream.getTracks().forEach(t => t.stop()); wakeWordStream = null; }
  micState.setIdle();
}

// MARK: - iOS hybrid lifecycle (foreground=JS, background=native)

/** Register visibilitychange listener once. Safe to call multiple times. */
function _setupIOSLifecycleListener(): void {
  if (_iosLifecycleSetup) return;
  _iosLifecycleSetup = true;
  document.addEventListener('visibilitychange', () => {
    if (!isNativeWakeWordAvailable()) return;
    if (document.visibilityState === 'hidden') {
      _onIOSBackground().catch(e => log.error('iOS background switch failed', { error: String(e) }));
    } else {
      _onIOSForeground().catch(e => log.error('iOS foreground switch failed', { error: String(e) }));
    }
  });
  log.info('iOS lifecycle listener registered (foreground=JS, background=native)');
}

/** App going to background: stop JS OWW pipeline. Native engine starts via AppDelegate. */
async function _onIOSBackground(): Promise<void> {
  if (!wakeWordActive || _iosInBackground) return;
  if (micState.isActive) {
    // Don't switch while a recording is in progress — let it complete or cancel naturally
    log.info('iOS: background during recording, skipping engine switch');
    return;
  }
  _iosInBackground = true;
  log.info('iOS: entering background — stopping JS OWW (native engine starts via AppDelegate)');
  stopOpenWakeWord(false);  // release mic stream, keep ONNX model cache for foreground return
  // Native engine startup is handled by AppDelegate.applicationDidEnterBackground which reads
  // the persisted wakeword config from UserDefaults. No JS async work needed here — WKWebView
  // may freeze before any setTimeout fires, making the old approach unreliable.
}

/** App returning to foreground: stop native AVAudioEngine, restart JS OWW pipeline. */
async function _onIOSForeground(): Promise<void> {
  if (!_iosInBackground) return;
  _iosInBackground = false;
  log.info('iOS: entering foreground — switching native → JS wakeword engine');
  await stopNativeWakeWord();
  if (wakeWordActive && getInputMode() === 'wakeword' && !wwPaused) {
    try {
      await startOpenWakeWord(null);
      // Resume the TTS AudioContext. iOS suspends all AudioContexts when the app is
      // backgrounded. startOpenWakeWord called getUserMedia which counts as a user
      // activation on iOS, allowing AudioContext.resume() to succeed. Without this,
      // the first wakeword detection after returning from background produces no TTS audio.
      audioPlayer.getAudioContext();
    } catch (e) {
      log.error('iOS: JS OWW restart failed on foreground', { error: String(e) });
    }
  }
}

/** Remove a bot's wake word mapping (e.g. after bot deletion). */
export function removeWwMappingForBot(botId: string): void {
  if (!(botId in wwMapping)) return;
  delete wwMapping[botId];
  saveWwMapping();
}

export function restartWakeWordListening(reason: string): void {
  if (getInputMode() !== 'wakeword' || wwPaused || micState.isActive) return;
  log.debug('WW restart', { reason });
  stopWakeWord();
  setTimeout(() => { if (getInputMode() === 'wakeword' && !wwPaused && !micState.isActive) startWakeWord(); }, 320);
}

// ---- Voiceprint gate ----
async function handleWakeWithVoiceprintGate(botId: string): Promise<void> {
  if (!isVoiceprintEnabled() || !hasEnrollment()) {
    handleWakeWithUnreadCheck(botId);
    return;
  }
  const match = await verifySpeaker();
  if (match) {
    handleWakeWithUnreadCheck(botId);
  } else {
    log.debug('Voiceprint: speaker mismatch, ignoring');
  }
}

// ---- Wake with unread check ----
async function handleWakeWithUnreadCheck(detectedBotId: string): Promise<void> {
  const targetBotId = detectedBotId || getCurrentBotId();
  const unreadN = getUnreadCount(targetBotId);
  const hasUnread = unreadN > 0;
  const needsSwitch = !!detectedBotId && detectedBotId !== getCurrentBotId();

  if (needsSwitch) {
    // Switch bot; suppress auto-read when unread so we can play "我在" first
    bus.emit('bot:switch', hasUnread
      ? { botId: detectedBotId, suppressAutoRead: true }
      : detectedBotId,
    );
  }

  if (!hasUnread) {
    onWakeWordDetected(); // plays "我在" + starts recording
  } else {
    // Always say "我在" before reading unread messages
    await playVoiceFeedback('start');
    if (!needsSwitch) {
      // Same-bot case: clear badge here (switchToBot already did it for cross-bot)
      setUnreadCount(targetBotId, 0);
      updateBadges();
    }
    bus.emit('chat:auto-read-unread', { botId: targetBotId, count: unreadN });
    showToast(getBotNames()[targetBotId] + ' ' + t('toast.unread_reading'));
  }
}

// ---- Wake word recording ----
function onWakeWordDetected(): void {
  // I3 fix: if the current bot's turn is busy, interrupt it first (barge-in).
  // Without this, Mic would start recording but BotTurnState transition to
  // 'listening' would be rejected, silently discarding the recording.
  const wwBotId = getCurrentBotId();
  const currentTurn = botTurnState.get(wwBotId);
  if (currentTurn !== 'idle') {
    interruptBot(wwBotId);
  }
  bus.emit('ui:cancel-unread-announcement');
  showToast(t('toast.wakeword_heard_start_recording'));
  audioPlayer.getAudioContext();

  const END_SILENCE_MS = (() => {
    // Allow user to configure silence timeout (default 5 seconds)
    try {
      const saved = localStorage.getItem(STORAGE_KEY + 'wwSilenceMs');
      if (saved) {
        const ms = parseInt(saved, 10);
        if (ms > 0 && ms <= 30000) return ms;
      }
    } catch (_e) { /* ignore */ }
    return 5000; // Default: 5 seconds
  })();
  const MIN_RECORD_MS = 2000;
  const MAX_RECORD_MS = 300000;
  const LEVEL_TH = 0.03;
  const endwordInput = document.getElementById('endword-input') as HTMLInputElement | null;
  const cancelwordInput = document.getElementById('cancelword-input') as HTMLInputElement | null;
  const endWord = (endwordInput?.value || t('wakeword.default_end_word')).trim();
  const cancelWord = (cancelwordInput?.value || t('wakeword.default_cancel_word')).trim();

  const startedAt = Date.now();
  let lastLoudAt = Date.now();
  let loopTimer: ReturnType<typeof setTimeout> | null = null;

  micState.startRecording({ botId: getCurrentBotId(), mode: 'wakeword' });
  micState.setRecording();
  wakeWordRecordingCancelled = false;
  _wwChunkRestart = false;
  // Save feedback promise — recorder.start() awaits this so "我在" finishes
  // before mic begins recording (prevents echo bleed-in).
  const _feedbackDone = playVoiceFeedback('start');

  getMicStream().then(async stream => {
    if (wakeWordRecordingCancelled) {
      stream.getTracks().forEach(t => t.stop());
      micState.setIdle();
      wakeWordRecordingCancelled = false;
      botTurnState.resetToIdle(getCurrentBotId());
      _restartWakeWord();
      return;
    }

    wakeWordStream = stream;
    const { analyser, buf } = createStreamAnalyser(stream);
    const { recorder, chunks } = newRecorder(stream);
    wakeWordChunks = chunks;
    wakeWordRecorder = recorder;

    // Set up chunked STT if browser STT is available
    const browserSTT = (await import('../audio/browser-stt')).browserSTT;
    const useChunked = browserSTT.ready;
    // Priority: DOM select > localStorage > default 'zh'
    const sttLang = (document.getElementById('stt-language-select') as HTMLSelectElement | null)?.value
      || (() => { try { return localStorage.getItem(STORAGE_KEY + 'sttLang') || 'zh'; } catch (_e) { return 'zh'; } })();
    const chunkSilenceDetector = useChunked
      ? createSilenceDetector(getChunkMinDurationMs(), SILENCE_THRESHOLD, SILENCE_TRIGGER_MS)
      : null;
    const allChunks: Blob[] = [];
    if (useChunked) {
      _wwChunkSession = createChunkedTranscriptionSession(sttLang);
      recorder.addEventListener('dataavailable', (e: BlobEvent) => {
        if (e.data.size > 0) allChunks.push(e.data);
      });
    }

    recorder.onstop = async () => {
      // Chunk split: submit chunk for background transcription and restart recorder
      if (_wwChunkRestart) {
        _wwChunkRestart = false;
        const chunkBlob = buildRecordingBlob([...chunks]);
        chunks.length = 0;
        recorder.start();
        chunkSilenceDetector!.reset();
        if (chunkBlob && _wwChunkSession) {
          _wwChunkSession.submitChunk(chunkBlob);
        }
        return;
      }

      log.debug('Recording stopped');
      _stopRecordingFeed();
      stream.getTracks().forEach(t => t.stop());
      wakeWordStream = null;
      micState.setIdle();
      if (loopTimer) clearTimeout(loopTimer);
      setVoiceRipple(0);
      playVoiceFeedback(wakeWordRecordingCancelled ? 'cancel' : 'stop');
      flushDeferredReads();
      if (wwSpeechRecog) { try { wwSpeechRecog.stop(); } catch (_e) { /* ignore */ } wwSpeechRecog = null; }

      const _restartWW = _restartWakeWord;

      if (wakeWordRecordingCancelled) {
        wakeWordRecordingCancelled = false;
        if (_wwChunkSession) { _wwChunkSession.cancel(); _wwChunkSession = null; }
        const cancelBlob = buildRecordingBlob(useChunked ? allChunks : chunks);
        if (cancelBlob) {
          const cancelBotId = getCurrentBotId();
          blobToBase64(cancelBlob).then(b64 => _saveToHistory(b64, cancelBotId, { cancelled: true, status: 'recorded' })).catch(() => {});
        }
        botTurnState.resetToIdle(getCurrentBotId());
        log.debug('Cancelled before send');
        _restartWW();
        return;
      }

      const blob = buildRecordingBlob(chunks);
      // Strip pipeline suffix (e.g. "Americano (E2)" → "Americano") so STT trim can match the spoken word
      const _trimEwRaw = _pvEndwordEnabled ? pvEndword : _owwEndwordEnabled ? owwEndwordKeyword : endWord;
      const _trimEw = _trimEwRaw.replace(/ \([A-Za-z0-9]+\)$/, '').trim();

      // Chunked path: submit final chunk, finalize, trim end word, emit ONE message
      if (useChunked && _wwChunkSession) {
        const session = _wwChunkSession;
        _wwChunkSession = null;
        if (blob) session.submitChunk(blob);

        if (!session.hasChunks) {
          botTurnState.resetToIdle(getCurrentBotId(), chunks.length ? 'too_short' : undefined);
          _restartWW();
          return;
        }

        const botId = getCurrentBotId();
        botTurnState.transition(botId, 'stt');
        let transcript = await session.finalize();

        if (transcript) {
          // Trim end word from concatenated result
          if (_trimEw) {
            const ewLower = _trimEw.toLowerCase();
            const tLower = transcript.toLowerCase();
            if (tLower.endsWith(ewLower)) transcript = transcript.slice(0, -_trimEw.length).trim();
            else if (tLower.endsWith(ewLower + '。') || tLower.endsWith(ewLower + '.')) transcript = transcript.slice(0, -(_trimEw.length + 1)).trim();
          }
          if (!transcript) { botTurnState.resetToIdle(botId); _restartWW(); return; }
          botTurnState.transition(botId, 'sending');
          const msgId = ws.nextMsgId();
          bus.emit('chat:add-user-msg', { botId, text: transcript, clientMsgId: msgId });
          outbox.enqueue({ type: 'text', text: transcript, botId }, msgId);
          const fullBlob = buildRecordingBlob(allChunks) || blob;
          if (fullBlob) blobToBase64(fullBlob).then(b64 => _saveToHistory(b64, botId, { transcript: transcript! })).catch(() => {});
        } else {
          // All chunks failed — fallback to full audio for server-side STT
          const fullBlob = buildRecordingBlob(allChunks);
          if (fullBlob) {
            const b64 = await blobToBase64(fullBlob);
            outbox.enqueue({ type: 'audio', audioB64: b64, botId, trimEndWord: _trimEw });
            _saveToHistory(b64, botId);
            botTurnState.transition(botId, 'sending');
          } else {
            botTurnState.resetToIdle(botId, 'not_heard');
          }
        }
        _restartWW();
        return;
      }

      // Non-chunked path (original behavior)
      _wwChunkSession = null;
      if (!blob) {
        botTurnState.resetToIdle(getCurrentBotId(), chunks.length ? 'too_short' : undefined);
        _restartWW();
        return;
      }

      const botId = getCurrentBotId();
      botTurnState.transition(botId, 'stt');

      if (browserSTT.ready) {
        try {
          let transcript = await browserSTT.transcribe(blob, sttLang);
          if (!transcript) {
            botTurnState.resetToIdle(botId, 'not_heard');
            _restartWW();
            return;
          }
          if (_trimEw && transcript) {
            const ewLower = _trimEw.toLowerCase();
            const tLower = transcript.toLowerCase();
            if (tLower.endsWith(ewLower)) transcript = transcript.slice(0, -_trimEw.length).trim();
            else if (tLower.endsWith(ewLower + '。') || tLower.endsWith(ewLower + '.')) transcript = transcript.slice(0, -(_trimEw.length + 1)).trim();
          }
          if (!transcript) { botTurnState.resetToIdle(botId); _restartWW(); return; }
          botTurnState.transition(botId, 'sending');
          const msgId = ws.nextMsgId();
          bus.emit('chat:add-user-msg', { botId, text: transcript, clientMsgId: msgId });
          outbox.enqueue({ type: 'text', text: transcript, botId }, msgId);
          blobToBase64(blob).then(b64 => _saveToHistory(b64, botId, { transcript })).catch(() => {});
          _restartWW();
        } catch (_e) {
          const b64 = await blobToBase64(blob);
          outbox.enqueue({ type: 'audio', audioB64: b64, botId, trimEndWord: _trimEw });
          botTurnState.transition(botId, 'sending');
          _saveToHistory(b64, botId);
          _restartWW();
        }
      } else {
        const b64 = await blobToBase64(blob);
        outbox.enqueue({ type: 'audio', audioB64: b64, botId, trimEndWord: _trimEw });
        botTurnState.transition(botId, 'sending');
        _saveToHistory(b64, botId);
        _restartWW();
      }
    };

    // Wait for "我在" feedback to finish before recording starts to prevent echo bleed-in.
    await _feedbackDone;
    recorder.start();

    // Bridge recording stream audio into OWW pipeline for end/cancel word detection
    if (_owwEndwordEnabled || owwCancelwordSession) {
      _startRecordingFeed(stream);
    }

    // SpeechRecognition endword/cancelword detection (fallback when Porcupine endword not active)
    if (wwSpeechRecog) { try { wwSpeechRecog.stop(); } catch (_e) { /* ignore */ } wwSpeechRecog = null; }
    if (_pvEndwordEnabled || _owwEndwordEnabled) {
      log.debug((_pvEndwordEnabled ? 'Porcupine' : 'OWW') + ' endword active, skipping SpeechRecognition');
    } else {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const SpeechRecogClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecogClass && endWord) {
        try {
          const recog = new SpeechRecogClass() as any;
          recog.lang = 'zh-CN';
          recog.interimResults = true;
          recog.continuous = true;
          const _ewChars = [...endWord].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          const _ewPat = new RegExp(_ewChars.join('\\s*') + '[啊呀吧呢嘛啦哈]?');
          let _cwPat: RegExp | null = null;
          if (cancelWord) {
            const _cwChars = [...cancelWord].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            _cwPat = new RegExp(_cwChars.join('\\s*') + '[啊呀吧呢嘛啦哈]?');
          }
          recog.onresult = (e: any) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const text = e.results[i][0].transcript as string;
              if (_cwPat && _cwPat.test(text)) {
                log.debug('Cancel word detected via SpeechRecognition', { text });
                if (micState.isActive) {
                  _wwChunkRestart = false;
                  wakeWordRecordingCancelled = true;
                  if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
                }
                const wasPlaying = audioPlayer.state === 'playing' || audioPlayer.state === 'paused';
                if (wasPlaying) interruptBot(getCurrentBotId(), 'stopped_reading');
                showToast(wasPlaying ? t('toast.cancelled_recording_and_reading') : t('toast.cancelled_recording'));
                return;
              }
              if (_ewPat.test(text)) {
                log.debug('End word detected via SpeechRecognition', { text });
                _wwChunkRestart = false;
                if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
                return;
              }
            }
          };
          recog.onerror = (e: any) => { log.debug('SpeechRecognition error', { detail: String(e.error || e) }); };
          recog.start();
          wwSpeechRecog = recog;
          log.debug('SpeechRecognition started', { endWord, cancelWord });
        } catch (_e) { log.debug('SpeechRecognition unavailable'); wwSpeechRecog = null; }
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }

    // Silence detection + chunked STT split
    const tick = () => {
      const rms = computeRMS(analyser, buf);
      const now = Date.now();
      setVoiceRipple(rms);
      if (rms > LEVEL_TH) lastLoudAt = now;

      // Final stop conditions — ensure chunkRestart is false so onstop does final processing
      if (now - startedAt > MIN_RECORD_MS && now - lastLoudAt > END_SILENCE_MS) {
        _wwChunkRestart = false;
        if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
        return;
      }
      if (now - startedAt > MAX_RECORD_MS) {
        _wwChunkRestart = false;
        if (wakeWordRecorder?.state === 'recording') wakeWordRecorder.stop();
        return;
      }

      // Chunked STT: check for silence to trigger chunk split
      if (chunkSilenceDetector && wakeWordRecorder && wakeWordRecorder.state === 'recording') {
        if (chunkSilenceDetector.check(rms, performance.now())) {
          _wwChunkRestart = true;
          wakeWordRecorder.stop();
        }
      }

      loopTimer = setTimeout(tick, 80);
    };
    tick();
  }).catch(_e => {
    micState.setIdle();
    wakeWordRecordingCancelled = false;
    botTurnState.resetToIdle(getCurrentBotId(), 'no_mic');
    if (getInputMode() === 'wakeword' && !wwPaused) {
      stopWakeWord();
      setTimeout(() => { if (getInputMode() === 'wakeword' && !wwPaused && !micState.isActive) startWakeWord(); }, 500);
    }
  });
}

export function cancelWakeWordRecording(): void {
  _wwChunkRestart = false;
  if (_wwChunkSession) { _wwChunkSession.cancel(); _wwChunkSession = null; }
  wakeWordRecordingCancelled = true;
  if (wakeWordRecorder?.state === 'recording') {
    wakeWordRecorder.stop();
  } else {
    wakeWordRecordingCancelled = false;
    if (wakeWordStream) {
      wakeWordStream.getTracks().forEach(t => t.stop());
      wakeWordStream = null;
    }
    micState.setIdle();
    botTurnState.resetToIdle(getCurrentBotId());
    if (getInputMode() === 'wakeword' && !wwPaused) {
      stopWakeWord();
      setTimeout(() => { if (getInputMode() === 'wakeword' && !wwPaused && !micState.isActive) startWakeWord(); }, 500);
    }
  }
  showToast(t('toast.cancelled_recording'));
}

export function stopWakeWordRecording(): void {
  // Stop recording and send for transcription (like endword behavior)
  if (!micState.isActive) return;
  _wwChunkRestart = false;
  if (wakeWordRecorder?.state === 'recording') {
    wakeWordRecorder.stop();
  }
}

export function applyInputMode(mode: string): void {
  setInputMode(mode as 'ptt' | 'wakeword');
  syncSetting('inputMode', mode);
  const hintEl = getHintEl();
  stopWakeWord();
  if (mode === 'wakeword') {
    const activeWw = Object.values(wwMapping).find(Boolean) || '';
    if (hintEl) hintEl.textContent = t('wakeword.say_to_start', { keyword: activeWw });
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) micBtn.style.pointerEvents = 'none';
    botTurnState.resetToIdle(getCurrentBotId());
    wwPaused = false;
    startWakeWord();
    // Best-effort prefetch with whatever voice data is available (e.g. from localStorage).
    // main.ts invalidateVoiceFeedback() re-prefetches after server settings are loaded.
    BOT_IDS.forEach(id => (async () => { const { prefetchVoiceFeedback } = await import('../ui/mic-ui'); prefetchVoiceFeedback(id); })());
  } else {
    if (hintEl) hintEl.textContent = t('wakeword.ptt_hint');
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) micBtn.style.pointerEvents = 'auto';
    botTurnState.resetToIdle(getCurrentBotId());
  }
  updateWwToggle();
  updateListeningBanner();
}

/** Returns the active wakeword mic stream if available and live, null otherwise. */
export function getActiveMicStream(): MediaStream | null {
  if (!owwStream || !owwStream.active) return null;
  const track = owwStream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') return null;
  return owwStream;
}

// Exported for settings
export { wwMapping, saveWwMapping, PV_BUILTIN_KEYWORDS, OWW_KEYWORDS, OWW_KEYWORD_TO_MODEL, wwAllowBargeIn, wwMicAec, wwVadGate, pvEndword, pvCancelword, _migrateWwMapping, OWW_MODEL_META, owwEndwordKeyword, owwCancelwordKeyword, ensureWakewordConfigLoaded };
export function setWwAllowBargeIn(v: boolean): void { wwAllowBargeIn = v; }
export function setWwMicAec(v: boolean): void {
  wwMicAec = v;
  try { localStorage.setItem(STORAGE_KEY + 'wwMicAec', v ? '1' : '0'); } catch (_e) { /* ignore */ }
}
export function setWwVadGate(v: boolean): void {
  wwVadGate = v;
  try { localStorage.setItem(STORAGE_KEY + 'wwVadGate', v ? '1' : '0'); } catch (_e) { /* ignore */ }
}
export function setPvEndword(v: string): void { pvEndword = v; }
export function setPvCancelword(v: string): void { pvCancelword = v; }
export function setOwwEndwordKeyword(v: string): void { owwEndwordKeyword = v; }
export function setOwwCancelwordKeyword(v: string): void { owwCancelwordKeyword = v; }
export function setSkwsEndwordKeyword(v: string): void { skwsEndwordKeyword = v; }
export function setSkwsCancelwordKeyword(v: string): void { skwsCancelwordKeyword = v; }
export function getOwwThreshold(): number { return OWW_THRESHOLD; }
export function setOwwThreshold(v: number): void {
  OWW_THRESHOLD = Math.max(OWW_MIN_THRESHOLD, Math.min(OWW_MAX_THRESHOLD, v));
  try { localStorage.setItem(STORAGE_KEY + 'owwThreshold', OWW_THRESHOLD.toFixed(2)); } catch (_e) { /* ignore */ }
}
export { OWW_MIN_THRESHOLD, OWW_MAX_THRESHOLD, OWW_DEFAULT_THRESHOLD };
export function getSkwsThreshold(): number { return SKWS_THRESHOLD; }
export function setSkwsThreshold(v: number): void {
  SKWS_THRESHOLD = Math.max(SKWS_MIN_THRESHOLD, Math.min(SKWS_MAX_THRESHOLD, v));
  try { localStorage.setItem(STORAGE_KEY + 'skwsThreshold', SKWS_THRESHOLD.toFixed(2)); } catch (_e) { /* ignore */ }
}
export { SHERPA_KWS_KEYWORDS, SKWS_DEFAULT_THRESHOLD, SKWS_MIN_THRESHOLD, SKWS_MAX_THRESHOLD, skwsEndwordKeyword, skwsCancelwordKeyword };

// Re-export voiceprint functions for settings panel
export {
  isVoiceprintEnabled, setVoiceprintEnabled,
  getVoiceprintThreshold, setVoiceprintThreshold,
  hasEnrollment, getEnrollCount, clearEnrollment, enrollSpeaker, verifySpeakerWithAudio,
  VOICEPRINT_MIN_THRESHOLD, VOICEPRINT_MAX_THRESHOLD, VOICEPRINT_DEFAULT_THRESHOLD,
} from './voiceprint-verifier';

// Clear speech gate when audio playback ends naturally
bus.on('audio:state', (evt: { state: string }) => {
  if (evt.state === 'idle' && speechGateActive) {
    _clearSpeechGate();
  }
});

export { owwHotSwapKeywordWeights };

export function getOwwSessions() {
  return {
    melSession: owwMelSession,
    embSession: owwEmbSession,
    keywordSessions: owwKeywordSessions,
  };
}
