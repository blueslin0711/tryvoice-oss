// apps/client-web/frontend/src/wakeword/sample-collector.ts
/**
 * Sample collection for wakeword training.
 *
 * Handles microphone recording, quality validation, and TTS sample generation.
 */

import { createLogger } from '../logging/logger';

const log = createLogger('wakeword.sample-collector');

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

export const SAMPLE_RATE = 16000;
export const MIN_DURATION_S = 0.4;
export const MAX_DURATION_S = 4.0;
export const MIN_RMS = 0.005;

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface AudioSample {
  id: string;
  source: 'mic' | 'tts';
  audioData: Float32Array;
  duration: number;
  rms: number;
  valid: boolean;
}

export interface ValidationResult {
  valid: boolean;
  duration: number;
  rms: number;
  reason?: string;
}

// ──────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────

export function validateSample(audio: Float32Array): ValidationResult {
  const duration = audio.length / SAMPLE_RATE;

  // Check duration
  if (duration < MIN_DURATION_S) {
    return {
      valid: false,
      duration,
      rms: 0,
      reason: `Too short (${duration.toFixed(2)}s < ${MIN_DURATION_S}s)`,
    };
  }

  if (duration > MAX_DURATION_S) {
    return {
      valid: false,
      duration,
      rms: 0,
      reason: `Too long (${duration.toFixed(2)}s > ${MAX_DURATION_S}s)`,
    };
  }

  // Calculate RMS
  let sumSq = 0;
  for (let i = 0; i < audio.length; i++) {
    sumSq += audio[i] * audio[i];
  }
  const rms = Math.sqrt(sumSq / audio.length);

  // Check volume
  if (rms < MIN_RMS) {
    return {
      valid: false,
      duration,
      rms,
      reason: `Too quiet (RMS ${rms.toFixed(4)} < ${MIN_RMS})`,
    };
  }

  return {
    valid: true,
    duration,
    rms,
  };
}

// ──────────────────────────────────────────────
// Sample Collector
// ──────────────────────────────────────────────

export class SampleCollector {
  private samples: AudioSample[] = [];
  private sampleIdCounter = 0;

  addSample(audio: Float32Array, source: 'mic' | 'tts'): boolean {
    const validation = validateSample(audio);

    if (!validation.valid) {
      log.warn('Sample validation failed', {
        reason: validation.reason,
      });
      return false;
    }

    const sample: AudioSample = {
      id: `sample_${++this.sampleIdCounter}`,
      source,
      audioData: audio,
      duration: validation.duration,
      rms: validation.rms,
      valid: true,
    };

    this.samples.push(sample);
    return true;
  }

  removeSample(id: string): boolean {
    const index = this.samples.findIndex(s => s.id === id);
    if (index >= 0) {
      this.samples.splice(index, 1);
      return true;
    }
    return false;
  }

  getSamples(): AudioSample[] {
    return [...this.samples];
  }

  getValidSamples(): AudioSample[] {
    return this.samples.filter(s => s.valid);
  }

  getValidCount(): number {
    return this.samples.filter(s => s.valid).length;
  }

  getTotalCount(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples = [];
  }

  // Export for upload
  async exportForUpload(keyword: string): Promise<FormData> {
    const formData = new FormData();
    formData.append('keyword', keyword);

    const validSamples = this.getValidSamples();
    for (let i = 0; i < validSamples.length; i++) {
      const sample = validSamples[i];
      const wavBlob = this.float32ToWav(sample.audioData);
      formData.append('samples', wavBlob, `sample_${i}.wav`);
    }

    formData.append('sampleType', 'mic');
    return formData;
  }

  private float32ToWav(audio: Float32Array): Blob {
    // Convert float32 to int16
    const int16 = new Int16Array(audio.length);
    for (let i = 0; i < audio.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32768)));
    }

    // Create WAV file
    const buffer = new ArrayBuffer(44 + int16.length * 2);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + int16.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, 1, true); // AudioFormat (PCM)
    view.setUint16(22, 1, true); // NumChannels (mono)
    view.setUint32(24, SAMPLE_RATE, true); // SampleRate
    view.setUint32(28, SAMPLE_RATE * 2, true); // ByteRate
    view.setUint16(32, 2, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample
    writeString(36, 'data');
    view.setUint32(40, int16.length * 2, true);

    // Audio data
    for (let i = 0; i < int16.length; i++) {
      view.setInt16(44 + i * 2, int16[i], true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }
}

// ──────────────────────────────────────────────
// TTS Sample Generation
// ──────────────────────────────────────────────

export async function generateTTSSamples(
  keyword: string,
  count: number,
  voice: string = 'zh-CN-XiaoxiaoNeural',
  sessionId?: string,
): Promise<{ success: boolean; sessionId?: string; generatedCount?: number; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      keyword,
      count,
      voice,
    };

    if (sessionId) {
      body['sessionId'] = sessionId;
    }

    const resp = await fetch('/wakeword/train/tts-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const error = await resp.text();
      return { success: false, error };
    }

    const data = await resp.json();
    return {
      success: true,
      sessionId: data.sessionId,
      generatedCount: data.generatedCount,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// ──────────────────────────────────────────────
// Sample Upload
// ──────────────────────────────────────────────

export async function uploadSamples(
  formData: FormData,
): Promise<{ success: boolean; sessionId?: string; sampleCount?: number; error?: string }> {
  try {
    const resp = await fetch('/wakeword/train/samples', {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) {
      const error = await resp.text();
      return { success: false, error };
    }

    const data = await resp.json();
    return {
      success: true,
      sessionId: data.sessionId,
      sampleCount: data.sampleCount,
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}