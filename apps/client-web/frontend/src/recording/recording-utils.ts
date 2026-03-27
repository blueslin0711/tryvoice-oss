// Shared recording utilities — used by PTT and WakeWord modes
// Ported from app.js shared recording utilities section

const MIC_AUDIO_OPTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
const RECORDER_MIME = 'audio/webm;codecs=opus';
const MIN_BLOB_SIZE = 1000;

export function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO_OPTS });
}

export function newRecorder(stream: MediaStream): { recorder: MediaRecorder; chunks: Blob[] } {
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME });
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  return { recorder, chunks };
}

export function buildRecordingBlob(chunks: Blob[]): Blob | null {
  if (!chunks.length) return null;
  const blob = new Blob(chunks, { type: RECORDER_MIME });
  return blob.size >= MIN_BLOB_SIZE ? blob : null;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

// Dedicated AudioContext for mic analysis — kept separate from the playback
// AudioContext so that getUserMedia() on iOS doesn't switch the playback
// routing to the earpiece (voice-call mode).
let _micCtx: AudioContext | null = null;

export function createStreamAnalyser(stream: MediaStream): { analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> } {
  if (!_micCtx || _micCtx.state === 'closed') {
    _micCtx = new AudioContext();
  }
  const src = _micCtx.createMediaStreamSource(stream);
  const analyser = _micCtx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  return { analyser, buf: new Float32Array(analyser.fftSize) };
}

export function computeRMS(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

// Chunked STT constants
const DEFAULT_CHUNK_MIN_DURATION_MS = 60000;
let _chunkMinDurationMs: number | null = null;

export function getChunkMinDurationMs(): number {
  if (_chunkMinDurationMs !== null) return _chunkMinDurationMs;
  try {
    const saved = localStorage.getItem('tryvoice_sttChunkMinSec');
    if (saved) {
      const sec = parseFloat(saved);
      if (sec > 0 && isFinite(sec)) {
        _chunkMinDurationMs = sec * 1000;
        return _chunkMinDurationMs;
      }
    }
  } catch (_e) { /* ignore */ }
  return DEFAULT_CHUNK_MIN_DURATION_MS;
}

export function setChunkMinDurationMs(ms: number): void {
  _chunkMinDurationMs = ms;
}

/** @deprecated Use getChunkMinDurationMs() instead */
export const CHUNK_MIN_DURATION_MS = DEFAULT_CHUNK_MIN_DURATION_MS;
export const SILENCE_THRESHOLD = 0.01;
export const SILENCE_TRIGGER_MS = 500;

export interface SilenceDetector {
  /** Call on each animation frame with current RMS. Returns true when silence trigger fires. */
  check(rms: number, now: number): boolean;
  /** Reset after a chunk is emitted. */
  reset(): void;
}

// Chunked transcription session — accumulates chunk transcriptions in background,
// returns concatenated result on finalize.
export interface ChunkedTranscriptionSession {
  /** Submit audio blob for background transcription (no UI update). */
  submitChunk(blob: Blob): void;
  /** Await all pending transcriptions, return concatenated text (or null if ALL failed). */
  finalize(): Promise<string | null>;
  /** Discard all results immediately. */
  cancel(): void;
  /** True if at least one chunk was submitted. */
  readonly hasChunks: boolean;
}

export type Transcriber = (blob: Blob, lang: string) => Promise<string>;

export function createChunkedTranscriptionSession(
  sttLang: string,
  transcriber?: Transcriber,
): ChunkedTranscriptionSession {
  const results: { idx: number; promise: Promise<string | null> }[] = [];
  let cancelled = false;
  let nextIdx = 0;

  const _transcribe = (blob: Blob): Promise<string | null> => {
    if (transcriber) return transcriber(blob, sttLang).then(t => t || null).catch(() => null);
    return import('../audio/browser-stt').then(mod =>
      mod.browserSTT.transcribe(blob, sttLang)
    ).then(t => t || null).catch(() => null);
  };

  return {
    submitChunk(blob: Blob): void {
      if (cancelled) return;
      const idx = nextIdx++;
      const promise = _transcribe(blob);
      results.push({ idx, promise });
    },

    async finalize(): Promise<string | null> {
      if (cancelled || results.length === 0) return null;
      const settled = await Promise.allSettled(results.map(r => r.promise));
      // Sort by submission order and collect successful transcriptions
      const texts: string[] = [];
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === 'fulfilled' && s.value) texts.push(s.value);
      }
      return texts.length > 0 ? texts.join(' ') : null;
    },

    cancel(): void {
      cancelled = true;
      results.length = 0;
    },

    get hasChunks(): boolean {
      return nextIdx > 0;
    },
  };
}

export function createSilenceDetector(
  minDurationMs: number,
  silenceThreshold: number,
  silenceTriggerMs: number,
): SilenceDetector {
  let recordingStartedAt = 0;
  let silenceStartedAt = 0;

  return {
    check(rms: number, now: number): boolean {
      if (recordingStartedAt === 0) recordingStartedAt = now;
      const elapsed = now - recordingStartedAt;
      if (elapsed < minDurationMs) return false;

      if (rms < silenceThreshold) {
        if (silenceStartedAt === 0) silenceStartedAt = now;
        return (now - silenceStartedAt) >= silenceTriggerMs;
      } else {
        silenceStartedAt = 0;
        return false;
      }
    },
    reset() {
      recordingStartedAt = performance.now();
      silenceStartedAt = 0;
    },
  };
}
