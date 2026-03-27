/**
 * Wakeword personalization wizard UI.
 * Dashboard-first UX: all keywords + status, manual start/stop recording,
 * live waveform visualization, quality validation per recording.
 */

import { createLogger } from '../logging/logger';
import { extractBatchFeatures, generateSyntheticNegatives } from './personalization-features';
import { trainKeyword, loadNegativeFeatures, type ProgressCallback } from './personalization-trainer';
import { getOwwSessions, owwHotSwapKeywordWeights } from './wakeword-manager';

const log = createLogger('wakeword.personalization-wizard');

const UTTERANCES_PER_KEYWORD = 5;
const SAMPLE_RATE = 16000;
const MIN_DURATION_S = 0.4;
const MAX_DURATION_S = 4.0;
const MIN_RMS = 0.005;
const NEGATIVE_FEATURES_URL = '/wakeword/negative_features.bin';

type TrainingStatus = 'untrained' | 'training' | 'trained' | 'failed';

interface WizardState {
  keywords: string[];
  keywordToModel: Record<string, string>;
  modelMeta: Record<string, { role?: string; externalData?: string }>;
  statuses: Map<string, TrainingStatus>;
  activeKeyword: string | null;
  recordings: Float32Array[];
}

let state: WizardState | null = null;
let wizardOverlay: HTMLDivElement | null = null;
let negativeCache: Float32Array | null = null;

// Audio state (live during recording only)
let audioCtx: AudioContext | null = null;
let audioStream: MediaStream | null = null;
let analyserNode: AnalyserNode | null = null;
let processorNode: ScriptProcessorNode | null = null;
let recordingChunks: Float32Array[] = [];
let isRecording = false;
let recordingStartTime = 0;
let waveformAnimId: number | null = null;

/**
 * Launch the personalization wizard.
 * @param keywords All available OWW keyword names
 * @param keywordToModel Map keyword name → model filename
 * @param modelMeta Per-keyword metadata (role, inputShape)
 */
export async function startPersonalizationWizard(
  keywords: string[],
  keywordToModel: Record<string, string>,
  modelMeta: Record<string, { role?: string; externalData?: string }> = {},
): Promise<void> {
  // Only custom-trained models (with externalData) have the compatible
  // classifier architecture for personalization fine-tuning.
  // Official preset models have weights baked into the .onnx file and
  // use a different architecture — training them would silently produce
  // unusable results from random initialization.
  const trainable = keywords.filter(kw => modelMeta[kw]?.externalData === 'true');
  if (trainable.length === 0) {
    log.warn('No personalizable keywords (none have externalData)');
    return;
  }

  // Fetch current personalization status from backend
  let personalizedSet = new Set<string>();
  try {
    const resp = await fetch('/config');
    if (resp.ok) {
      const config = await resp.json() as { owwPersonalized?: Record<string, string> };
      if (config.owwPersonalized && typeof config.owwPersonalized === 'object') {
        personalizedSet = new Set(Object.keys(config.owwPersonalized));
      }
    }
  } catch (e) {
    log.warn('Failed to fetch config for personalization status', { error: String(e) });
  }

  state = {
    keywords: trainable,
    keywordToModel,
    modelMeta,
    statuses: new Map(trainable.map(kw => [kw, personalizedSet.has(kw) ? 'trained' : 'untrained'])),
    activeKeyword: null,
    recordings: [],
  };

  // Pre-load negative features in background
  if (!negativeCache) {
    loadNegativeFeatures(NEGATIVE_FEATURES_URL)
      .then(data => { negativeCache = data; })
      .catch(e => log.error('Failed to preload negative features', { error: String(e) }));
  }

  createOverlay();
  renderDashboard();
}

function createOverlay(): void {
  wizardOverlay = document.createElement('div');
  wizardOverlay.id = 'personalization-wizard-overlay';
  wizardOverlay.style.cssText = `
    position: fixed; inset: 0; z-index: 10000;
    background: rgba(10,10,20,0.97); color: #e0e0e0;
    display: flex; flex-direction: column; align-items: center;
    font-family: system-ui, -apple-system, sans-serif;
    overflow-y: auto;
    padding: 32px 0;
    box-sizing: border-box;
  `;
  document.body.appendChild(wizardOverlay);
}

// ──────────────────────────────────────────────
// DASHBOARD
// ──────────────────────────────────────────────

function renderDashboard(): void {
  if (!state || !wizardOverlay) return;

  const trainedCount = [...state.statuses.values()].filter(s => s === 'trained').length;

  const wakewords = state.keywords.filter(kw => {
    const role = state!.modelMeta[kw]?.role;
    return !role || role === 'wakeword';
  });
  const endwords = state.keywords.filter(kw => state!.modelMeta[kw]?.role === 'endword');
  const cancelwords = state.keywords.filter(kw => state!.modelMeta[kw]?.role === 'cancelword');

  function statusBadge(status: TrainingStatus): string {
    if (status === 'trained') return `<span style="color:#4CAF50;font-size:12px;">✓ Enhanced</span>`;
    if (status === 'training') return `<span style="color:#FFC107;font-size:12px;">⟳ Training...</span>`;
    if (status === 'failed') return `<span style="color:#f44336;font-size:12px;">✗ Failed</span>`;
    return `<span style="color:#444;font-size:12px;">Not trained</span>`;
  }

  function trainBtn(kw: string, status: TrainingStatus): string {
    if (status === 'training') {
      return `<button disabled style="background:#1a1a2e;border:1px solid #333;color:#555;border-radius:6px;padding:5px 14px;font-size:12px;cursor:default;">...</button>`;
    }
    const color = status === 'trained' ? '#4CAF50' : status === 'failed' ? '#f44336' : '#667eea';
    const label = status === 'trained' ? 'Retrain' : status === 'failed' ? 'Retry' : 'Train';
    return `<button class="pw-train-btn" data-kw="${kw}" style="background:transparent;border:1px solid ${color};color:${color};border-radius:6px;padding:5px 14px;cursor:pointer;font-size:12px;white-space:nowrap;">${label}</button>`;
  }

  function renderRow(kw: string): string {
    const status = state!.statuses.get(kw) ?? 'untrained';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:11px 14px;background:#111122;border-radius:8px;margin-bottom:6px;">
        <div>
          <div style="font-size:15px;font-weight:600;color:#e8e8e8;">${kw}</div>
          <div style="margin-top:3px;">${statusBadge(status)}</div>
        </div>
        ${trainBtn(kw, status)}
      </div>
    `;
  }

  function renderGroup(title: string, kws: string[]): string {
    if (kws.length === 0) return '';
    return `
      <div style="margin-bottom:20px;">
        <div style="font-size:11px;font-weight:700;color:#444;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px;">${title}</div>
        ${kws.map(renderRow).join('')}
      </div>
    `;
  }

  wizardOverlay.innerHTML = `
    <div style="width:100%;max-width:480px;padding:24px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;">
        <div>
          <div style="font-size:20px;font-weight:700;color:#fff;">Personalize Wakewords</div>
          <div style="font-size:13px;color:#555;margin-top:4px;">${trainedCount} of ${state.keywords.length} enhanced for your voice</div>
        </div>
        <button id="pw-close-btn" style="background:transparent;border:1px solid #2a2a3a;color:#666;border-radius:8px;padding:7px 14px;cursor:pointer;flex-shrink:0;font-size:13px;">Close</button>
      </div>

      <div style="font-size:13px;color:#555;margin-bottom:20px;line-height:1.6;">
        Record each keyword 5 times to train a personalized model for your voice. This runs entirely in your browser.
      </div>

      ${renderGroup('Wakewords', wakewords)}
      ${renderGroup('End Words', endwords)}
      ${renderGroup('Cancel Words', cancelwords)}

      ${trainedCount > 0 ? `
        <div style="border-top:1px solid #1a1a2e;padding-top:16px;margin-top:4px;">
          <button id="pw-reset-all-btn" style="background:transparent;border:1px solid #2a2a3a;color:#555;border-radius:8px;padding:8px 16px;cursor:pointer;font-size:12px;width:100%;">
            Reset All Enhancements to Default
          </button>
        </div>
      ` : ''}
    </div>
  `;

  document.getElementById('pw-close-btn')?.addEventListener('click', closeWizard);
  document.getElementById('pw-reset-all-btn')?.addEventListener('click', resetToDefault);
  document.querySelectorAll<HTMLElement>('.pw-train-btn').forEach(btn => {
    btn.addEventListener('click', () => startRecordingKeyword(btn.dataset.kw!));
  });
}

// ──────────────────────────────────────────────
// RECORDING
// ──────────────────────────────────────────────

function startRecordingKeyword(kw: string): void {
  if (!state) return;
  state.activeKeyword = kw;
  state.recordings = [];
  renderRecordingView();
}

function renderRecordingView(): void {
  if (!state || !wizardOverlay) return;
  const kw = state.activeKeyword!;
  const count = state.recordings.length;

  const dots = Array.from({ length: UTTERANCES_PER_KEYWORD }, (_, i) => {
    if (i < count) {
      return `<div style="width:20px;height:20px;border-radius:50%;background:#4CAF50;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#000;">✓</div>`;
    }
    if (i === count) {
      return `<div style="width:20px;height:20px;border-radius:50%;background:#667eea;box-shadow:0 0 10px rgba(102,126,234,0.55);"></div>`;
    }
    return `<div style="width:20px;height:20px;border-radius:50%;background:#111122;border:1px solid #2a2a3e;"></div>`;
  }).join('');

  const remaining = UTTERANCES_PER_KEYWORD - count;
  const subtitle = count === 0
    ? `Say it ${UTTERANCES_PER_KEYWORD} times, one at a time`
    : remaining > 0
    ? `${remaining} more recording${remaining > 1 ? 's' : ''} needed`
    : 'All done — starting training...';

  wizardOverlay.innerHTML = `
    <div style="width:100%;max-width:380px;padding:24px;text-align:center;">
      <button id="pw-back-btn" style="float:left;background:transparent;border:none;color:#444;cursor:pointer;font-size:22px;padding:0;line-height:1;margin-bottom:4px;">←</button>
      <div style="clear:both;height:16px;"></div>

      <div style="font-size:13px;color:#555;margin-bottom:6px;">Say this clearly:</div>
      <div style="font-size:40px;font-weight:800;color:#fff;margin-bottom:20px;letter-spacing:1px;">"${kw}"</div>

      <div style="display:flex;gap:10px;justify-content:center;margin-bottom:8px;">${dots}</div>
      <div style="font-size:12px;color:#555;margin-bottom:28px;">${subtitle}</div>

      <!-- Waveform canvas -->
      <div style="position:relative;margin-bottom:24px;height:72px;">
        <canvas id="pw-waveform" width="380" height="72"
          style="width:100%;height:72px;border-radius:10px;background:#0a0a18;display:block;"></canvas>
        <div id="pw-waveform-idle"
          style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#2a2a4a;font-size:13px;pointer-events:none;">
          tap ● to start recording
        </div>
      </div>

      <!-- Record button -->
      <div id="pw-record-btn" style="
        width:68px;height:68px;border-radius:50%;margin:0 auto 12px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        background:linear-gradient(135deg,#667eea,#764ba2);
        box-shadow:0 0 20px rgba(102,126,234,0.35);
        transition:background 0.2s,box-shadow 0.2s;
        user-select:none;-webkit-user-select:none;">
        <div id="pw-record-icon" style="
          width:26px;height:26px;border-radius:50%;background:#fff;
          transition:all 0.2s;"></div>
      </div>
      <div id="pw-record-label" style="font-size:13px;color:#555;margin-bottom:20px;">Tap to start recording</div>

      <!-- Feedback area -->
      <div id="pw-feedback" style="min-height:22px;font-size:14px;font-weight:600;margin-bottom:16px;"></div>

      ${count > 0 ? `
        <button id="pw-undo-btn"
          style="background:transparent;border:1px solid #2a2a3a;color:#555;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:12px;">
          ↩ Remove recording ${count}
        </button>
      ` : ''}
    </div>
  `;

  document.getElementById('pw-back-btn')?.addEventListener('click', () => {
    stopRecordingAudio();
    renderDashboard();
  });
  document.getElementById('pw-record-btn')?.addEventListener('click', toggleRecording);
  document.getElementById('pw-undo-btn')?.addEventListener('click', undoLastRecording);
}

function toggleRecording(): void {
  if (isRecording) {
    stopRecordingAndSave();
  } else {
    startRecordingAudio();
  }
}

async function startRecordingAudio(): Promise<void> {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: false, noiseSuppression: false },
    });
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioCtx.createMediaStreamSource(audioStream);

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.75;

    processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
    recordingChunks = [];
    isRecording = true;
    recordingStartTime = Date.now();

    processorNode.onaudioprocess = (e) => {
      if (!isRecording) return;
      recordingChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      if (Date.now() - recordingStartTime > MAX_DURATION_S * 1000) {
        stopRecordingAndSave();
      }
    };

    source.connect(analyserNode);
    source.connect(processorNode);
    processorNode.connect(audioCtx.destination);

    updateRecordingUI(true);
    startWaveformAnimation();

  } catch (e) {
    log.error('Mic access denied', { error: String(e) });
    const feedbackEl = document.getElementById('pw-feedback');
    if (feedbackEl) {
      feedbackEl.textContent = '⚠ Microphone access denied';
      feedbackEl.style.color = '#f44336';
    }
  }
}

function stopRecordingAudio(): void {
  isRecording = false;
  stopWaveformAnimation();
  processorNode?.disconnect();
  analyserNode?.disconnect();
  audioStream?.getTracks().forEach(t => t.stop());
  audioCtx?.close().catch(() => {});
  processorNode = null;
  analyserNode = null;
  audioStream = null;
  audioCtx = null;
}

function stopRecordingAndSave(): void {
  if (!isRecording) return;
  const chunks = [...recordingChunks];
  stopRecordingAudio();
  updateRecordingUI(false);
  validateAndSave(mergeChunks(chunks));
}

function validateAndSave(audio: Float32Array): void {
  const feedbackEl = document.getElementById('pw-feedback');
  const durationS = audio.length / SAMPLE_RATE;

  if (durationS < MIN_DURATION_S) {
    if (feedbackEl) {
      feedbackEl.textContent = '⚠ Too short — hold the button while speaking';
      feedbackEl.style.color = '#FFC107';
    }
    return;
  }

  let sumSq = 0;
  for (let i = 0; i < audio.length; i++) sumSq += audio[i] * audio[i];
  const rms = Math.sqrt(sumSq / audio.length);

  if (rms < MIN_RMS) {
    if (feedbackEl) {
      feedbackEl.textContent = '⚠ Too quiet — speak louder or move closer to mic';
      feedbackEl.style.color = '#FFC107';
    }
    return;
  }

  state!.recordings.push(audio);
  const count = state!.recordings.length;
  log.info('Utterance validated', {
    keyword: state!.activeKeyword,
    utterance: count,
    durationS: durationS.toFixed(2),
    rms: rms.toFixed(4),
  });

  if (feedbackEl) {
    feedbackEl.textContent = `✓ Recording ${count} of ${UTTERANCES_PER_KEYWORD} saved!`;
    feedbackEl.style.color = '#4CAF50';
  }

  if (count >= UTTERANCES_PER_KEYWORD) {
    setTimeout(() => trainActiveKeyword(), 800);
  } else {
    setTimeout(() => renderRecordingView(), 1000);
  }
}

function updateRecordingUI(recording: boolean): void {
  const btn = document.getElementById('pw-record-btn');
  const icon = document.getElementById('pw-record-icon');
  const label = document.getElementById('pw-record-label');
  const idle = document.getElementById('pw-waveform-idle');

  if (btn) {
    btn.style.background = recording
      ? 'linear-gradient(135deg,#f44336,#c62828)'
      : 'linear-gradient(135deg,#667eea,#764ba2)';
    btn.style.boxShadow = recording
      ? '0 0 28px rgba(244,67,54,0.5)'
      : '0 0 20px rgba(102,126,234,0.35)';
  }
  if (icon) {
    icon.style.borderRadius = recording ? '4px' : '50%';
    icon.style.width = recording ? '18px' : '26px';
    icon.style.height = recording ? '18px' : '26px';
  }
  if (label) {
    label.textContent = recording ? 'Recording... tap to stop' : 'Tap to start recording';
    label.style.color = recording ? '#f44336' : '#555';
  }
  if (idle) idle.style.display = recording ? 'none' : 'flex';
}

function startWaveformAnimation(): void {
  const canvas = document.getElementById('pw-waveform') as HTMLCanvasElement | null;
  if (!canvas || !analyserNode) return;

  const ctx2d = canvas.getContext('2d')!;
  const bufferLength = analyserNode.frequencyBinCount; // 128 for fftSize=256
  const dataArray = new Uint8Array(bufferLength);

  const BAR_COUNT = 40;

  function draw(): void {
    if (!isRecording || !analyserNode) return;
    waveformAnimId = requestAnimationFrame(draw);

    analyserNode.getByteFrequencyData(dataArray);

    const W = canvas!.width;
    const H = canvas!.height;
    ctx2d.clearRect(0, 0, W, H);

    const slotW = W / BAR_COUNT;
    const barW = Math.max(2, Math.floor(slotW * 0.6));
    const step = Math.floor(bufferLength / BAR_COUNT);

    for (let i = 0; i < BAR_COUNT; i++) {
      const value = dataArray[i * step] / 255;
      const barH = Math.max(3, value * (H - 12) * 0.9);
      const x = Math.floor(i * slotW + (slotW - barW) / 2);
      const y = (H - barH) / 2;

      // Blue → purple gradient keyed to signal strength
      const hue = 220 + value * 55;
      const sat = 50 + value * 40;
      const light = 32 + value * 28;
      ctx2d.fillStyle = `hsl(${hue},${sat}%,${light}%)`;
      ctx2d.fillRect(x, y, barW, barH);
    }
  }

  draw();
}

function stopWaveformAnimation(): void {
  if (waveformAnimId !== null) {
    cancelAnimationFrame(waveformAnimId);
    waveformAnimId = null;
  }
  const canvas = document.getElementById('pw-waveform') as HTMLCanvasElement | null;
  canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

function undoLastRecording(): void {
  if (!state || state.recordings.length === 0) return;
  state.recordings.pop();
  renderRecordingView();
}

// ──────────────────────────────────────────────
// TRAINING
// ──────────────────────────────────────────────

async function trainActiveKeyword(): Promise<void> {
  if (!state || !wizardOverlay) return;
  const kw = state.activeKeyword!;
  const recordings = [...state.recordings];
  state.statuses.set(kw, 'training');

  renderTrainingView(kw, 0, 10, 'negatives');

  try {
    const { melSession, embSession } = getOwwSessions();
    const ort = (window as any).ort;

    // Load pre-packaged negatives; fall back to synthetic if unavailable
    if (!negativeCache) {
      try {
        negativeCache = await loadNegativeFeatures(NEGATIVE_FEATURES_URL);
        log.info('Loaded pre-packaged negative features');
      } catch (e) {
        log.warn('negative_features.bin unavailable, generating synthetic negatives', { error: String(e) });
        renderTrainingView(kw, 0, 10, 'negatives');
        negativeCache = await generateSyntheticNegatives(200, melSession, embSession, ort);
      }
    }

    renderTrainingView(kw, 0, 10, 'features');
    const features = await extractBatchFeatures(recordings, melSession, embSession, ort);

    const modelFile = state.keywordToModel[kw];
    const onnxDataUrl = `/wakeword/${modelFile.replace('.onnx', '.onnx.data')}`;

    const onProgress: ProgressCallback = (progress) => {
      renderTrainingView(kw, progress.epoch ?? 0, progress.totalEpochs ?? 10, 'training');
    };
    const weightsBuffer = await trainKeyword(kw, features, negativeCache!, onnxDataUrl, onProgress);

    renderTrainingView(kw, 10, 10, 'saving');

    const formData = new FormData();
    formData.append('keyword', kw);
    formData.append('weights', new Blob([weightsBuffer]), `${kw}.onnx.data`);
    const resp = await fetch('/wakeword/personalized', { method: 'POST', body: formData });

    if (resp.ok) {
      const graphUrl = `/wakeword/${modelFile}`;
      const personalizedUrl = `/wakeword/personalized/${kw}.onnx.data`;
      await owwHotSwapKeywordWeights(kw, graphUrl, personalizedUrl);
      state.statuses.set(kw, 'trained');
      log.info('Personalization complete', { keyword: kw });
    } else {
      state.statuses.set(kw, 'failed');
      log.error('Failed to save weights', { keyword: kw, status: resp.status });
    }
  } catch (e) {
    state.statuses.set(kw, 'failed');
    log.error('Training failed', { keyword: kw, error: String(e) });
  }

  state.activeKeyword = null;
  state.recordings = [];
  renderDashboard();
}

function renderTrainingView(
  kw: string,
  epoch: number,
  totalEpochs: number,
  phase: 'negatives' | 'features' | 'training' | 'saving',
): void {
  if (!wizardOverlay) return;

  const phaseText = phase === 'negatives'
    ? 'Preparing training data...'
    : phase === 'features'
    ? 'Extracting voice features...'
    : phase === 'saving'
    ? 'Saving personalized model...'
    : `Training — epoch ${epoch} / ${totalEpochs}`;

  const pct = phase === 'negatives' ? 5
    : phase === 'features' ? 15
    : phase === 'saving' ? 96
    : Math.round(15 + (epoch / totalEpochs) * 76);

  wizardOverlay.innerHTML = `
    <div style="width:100%;max-width:380px;padding:32px;text-align:center;">
      <div style="font-size:36px;font-weight:800;color:#fff;margin-bottom:8px;">"${kw}"</div>
      <div style="font-size:14px;color:#666;margin-bottom:40px;">Learning your voice...</div>

      <div style="background:#0e0e1e;border-radius:12px;padding:24px;margin-bottom:24px;">
        <div style="font-size:13px;color:#666;margin-bottom:14px;">${phaseText}</div>
        <div style="background:#0a0a18;border-radius:4px;height:6px;overflow:hidden;">
          <div style="background:linear-gradient(90deg,#667eea,#764ba2);height:100%;width:${pct}%;border-radius:4px;transition:width 0.35s ease;"></div>
        </div>
        <div style="font-size:11px;color:#333;margin-top:8px;">${pct}%</div>
      </div>

      <div style="font-size:12px;color:#333;">Usually completes in 5–15 seconds</div>
    </div>
  `;
}

// ──────────────────────────────────────────────
// UTILS
// ──────────────────────────────────────────────

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function resetToDefault(): Promise<void> {
  try {
    await fetch('/wakeword/personalized', { method: 'DELETE' });
    log.info('Reset all personalized weights');
    window.location.reload();
  } catch (e) {
    log.error('Reset failed', { error: String(e) });
  }
}

function closeWizard(): void {
  stopRecordingAudio();
  wizardOverlay?.remove();
  wizardOverlay = null;
  state = null;
}
