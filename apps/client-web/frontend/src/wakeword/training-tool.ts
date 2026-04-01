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
  realtimeTestingActive: boolean;
  realtimeDetectionCount: number;
  realtimeAudioLevel: number;
  batchTestingInProgress: boolean;
  batchTestingProgress: { current: number; total: number } | null;

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
    realtimeTestingActive: false,
    realtimeDetectionCount: 0,
    realtimeAudioLevel: 0,
    batchTestingInProgress: false,
    batchTestingProgress: null,
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
// 样本数量不再强制要求，用户可以完全依赖 TTS 生成

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
  // 不再强制要求样本数量，允许用户跳过录制完全使用 TTS 生成
  // 训练时会自动生成 TTS 样本
  return true;
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

// ──────────────────────────────────────────────
// Main Training Tool Controller
// ──────────────────────────────────────────────

import * as UI from './training-tool-ui';
import { SampleCollector, uploadSamples, generateTTSSamples } from './sample-collector';
import { ModelValidator } from './model-validator';

let collector: SampleCollector | null = null;
let validator: ModelValidator | null = null;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let recordingChunks: Float32Array[] = [];

export async function startTrainingTool(): Promise<void> {
  resetState();
  collector = new SampleCollector();
  validator = new ModelValidator();

  UI.createOverlay();
  renderCurrentStage();
}

export function closeTrainingTool(): void {
  stopRecording();
  UI.removeOverlay();
  state = null;
  collector = null;
  validator = null;
}

function renderCurrentStage(): void {
  if (!state) return;

  switch (state.stage) {
    case 'keyword':
      renderKeywordStage();
      break;
    case 'samples':
      renderSamplesStage();
      break;
    case 'training':
      renderTrainingStage();
      break;
    case 'validation':
      renderValidationStage();
      break;
    case 'install':
      renderInstallStage();
      break;
  }
}

function renderKeywordStage(): void {
  if (!state) return;

  UI.renderKeywordInput(state, {
    onKeywordChange: async (keyword: string) => {
      if (state) {
        state.keyword = keyword;
        state.keywordValid = validateKeyword(keyword);
        if (state.keywordValid) {
          state.trainingMode = await detectTrainingMode(keyword);
        }
        // Only update button state, don't rebuild input field
        // This preserves cursor position and input focus
        UI.updateKeywordInputButtonState(state);
      }
    },
    onNext: () => {
      if (state && canProceedToSamples(state)) {
        state.stage = 'samples';
        renderCurrentStage();
      }
    },
    onCancel: () => {
      closeTrainingTool();
    },
  });
}

function renderSamplesStage(): void {
  if (!state || !collector) return;

  state.micSamples = collector.getSamples();

  UI.renderSampleCollection(state, {
    onStartRecording: () => {
      if (state) {
        state.recordingInProgress = true;
        startRecording();
        renderCurrentStage();
      }
    },
    onStopRecording: () => {
      if (state) {
        state.recordingInProgress = false;
        stopRecording();
        renderCurrentStage();
      }
    },
    onDeleteSample: (id: string) => {
      collector?.removeSample(id);
      if (state) {
        state.micSamples = collector?.getSamples() || [];
        renderCurrentStage();
      }
    },
    onGenerateTTS: async (count: number) => {
      if (state) {
        log.info('Generating TTS samples', { count });
        const result = await generateTTSSamples(state.keyword, count);
        if (result.success) {
          state.sessionId = result.sessionId || null;
          // 更新 TTS 样本计数显示
          state.ttsSamples = state.ttsSamples || [];
          // 添加虚拟样本用于显示（实际样本在后端 session 中）
          for (let i = 0; i < (result.generatedCount || count); i++) {
            state.ttsSamples.push({
              id: `tts_${Date.now()}_${i}`,
              source: 'tts',
              audioData: new Float32Array(0),
              duration: 0,
              rms: 0,
              valid: true,
            });
          }
          log.info('TTS samples generated', { count: result.generatedCount });
          renderCurrentStage();
        } else {
          log.error('Failed to generate TTS samples', { error: result.error });
        }
      }
    },
    onBack: () => {
      if (state) {
        state.stage = 'keyword';
        renderCurrentStage();
      }
    },
    onNext: () => {
      if (state) {
        state.stage = 'training';
        startTraining();
        renderCurrentStage();
      }
    },
  });
}

function renderTrainingStage(): void {
  if (!state) return;

  UI.renderTraining(state, {
    onCancel: () => {
      if (state?.taskId) {
        fetch(`/wakeword/train/${state.taskId}`, { method: 'DELETE' });
      }
      closeTrainingTool();
    },
  });
}

function renderValidationStage(): void {
  if (!state) return;

  UI.renderValidation(state, {
    onStartRealtimeTest: async () => {
      if (!state) return;
      state.realtimeTestingActive = true;
      state.realtimeDetectionCount = 0;
      renderCurrentStage();
      await startRealtimeDetection();
    },
    onStopRealtimeTest: () => {
      if (!state) return;
      state.realtimeTestingActive = false;
      stopRealtimeDetection();
      renderCurrentStage();
    },
    onRunBatchTest: async () => {
      if (!state || !collector) return;

      // 获取录制样本
      const samples = collector.getValidSamples();

      if (samples.length === 0) {
        // 无录制样本，提示用户
        log.warn('No recorded samples for batch testing');
        return;
      }

      // 设置批量测试进度状态
      state.batchTestingInProgress = true;
      state.batchTestingProgress = { current: 0, total: samples.length };
      renderCurrentStage();

      // 运行批量测试，带进度回调
      const results = await validateBatchSamples(
        samples.map(s => ({
          id: s.id,
          audioData: s.audioData,
        })),
        state.keyword,
        (current, total) => {
          if (state) {
            state.batchTestingProgress = { current, total };
            renderCurrentStage();
          }
        },
      );

      // 更新结果和状态
      if (state) {
        state.validationResults = results;
        state.batchTestingInProgress = false;
        state.batchTestingProgress = null;
        renderCurrentStage();
      }
    },
    onBack: () => {
      if (state) {
        stopRealtimeDetection();
        state.stage = 'samples';
        renderCurrentStage();
      }
    },
    onNext: () => {
      if (state) {
        stopRealtimeDetection();
        state.stage = 'install';
        renderCurrentStage();
      }
    },
  });
}

// 实时检测状态
let realtimeMediaStream: MediaStream | null = null;
let realtimeAudioContext: AudioContext | null = null;
let realtimeRms: number = 0;

async function startRealtimeDetection(): Promise<void> {
  if (!state?.modelFile) {
    log.warn('No model file available for realtime detection');
    return;
  }

  log.info('Starting realtime detection', { keyword: state.keyword, modelFile: state.modelFile });

  try {
    // 获取麦克风流
    realtimeMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    realtimeAudioContext = new AudioContext({ sampleRate: 16000 });
    const source = realtimeAudioContext.createMediaStreamSource(realtimeMediaStream);

    // 创建音频处理器
    const processor = realtimeAudioContext.createScriptProcessor(4096, 1, 1);
    let audioBuffer: Float32Array[] = [];
    const chunkSize = 1280; // 80ms at 16kHz
    let detectCount = 0;

    processor.onaudioprocess = async (e) => {
      if (!state?.realtimeTestingActive) return;

      const inputData = e.inputBuffer.getChannelData(0);

      // 计算 RMS 并更新状态
      let sumSq = 0;
      for (let i = 0; i < inputData.length; i++) sumSq += inputData[i] * inputData[i];
      realtimeRms = Math.sqrt(sumSq / inputData.length);

      // 每隔一段时间更新 UI 显示音频级别
      if (state && detectCount % 5 === 0) {
        state.realtimeAudioLevel = realtimeRms;
        renderCurrentStage();
      }
      detectCount++;

      audioBuffer.push(new Float32Array(inputData));

      // 合并缓冲区 - 约 400ms
      if (audioBuffer.length >= 10) {
        const totalLength = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        const audio = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of audioBuffer) {
          audio.set(chunk, offset);
          offset += chunk.length;
        }
        audioBuffer = [];

        // 发送到后端检测
        try {
          const response = await fetch('/wakeword/detect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              keyword: state.keyword,
              audio: Array.from(audio),
            }),
          });

          if (response.ok) {
            const result = await response.json();
            log.info('Detection result', {
              detected: result.detected,
              confidence: result.confidence?.toFixed(4),
              method: result.method,
              sequences: result.sequences,
            });
            if (result.detected && state) {
              state.realtimeDetectionCount = (state.realtimeDetectionCount || 0) + 1;
              renderCurrentStage();
            }
          }
        } catch (e) {
          log.warn('Detection request failed', { error: String(e) });
        }
      }
    };

    source.connect(processor);
    processor.connect(realtimeAudioContext.destination);

    log.info('Started realtime detection', { keyword: state.keyword });
  } catch (e) {
    log.error('Failed to start realtime detection', { error: String(e) });
    if (state) {
      state.realtimeTestingActive = false;
      renderCurrentStage();
    }
  }
}

function stopRealtimeDetection(): void {
  if (realtimeMediaStream) {
    realtimeMediaStream.getTracks().forEach(t => t.stop());
    realtimeMediaStream = null;
  }
  if (realtimeAudioContext) {
    realtimeAudioContext.close();
    realtimeAudioContext = null;
  }
  realtimeRms = 0;
  if (state) {
    state.realtimeAudioLevel = 0;
  }
  log.info('Stopped realtime detection');
}

function renderInstallStage(): void {
  if (!state) return;

  UI.renderInstall(state, {
    onInstall: async () => {
      if (state?.taskId) {
        await fetch('/wakeword/train/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword: state.keyword, taskId: state.taskId }),
        });
      }
      closeTrainingTool();
    },
    onDownload: () => {
      if (state?.modelFile) {
        const a = document.createElement('a');
        a.href = state.modelFile;
        a.download = `${state.keyword}.onnx`;
        a.click();
      }
    },
    onClose: () => {
      closeTrainingTool();
    },
  });
}

// ──────────────────────────────────────────────
// Audio Recording
// ──────────────────────────────────────────────

async function startRecording(): Promise<void> {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(mediaStream);

    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      recordingChunks.push(new Float32Array(inputData));
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
  } catch (e) {
    log.error('Failed to start recording', { error: String(e) });
  }
}

function stopRecording(): void {
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (recordingChunks.length > 0 && collector) {
    const totalLength = recordingChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const audio = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of recordingChunks) {
      audio.set(chunk, offset);
      offset += chunk.length;
    }
    collector.addSample(audio, 'mic');
  }

  recordingChunks = [];
}

// ──────────────────────────────────────────────
// Training
// ──────────────────────────────────────────────

async function startTraining(): Promise<void> {
  if (!state || !collector) return;

  try {
    const validSamples = collector.getValidSamples();
    let sessionId: string | null = null;

    if (validSamples.length > 0) {
      // 有录制的样本，先上传
      log.info('Uploading recorded samples', { count: validSamples.length });
      const formData = await collector.exportForUpload(state.keyword);
      const uploadResult = await uploadSamples(formData);

      if (uploadResult.success) {
        sessionId = uploadResult.sessionId || null;
        log.info('Samples uploaded', { sessionId, count: uploadResult.sampleCount });
      } else {
        log.warn('Failed to upload samples, will use TTS', { error: uploadResult.error });
      }
    }

    // 如果没有 sessionId（没有录制样本或上传失败），自动生成 TTS 样本
    if (!sessionId) {
      log.info('Generating TTS samples for training');
      const ttsResult = await generateTTSSamples(state.keyword, 20); // 生成 20 个 TTS 样本

      if (!ttsResult.success) {
        log.error('Failed to generate TTS samples', { error: ttsResult.error });
        return;
      }

      sessionId = ttsResult.sessionId || null;
      log.info('TTS samples generated', { sessionId, count: ttsResult.generatedCount });
    }

    if (!sessionId) {
      log.error('No session ID available for training');
      return;
    }

    state.sessionId = sessionId;

    // Start training
    const resp = await fetch('/wakeword/train/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: state.keyword,
        sessionId: state.sessionId,
        steps: 20000,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      state.taskId = data.taskId;
      pollTrainingStatus();
    } else {
      const error = await resp.text();
      log.error('Failed to start training', { error, status: resp.status });
    }
  } catch (e) {
    log.error('Failed to start training', { error: String(e) });
  }
}

async function pollTrainingStatus(): Promise<void> {
  if (!state?.taskId) return;

  const resp = await fetch(`/wakeword/train/status/${state.taskId}`);
  if (resp.ok) {
    const data = await resp.json();

    if (data.status === 'running' || data.status === 'pending') {
      state.trainingProgress = {
        step: data.progress?.step || 0,
        totalSteps: data.progress?.totalSteps || 20000,
        loss: data.progress?.loss || 0,
        accuracy: data.progress?.accuracy || 0,
        phase: 'training',
      };
      renderCurrentStage();
      setTimeout(pollTrainingStatus, 1000);
    } else if (data.status === 'completed') {
      // 保存模型 URL
      if (data.modelUrl) {
        state.modelFile = data.modelUrl;
      }
      state.stage = 'validation';
      renderCurrentStage();
    } else if (data.status === 'failed') {
      log.error('Training failed', { error: data.error });
      closeTrainingTool();
    }
  }
}

// Import validateBatchSamples for batch testing
import { validateBatchSamples } from './model-validator';