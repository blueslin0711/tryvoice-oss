// apps/client-web/frontend/src/wakeword/training-tool.ts
/**
 * Wakeword training tool main controller.
 *
 * Manages the 5-stage training flow:
 * 1. Keyword input
 * 2. Sample collection
 * 3. Model training
 * 4. Online validation
 * 5. Install/Export
 */

import { createLogger } from '../logging/logger';

const log = createLogger('wakeword.training-tool');

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type TrainingStage = 'keyword' | 'samples' | 'training' | 'validation' | 'install';
export type TrainingMode = 'new' | 'finetune';

export interface AudioSample {
  id: string;
  source: 'mic' | 'tts';
  audioData: Float32Array;
  duration: number;
  rms: number;
  valid: boolean;
}

export interface TrainingProgress {
  step: number;
  totalSteps: number;
  loss: number;
  accuracy: number;
  phase: 'preparing' | 'training' | 'exporting';
}

export interface ValidationResult {
  sampleId: string;
  detected: boolean;
  confidence: number;
  latencyMs: number;
}

export interface TrainingToolState {
  // Stage control
  stage: TrainingStage;

  // Stage 1: Keyword
  keyword: string;
  keywordValid: boolean;
  trainingMode: TrainingMode;

  // Stage 2: Samples
  micSamples: AudioSample[];
  ttsSamples: AudioSample[];
  targetSampleCount: number;
  recordingInProgress: boolean;
  sessionId: string | null;

  // Stage 3: Training
  taskId: string | null;
  trainingProgress: TrainingProgress | null;

  // Stage 4: Validation
  validationResults: ValidationResult[];

  // Stage 5: Install
  modelFile: string | null;
  modelData: ArrayBuffer | null;
}

// ──────────────────────────────────────────────
// State Management
// ──────────────────────────────────────────────

let state: TrainingToolState | null = null;

export function createInitialState(): TrainingToolState {
  return {
    stage: 'keyword',
    keyword: '',
    keywordValid: false,
    trainingMode: 'new',
    micSamples: [],
    ttsSamples: [],
    targetSampleCount: 20,
    recordingInProgress: false,
    sessionId: null,
    taskId: null,
    trainingProgress: null,
    validationResults: [],
    modelFile: null,
    modelData: null,
  };
}

export function getState(): TrainingToolState | null {
  return state;
}

export function setState(newState: Partial<TrainingToolState>): void {
  if (state) {
    state = { ...state, ...newState };
  }
}

export function resetState(): void {
  state = createInitialState();
}

// ──────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────

const MIN_KEYWORD_LENGTH = 2;
const MAX_KEYWORD_LENGTH = 8;
const MIN_SAMPLES_REQUIRED = 5;

export function validateKeyword(keyword: string): boolean {
  if (!keyword || keyword.trim().length === 0) {
    return false;
  }

  const trimmed = keyword.trim();

  // Length check
  if (trimmed.length < MIN_KEYWORD_LENGTH || trimmed.length > MAX_KEYWORD_LENGTH) {
    return false;
  }

  // Character check - allow Chinese, English, numbers
  const validPattern = /^[\u4e00-\u9fa5a-zA-Z0-9]+$/;
  return validPattern.test(trimmed);
}

export function canProceedToSamples(s: TrainingToolState): boolean {
  return s.keywordValid && s.keyword.length > 0;
}

export function canProceedToTraining(s: TrainingToolState): boolean {
  const totalSamples = s.micSamples.filter(sample => sample.valid).length +
                       s.ttsSamples.filter(sample => sample.valid).length;
  return totalSamples >= MIN_SAMPLES_REQUIRED;
}

export function canProceedToValidation(s: TrainingToolState): boolean {
  return s.taskId !== null && s.trainingProgress !== null;
}

// ──────────────────────────────────────────────
// Persistence
// ──────────────────────────────────────────────

const STORAGE_KEY = 'tryvoice_training_state';

export function saveStateToStorage(): void {
  if (!state) return;

  try {
    // Only save serializable fields (exclude Float32Array)
    const toSave = {
      stage: state.stage,
      keyword: state.keyword,
      keywordValid: state.keywordValid,
      trainingMode: state.trainingMode,
      targetSampleCount: state.targetSampleCount,
      sessionId: state.sessionId,
      taskId: state.taskId,
      modelFile: state.modelFile,
      // Store sample metadata only
      micSampleCount: state.micSamples.length,
      ttsSampleCount: state.ttsSamples.length,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (e) {
    log.warn('Failed to save training state', { error: String(e) });
  }
}

export function loadStateFromStorage(): Partial<TrainingToolState> | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    log.warn('Failed to load training state', { error: String(e) });
  }
  return null;
}

export function clearStateFromStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // Ignore
  }
}

// ──────────────────────────────────────────────
// Mode Detection
// ──────────────────────────────────────────────

export async function detectTrainingMode(keyword: string): Promise<TrainingMode> {
  try {
    const resp = await fetch('/config');
    if (resp.ok) {
      const config = await resp.json() as { wwMapping?: Record<string, string> };
      if (config.wwMapping && keyword in config.wwMapping) {
        return 'finetune';
      }
    }
  } catch (e) {
    log.warn('Failed to detect training mode', { error: String(e) });
  }
  return 'new';
}