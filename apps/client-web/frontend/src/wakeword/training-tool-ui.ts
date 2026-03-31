// apps/client-web/frontend/src/wakeword/training-tool-ui.ts
/**
 * UI rendering for the wakeword training tool.
 *
 * Provides stage-specific UI components that integrate with the main controller.
 */

import { createLogger } from '../logging/logger';
import type { TrainingToolState, AudioSample } from './training-tool';

const log = createLogger('wakeword.training-tool-ui');

// ──────────────────────────────────────────────
// Overlay Management
// ──────────────────────────────────────────────

let overlay: HTMLDivElement | null = null;

export function createOverlay(): void {
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.id = 'training-tool-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 10000;
    background: rgba(10, 10, 20, 0.97); color: #e0e0e0;
    display: flex; flex-direction: column; align-items: center;
    font-family: system-ui, -apple-system, sans-serif;
    overflow-y: auto;
    padding: 32px 0;
    box-sizing: border-box;
  `;
  document.body.appendChild(overlay);
}

export function removeOverlay(): void {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

export function getOverlay(): HTMLDivElement | null {
  return overlay;
}

// ──────────────────────────────────────────────
// Stage 1: Keyword Input
// ──────────────────────────────────────────────

export interface KeywordInputHandlers {
  onKeywordChange: (keyword: string) => void;
  onNext: () => void;
  onCancel: () => void;
}

export function renderKeywordInput(
  state: TrainingToolState,
  handlers: KeywordInputHandlers,
): void {
  if (!overlay) return;

  const isValid = state.keywordValid;
  const btnColor = isValid ? '#667eea' : '#333';

  overlay.innerHTML = `
    <div style="width:100%;max-width:400px;padding:24px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px;">
        <div style="font-size:22px;font-weight:700;color:#fff;">训练唤醒词</div>
        <button id="tt-cancel-btn" style="background:transparent;border:1px solid #2a2a3a;color:#666;border-radius:8px;padding:7px 14px;cursor:pointer;font-size:13px;">取消</button>
      </div>

      <div style="margin-bottom:20px;">
        <label style="display:block;font-size:13px;color:#888;margin-bottom:8px;">输入唤醒词文本</label>
        <input
          id="tt-keyword-input"
          type="text"
          value="${state.keyword}"
          placeholder="例如：小助手"
          style="width:100%;padding:14px 16px;font-size:16px;background:#111122;border:1px solid #2a2a3a;border-radius:8px;color:#fff;box-sizing:border-box;"
        />
      </div>

      <div style="font-size:12px;color:#666;margin-bottom:24px;line-height:1.6;">
        <div style="margin-bottom:4px;">• 建议 2-8 个字</div>
        <div style="margin-bottom:4px;">• 避免常见词或日常用语</div>
        <div>• 推荐使用独特的词组</div>
      </div>

      <button
        id="tt-next-btn"
        ${isValid ? '' : 'disabled'}
        style="width:100%;padding:14px;font-size:15px;font-weight:600;background:${btnColor};border:none;border-radius:8px;color:#fff;cursor:${isValid ? 'pointer' : 'not-allowed'};opacity:${isValid ? 1 : 0.5};"
      >
        下一步：采集样本
      </button>
    </div>
  `;

  document.getElementById('tt-cancel-btn')?.addEventListener('click', handlers.onCancel);
  document.getElementById('tt-next-btn')?.addEventListener('click', handlers.onNext);

  const input = document.getElementById('tt-keyword-input') as HTMLInputElement;
  input?.addEventListener('input', (e) => {
    handlers.onKeywordChange((e.target as HTMLInputElement).value);
  });
  input?.focus();
}

/**
 * Update button state without rebuilding the input field.
 * Call this when keyword changes to preserve cursor position and focus.
 */
export function updateKeywordInputButtonState(state: TrainingToolState): void {
  const nextBtn = document.getElementById('tt-next-btn') as HTMLButtonElement;
  if (!nextBtn) return;

  const isValid = state.keywordValid;
  const btnColor = isValid ? '#667eea' : '#333';

  nextBtn.disabled = !isValid;
  nextBtn.style.background = btnColor;
  nextBtn.style.cursor = isValid ? 'pointer' : 'not-allowed';
  nextBtn.style.opacity = isValid ? '1' : '0.5';
}

// ──────────────────────────────────────────────
// Stage 2: Sample Collection
// ──────────────────────────────────────────────

export interface SampleCollectionHandlers {
  onStartRecording: () => void;
  onStopRecording: () => void;
  onDeleteSample: (id: string) => void;
  onGenerateTTS: (count: number) => void;
  onBack: () => void;
  onNext: () => void;
}

export function renderSampleCollection(
  state: TrainingToolState,
  handlers: SampleCollectionHandlers,
): void {
  if (!overlay) return;

  const validCount = state.micSamples.filter(s => s.valid).length +
                     state.ttsSamples.filter(s => s.valid).length;
  const totalCount = state.targetSampleCount;
  const progress = Math.min(validCount / totalCount, 1);

  const recordBtnColor = state.recordingInProgress ? '#f44336' : '#667eea';
  const recordBtnText = state.recordingInProgress ? '停止录音' : '开始录音';

  overlay.innerHTML = `
    <div style="width:100%;max-width:500px;padding:24px;">
      <button id="tt-back-btn" style="float:left;background:transparent;border:none;color:#666;cursor:pointer;font-size:22px;padding:0;margin-bottom:8px;">←</button>
      <div style="clear:both;height:16px;"></div>

      <div style="text-align:center;margin-bottom:24px;">
        <div style="font-size:14px;color:#888;margin-bottom:4px;">唤醒词</div>
        <div style="font-size:28px;font-weight:700;color:#fff;">"${state.keyword}"</div>
      </div>

      <div style="background:#111122;border-radius:12px;padding:16px;margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <span style="font-size:13px;color:#888;">样本进度</span>
          <span style="font-size:13px;color:#667eea;">${validCount} 个</span>
        </div>
        <div style="background:#0a0a18;border-radius:4px;height:8px;overflow:hidden;">
          <div style="background:linear-gradient(90deg,#667eea,#764ba2);height:100%;width:${progress * 100}%;"></div>
        </div>
        <div style="font-size:12px;color:#666;margin-top:8px;">
          ${validCount > 0 ? `已有 ${validCount} 个样本，可直接训练` : '可直接训练，系统会自动生成 TTS 样本'}
        </div>
      </div>

      <!-- Recording Section -->
      <div style="background:#111122;border-radius:12px;padding:20px;margin-bottom:12px;">
        <div style="font-size:14px;font-weight:600;color:#e0e0e0;margin-bottom:4px;">麦克风录制</div>
        <div style="font-size:12px;color:#666;margin-bottom:16px;">录制真实语音可提高识别准确率</div>

        <div style="text-align:center;">
          <button
            id="tt-record-btn"
            style="width:70px;height:70px;border-radius:50%;border:none;background:${recordBtnColor};cursor:pointer;display:inline-flex;align-items:center;justify-content:center;box-shadow:0 0 16px rgba(102,126,234,0.3);"
          >
            <div style="width:20px;height:20px;background:#fff;border-radius:${state.recordingInProgress ? '4px' : '50%'};"></div>
          </button>
          <div style="font-size:12px;color:#888;margin-top:8px;">${recordBtnText}</div>
        </div>
      </div>

      <!-- TTS Generation Section -->
      <div style="background:#111122;border-radius:12px;padding:16px;margin-bottom:20px;">
        <div style="font-size:14px;font-weight:600;color:#e0e0e0;margin-bottom:8px;">TTS 合成</div>
        <div style="font-size:12px;color:#666;margin-bottom:12px;">使用语音合成生成训练样本</div>
        <div style="display:flex;gap:8px;">
          <button
            id="tt-tts-5-btn"
            style="flex:1;padding:10px;font-size:13px;background:transparent;border:1px solid #2a2a3a;border-radius:6px;color:#888;cursor:pointer;"
          >+5 个</button>
          <button
            id="tt-tts-10-btn"
            style="flex:1;padding:10px;font-size:13px;background:transparent;border:1px solid #2a2a3a;border-radius:6px;color:#888;cursor:pointer;"
          >+10 个</button>
          <button
            id="tt-tts-20-btn"
            style="flex:1;padding:10px;font-size:13px;background:#667eea;border:none;border-radius:6px;color:#fff;cursor:pointer;"
          >+20 个</button>
        </div>
      </div>

      <button
        id="tt-next-btn"
        style="width:100%;padding:14px;font-size:15px;font-weight:600;background:#667eea;border:none;border-radius:8px;color:#fff;cursor:pointer;"
      >
        开始训练
      </button>
    </div>
  `;

  document.getElementById('tt-back-btn')?.addEventListener('click', handlers.onBack);
  document.getElementById('tt-next-btn')?.addEventListener('click', handlers.onNext);
  document.getElementById('tt-record-btn')?.addEventListener('click', () => {
    if (state.recordingInProgress) {
      handlers.onStopRecording();
    } else {
      handlers.onStartRecording();
    }
  });
  document.getElementById('tt-tts-5-btn')?.addEventListener('click', () => handlers.onGenerateTTS(5));
  document.getElementById('tt-tts-10-btn')?.addEventListener('click', () => handlers.onGenerateTTS(10));
  document.getElementById('tt-tts-20-btn')?.addEventListener('click', () => handlers.onGenerateTTS(20));
}

// ──────────────────────────────────────────────
// Stage 3: Training
// ──────────────────────────────────────────────

export interface TrainingHandlers {
  onCancel: () => void;
}

export function renderTraining(
  state: TrainingToolState,
  handlers: TrainingHandlers,
): void {
  if (!overlay) return;

  const progress = state.trainingProgress;
  const pct = progress ? Math.round((progress.step / progress.totalSteps) * 100) : 0;

  overlay.innerHTML = `
    <div style="width:100%;max-width:400px;padding:32px;text-align:center;">
      <div style="font-size:36px;font-weight:800;color:#fff;margin-bottom:8px;">"${state.keyword}"</div>
      <div style="font-size:14px;color:#666;margin-bottom:40px;">正在训练模型...</div>

      <div style="background:#0e0e1e;border-radius:12px;padding:24px;margin-bottom:24px;">
        <div style="font-size:13px;color:#666;margin-bottom:14px;">
          ${progress?.phase === 'preparing' ? '准备训练数据...' : progress?.phase === 'exporting' ? '导出模型...' : `训练中 — 步骤 ${progress?.step || 0} / ${progress?.totalSteps || 0}`}
        </div>
        <div style="background:#0a0a18;border-radius:4px;height:6px;overflow:hidden;">
          <div style="background:linear-gradient(90deg,#667eea,#764ba2);height:100%;width:${pct}%;transition:width 0.35s ease;"></div>
        </div>
        <div style="font-size:11px;color:#333;margin-top:8px;">${pct}%</div>
      </div>

      <button
        id="tt-cancel-training-btn"
        style="background:transparent;border:1px solid #2a2a3a;color:#666;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:13px;"
      >
        取消训练
      </button>
    </div>
  `;

  document.getElementById('tt-cancel-training-btn')?.addEventListener('click', handlers.onCancel);
}

// ──────────────────────────────────────────────
// Stage 4: Validation
// ──────────────────────────────────────────────

export interface ValidationHandlers {
  onStartRealtimeTest: () => void;
  onStopRealtimeTest: () => void;
  onRunBatchTest: () => void;
  onBack: () => void;
  onNext: () => void;
}

export function renderValidation(
  state: TrainingToolState,
  handlers: ValidationHandlers,
): void {
  if (!overlay) return;

  const stats = {
    total: state.validationResults.length,
    detected: state.validationResults.filter(r => r.detected).length,
  };
  const successRate = stats.total > 0 ? stats.detected / stats.total : 0;

  // 实时测试状态
  const isTesting = state.realtimeTestingActive;
  const testBtnColor = isTesting ? '#f44336' : '#667eea';
  const testBtnText = isTesting ? '停止测试' : '开始实时测试';

  overlay.innerHTML = `
    <div style="width:100%;max-width:450px;padding:24px;">
      <button id="tt-back-btn" style="float:left;background:transparent;border:none;color:#666;cursor:pointer;font-size:22px;padding:0;margin-bottom:8px;">←</button>
      <div style="clear:both;height:16px;"></div>

      <div style="text-align:center;margin-bottom:24px;">
        <div style="font-size:28px;font-weight:700;color:#fff;">验证模型</div>
        <div style="font-size:14px;color:#888;margin-top:4px;">测试唤醒词 "${state.keyword}" 的识别效果</div>
      </div>

      ${stats.total > 0 ? `
        <div style="background:#111122;border-radius:12px;padding:20px;margin-bottom:20px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
            <span style="font-size:14px;color:#888;">成功率</span>
            <span style="font-size:18px;font-weight:700;color:${successRate >= 0.8 ? '#4CAF50' : '#f44336'};">${(successRate * 100).toFixed(0)}%</span>
          </div>
          <div style="font-size:12px;color:#666;">
            ${stats.detected} / ${stats.total} 次成功触发
          </div>
        </div>
      ` : ''}

      <!-- 实时测试 -->
      <div style="background:#111122;border-radius:12px;padding:16px;margin-bottom:12px;">
        <div style="font-size:14px;font-weight:600;color:#e0e0e0;margin-bottom:8px;">实时测试</div>
        <div style="font-size:12px;color:#666;margin-bottom:12px;">对着麦克风说唤醒词，测试识别效果</div>
        <button
          id="tt-realtime-btn"
          style="width:100%;padding:12px;font-size:14px;background:${testBtnColor};border:none;border-radius:8px;color:#fff;cursor:pointer;"
        >
          ${testBtnText}
        </button>
        ${isTesting ? `
          <div style="margin-top:12px;text-align:center;">
            <div style="font-size:13px;color:#667eea;">正在监听...</div>
            <div style="font-size:24px;margin-top:8px;">🎤</div>
            ${state.realtimeDetectionCount !== undefined ? `
              <div style="font-size:13px;color:#4CAF50;margin-top:8px;">已检测到 ${state.realtimeDetectionCount} 次</div>
            ` : ''}
          </div>
        ` : ''}
      </div>

      <button
        id="tt-batch-btn"
        style="width:100%;padding:12px;font-size:14px;background:transparent;border:1px solid #2a2a3a;border-radius:8px;color:#888;cursor:pointer;margin-bottom:12px;"
      >
        运行批量回测
      </button>

      <button
        id="tt-next-btn"
        style="width:100%;padding:14px;font-size:15px;font-weight:600;background:#667eea;border:none;border-radius:8px;color:#fff;cursor:pointer;"
      >
        下一步：安装模型
      </button>
    </div>
  `;

  document.getElementById('tt-back-btn')?.addEventListener('click', handlers.onBack);
  document.getElementById('tt-next-btn')?.addEventListener('click', handlers.onNext);
  document.getElementById('tt-batch-btn')?.addEventListener('click', handlers.onRunBatchTest);
  document.getElementById('tt-realtime-btn')?.addEventListener('click', () => {
    if (state.realtimeTestingActive) {
      handlers.onStopRealtimeTest();
    } else {
      handlers.onStartRealtimeTest();
    }
  });
}

// ──────────────────────────────────────────────
// Stage 5: Install/Export
// ──────────────────────────────────────────────

export interface InstallHandlers {
  onInstall: () => void;
  onDownload: () => void;
  onClose: () => void;
}

export function renderInstall(
  state: TrainingToolState,
  handlers: InstallHandlers,
): void {
  if (!overlay) return;

  overlay.innerHTML = `
    <div style="width:100%;max-width:400px;padding:32px;text-align:center;">
      <div style="font-size:48px;margin-bottom:16px;">✓</div>
      <div style="font-size:24px;font-weight:700;color:#fff;margin-bottom:8px;">训练完成</div>
      <div style="font-size:14px;color:#888;margin-bottom:32px;">唤醒词 "${state.keyword}" 模型已准备好</div>

      <button
        id="tt-install-btn"
        style="width:100%;padding:14px;font-size:15px;font-weight:600;background:#4CAF50;border:none;border-radius:8px;color:#fff;cursor:pointer;margin-bottom:12px;"
      >
        立即安装
      </button>

      <button
        id="tt-download-btn"
        style="width:100%;padding:14px;font-size:15px;font-weight:600;background:transparent;border:1px solid #2a2a3a;border-radius:8px;color:#888;cursor:pointer;margin-bottom:24px;"
      >
        下载模型文件
      </button>

      <button
        id="tt-close-btn"
        style="margin-top:24px;background:transparent;border:none;color:#666;cursor:pointer;font-size:14px;"
      >
        关闭
      </button>
    </div>
  `;

  document.getElementById('tt-install-btn')?.addEventListener('click', handlers.onInstall);
  document.getElementById('tt-download-btn')?.addEventListener('click', handlers.onDownload);
  document.getElementById('tt-close-btn')?.addEventListener('click', handlers.onClose);
}