// Voiceprint Verifier — optional speaker verification gate after wakeword detection
// Uses WeSpeaker ResNet34-LM ONNX model for speaker embedding extraction.
// All processing runs in-browser; no audio or embeddings are sent to the server.

import { createLogger } from '../logging/logger';
import { STORAGE_KEY } from '../core/types';
import { syncSetting } from '../ui/app-state';

const log = createLogger('wakeword.voiceprint');

// ---- Constants ----
const RING_BUFFER_SAMPLES = 24000; // 1.5 seconds @ 16 kHz
const DEFAULT_THRESHOLD = 0.35;
const MIN_THRESHOLD = 0.15;
const MAX_THRESHOLD = 0.60;
const LS_ENABLED = STORAGE_KEY + 'voiceprintEnabled';
const LS_THRESHOLD = STORAGE_KEY + 'voiceprintThreshold';
const LS_EMBEDDING = STORAGE_KEY + 'voiceprintEmbedding';
const LS_ENROLL_COUNT = STORAGE_KEY + 'voiceprintEnrollCount';

// ---- Verification history ----
const LS_HISTORY = STORAGE_KEY + 'voiceprintHistory';
const HISTORY_MAX = 100;

export type VoiceprintHistoryEntry = {
  ts: string;
  level: 'info' | 'warn' | 'error';
  component: 'wakeword.voiceprint';
  message: string;
  data: {
    score?: number;
    threshold?: number;
    trigger?: string;
    error?: string;
  };
};

export function getVoiceprintHistory(): VoiceprintHistoryEntry[] {
  try {
    const raw = localStorage.getItem(LS_HISTORY);
    return raw ? (JSON.parse(raw) as VoiceprintHistoryEntry[]) : [];
  } catch { return []; }
}

export function appendVoiceprintHistory(entry: VoiceprintHistoryEntry): void {
  try {
    const list = getVoiceprintHistory();
    list.push(entry);
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
    localStorage.setItem(LS_HISTORY, JSON.stringify(list));
  } catch { /* ignore quota errors */ }
}

export function clearVoiceprintHistory(): void {
  try { localStorage.removeItem(LS_HISTORY); } catch { /* ignore */ }
}

// Fbank parameters (must match WeSpeaker training config)
const SAMPLE_RATE = 16000;
const N_FFT = 512;
const HOP_LENGTH = 160;    // 10ms
const WIN_LENGTH = 400;     // 25ms
const N_MELS = 80;
const FMIN = 20;
const FMAX = 7600;

// ---- Ring buffer ----
const ringBuffer = new Float32Array(RING_BUFFER_SAMPLES);
let ringWritePos = 0;

// ---- ONNX session (lazy-loaded) ----
let svSession: { run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims: number[] }>> } | null = null;
let svSessionLoading = false;

const dbg = (msg: string, data?: Record<string, unknown>) => {
  log.debug(msg, data);
};

// ---- Ring buffer operations ----

export function feedAudioSamples(samples: Float32Array): void {
  for (let i = 0; i < samples.length; i++) {
    ringBuffer[ringWritePos] = samples[i];
    ringWritePos = (ringWritePos + 1) % RING_BUFFER_SAMPLES;
  }
}

function extractRingBuffer(): Float32Array {
  const out = new Float32Array(RING_BUFFER_SAMPLES);
  for (let i = 0; i < RING_BUFFER_SAMPLES; i++) {
    out[i] = ringBuffer[(ringWritePos + i) % RING_BUFFER_SAMPLES];
  }
  return out;
}

// ---- Fbank (Mel filterbank) feature extraction ----

let melFilterbank: Float32Array[] | null = null;

function hzToMel(hz: number): number {
  return 2595.0 * Math.log10(1.0 + hz / 700.0);
}

function melToHz(mel: number): number {
  return 700.0 * (Math.pow(10, mel / 2595.0) - 1.0);
}

function buildMelFilterbank(): Float32Array[] {
  if (melFilterbank) return melFilterbank;

  const nBins = N_FFT / 2 + 1;
  const melMin = hzToMel(FMIN);
  const melMax = hzToMel(FMAX);
  const melPoints = new Float32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    melPoints[i] = melMin + (melMax - melMin) * i / (N_MELS + 1);
  }

  const fftFreqs = new Float32Array(nBins);
  for (let i = 0; i < nBins; i++) {
    fftFreqs[i] = i * SAMPLE_RATE / N_FFT;
  }

  const hzPoints = new Float32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    hzPoints[i] = melToHz(melPoints[i]);
  }

  const filters: Float32Array[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const filter = new Float32Array(nBins);
    const left = hzPoints[m];
    const center = hzPoints[m + 1];
    const right = hzPoints[m + 2];
    for (let k = 0; k < nBins; k++) {
      const freq = fftFreqs[k];
      if (freq >= left && freq <= center) {
        filter[k] = (center - left) > 0 ? (freq - left) / (center - left) : 0;
      } else if (freq > center && freq <= right) {
        filter[k] = (right - center) > 0 ? (right - freq) / (right - center) : 0;
      }
    }
    filters.push(filter);
  }

  melFilterbank = filters;
  return filters;
}

function hannWindow(length: number): Float32Array {
  const win = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (length - 1)));
  }
  return win;
}

// Simple radix-2 FFT (in-place, Cooley-Tukey)
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  // FFT butterfly
  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const tRe = curRe * re[i + j + halfLen] - curIm * im[i + j + halfLen];
        const tIm = curRe * im[i + j + halfLen] + curIm * re[i + j + halfLen];
        re[i + j + halfLen] = re[i + j] - tRe;
        im[i + j + halfLen] = im[i + j] - tIm;
        re[i + j] += tRe;
        im[i + j] += tIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

function computeFbank(audio: Float32Array): Float32Array {
  const filters = buildMelFilterbank();
  const win = hannWindow(WIN_LENGTH);
  const nBins = N_FFT / 2 + 1;

  // Number of frames
  const nFrames = Math.max(1, Math.floor((audio.length - WIN_LENGTH) / HOP_LENGTH) + 1);

  // Output: [nFrames, N_MELS] stored as flat array
  const fbank = new Float32Array(nFrames * N_MELS);

  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);

  for (let t = 0; t < nFrames; t++) {
    const offset = t * HOP_LENGTH;

    // Zero-fill FFT buffers
    re.fill(0);
    im.fill(0);

    // Apply window and copy to FFT buffer
    for (let i = 0; i < WIN_LENGTH; i++) {
      const idx = offset + i;
      re[i] = idx < audio.length ? audio[idx] * win[i] : 0;
    }

    fft(re, im);

    // Power spectrum
    for (let k = 0; k < nBins; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k];
    }

    // Apply mel filterbank and log
    for (let m = 0; m < N_MELS; m++) {
      let energy = 0;
      const filter = filters[m];
      for (let k = 0; k < nBins; k++) {
        energy += re[k] * filter[k];
      }
      fbank[t * N_MELS + m] = Math.log(Math.max(energy, 1e-10));
    }
  }

  return fbank;
}

// ---- ONNX model management ----

async function ensureSvSession(): Promise<typeof svSession> {
  if (svSession) return svSession;
  if (svSessionLoading) {
    while (svSessionLoading) await new Promise(r => setTimeout(r, 50));
    return svSession;
  }
  svSessionLoading = true;
  try {
    const ort = (window as unknown as { ort?: {
      InferenceSession: { create: (url: string, opts: unknown) => Promise<unknown> };
      Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
    } }).ort;
    if (!ort) throw new Error('onnxruntime-web not loaded');

    const modelUrl = '/wakeword/speaker_verification.onnx';
    dbg('Loading speaker verification model...');
    const t0 = performance.now();
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    dbg('Model loaded', { elapsed_ms: Number((performance.now() - t0).toFixed(0)) });
    svSession = session as typeof svSession;
    return svSession;
  } catch (e) {
    dbg('Failed to load SV model', { detail: String(e) });
    throw e;
  } finally {
    svSessionLoading = false;
  }
}

async function extractEmbedding(audio: Float32Array): Promise<Float32Array> {
  const session = await ensureSvSession();
  if (!session) throw new Error('SV session not available');

  const ort = (window as unknown as { ort: {
    Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
  } }).ort;

  // Compute Fbank features: [nFrames, 80]
  const fbank = computeFbank(audio);
  const nFrames = fbank.length / N_MELS;

  // Create tensor with shape [1, nFrames, 80]
  const inputTensor = new ort.Tensor('float32', fbank, [1, nFrames, N_MELS]);
  const feeds: Record<string, unknown> = { input_features: inputTensor };

  const t0 = performance.now();
  const result = await session.run(feeds);
  const elapsed = performance.now() - t0;
  dbg('Inference complete', { elapsed_ms: Number(elapsed.toFixed(0)), frames: nFrames });

  const outputData = result['last_hidden_state'].data;
  return new Float32Array(outputData);
}

// ---- Cosine similarity ----

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---- Settings ----

export function isVoiceprintEnabled(): boolean {
  try { return localStorage.getItem(LS_ENABLED) === '1'; } catch { return false; }
}

export function setVoiceprintEnabled(v: boolean): void {
  try { localStorage.setItem(LS_ENABLED, v ? '1' : '0'); } catch { /* ignore */ }
}

export function getVoiceprintThreshold(): number {
  try {
    const raw = localStorage.getItem(LS_THRESHOLD);
    if (raw !== null) {
      const n = parseFloat(raw);
      if (!isNaN(n) && n >= MIN_THRESHOLD && n <= MAX_THRESHOLD) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_THRESHOLD;
}

export function setVoiceprintThreshold(v: number): void {
  const clamped = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, v));
  try { localStorage.setItem(LS_THRESHOLD, clamped.toFixed(2)); } catch { /* ignore */ }
}

export function hasEnrollment(): boolean {
  try { return localStorage.getItem(LS_EMBEDDING) !== null; } catch { return false; }
}

export function getEnrollCount(): number {
  try {
    const raw = localStorage.getItem(LS_ENROLL_COUNT);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch { return 0; }
}

export function clearEnrollment(): void {
  try {
    localStorage.removeItem(LS_EMBEDDING);
    localStorage.removeItem(LS_ENROLL_COUNT);
  } catch { /* ignore */ }
  // Clear from backend backup
  syncSetting('voiceprintEmbedding', null);
  syncSetting('voiceprintEnrollCount', null);
}

function loadStoredEmbedding(): Float32Array | null {
  try {
    const raw = localStorage.getItem(LS_EMBEDDING);
    if (!raw) return null;
    const arr = JSON.parse(raw) as number[];
    return new Float32Array(arr);
  } catch { return null; }
}

function saveEmbedding(emb: Float32Array, count: number): void {
  const embJson = Array.from(emb);
  try {
    localStorage.setItem(LS_EMBEDDING, JSON.stringify(embJson));
    localStorage.setItem(LS_ENROLL_COUNT, String(count));
  } catch { /* ignore */ }
  // Sync to backend for backup
  syncSetting('voiceprintEmbedding', embJson);
  syncSetting('voiceprintEnrollCount', count);
}

// ---- Core verification ----

export async function verifySpeaker(trigger?: string): Promise<boolean> {
  const storedEmb = loadStoredEmbedding();
  if (!storedEmb) {
    dbg('No enrollment found, passing through');
    return true;
  }

  const threshold = getVoiceprintThreshold();
  try {
    const audio = extractRingBuffer();
    const emb = await extractEmbedding(audio);
    const score = cosineSimilarity(emb, storedEmb);
    dbg('Verification score', { score: Number(score.toFixed(4)), threshold });
    const pass = score >= threshold;
    appendVoiceprintHistory({
      ts: new Date().toISOString(),
      level: pass ? 'info' : 'warn',
      component: 'wakeword.voiceprint',
      message: pass ? 'Speaker verified' : 'Speaker mismatch',
      data: { score: Number(score.toFixed(4)), threshold, trigger },
    });
    return pass;
  } catch (e) {
    const errMsg = String((e as Error).message || e);
    dbg('Verification failed, passing through', { detail: errMsg });
    appendVoiceprintHistory({
      ts: new Date().toISOString(),
      level: 'error',
      component: 'wakeword.voiceprint',
      message: 'Engine error (fail open)',
      data: { threshold, trigger, error: errMsg },
    });
    return true; // Fail open
  }
}

export async function enrollSpeaker(utterances: Float32Array[]): Promise<{ success: boolean; error?: string }> {
  if (utterances.length === 0) return { success: false, error: 'No utterances provided' };

  try {
    const embeddings: Float32Array[] = [];
    for (const utt of utterances) {
      const emb = await extractEmbedding(utt);
      embeddings.push(emb);
    }

    // Average the embeddings
    const dim = embeddings[0].length;
    const avg = new Float32Array(dim);
    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) avg[i] += emb[i];
    }
    for (let i = 0; i < dim; i++) avg[i] /= embeddings.length;

    // Normalize (unit vector)
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += avg[i] * avg[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) avg[i] /= norm;
    }

    saveEmbedding(avg, utterances.length);
    dbg('Enrolled', { utterances: utterances.length, dim });
    return { success: true };
  } catch (e) {
    dbg('Enrollment failed', { detail: String(e) });
    return { success: false, error: (e as Error).message };
  }
}

// ---- Backend restore ----

/** Restore voiceprint embedding from backend if localStorage is empty. */
export function restoreVoiceprintFromBackend(shared: Record<string, unknown>): void {
  if (hasEnrollment()) return; // localStorage already has data, no need to restore
  const emb = shared.voiceprintEmbedding;
  const count = shared.voiceprintEnrollCount;
  if (emb && Array.isArray(emb) && emb.length > 0) {
    try {
      localStorage.setItem(LS_EMBEDDING, JSON.stringify(emb));
      localStorage.setItem(LS_ENROLL_COUNT, String(count || emb.length));
      dbg('Restored voiceprint from backend', { dim: emb.length, count });
    } catch { /* ignore */ }
  }
}

// ---- Initialization ----

export function initVoiceprint(): void {
  dbg('Init', { enabled: isVoiceprintEnabled(), enrolled: hasEnrollment(), threshold: getVoiceprintThreshold() });
}

/** Run speaker verification on caller-supplied audio and return the raw similarity score. */
export async function verifySpeakerWithAudio(audio: Float32Array): Promise<{ score: number; pass: boolean }> {
  const storedEmb = loadStoredEmbedding();
  if (!storedEmb) return { score: 0, pass: true };
  try {
    const emb = await extractEmbedding(audio);
    const score = cosineSimilarity(emb, storedEmb);
    const threshold = getVoiceprintThreshold();
    dbg('Verification score (manual)', { score: Number(score.toFixed(4)), threshold });
    return { score, pass: score >= threshold };
  } catch (e) {
    dbg('Verification failed', { detail: String(e) });
    return { score: 0, pass: false };
  }
}

// ---- Constants export for settings UI ----
export const VOICEPRINT_MIN_THRESHOLD = MIN_THRESHOLD;
export const VOICEPRINT_MAX_THRESHOLD = MAX_THRESHOLD;
export const VOICEPRINT_DEFAULT_THRESHOLD = DEFAULT_THRESHOLD;
