/**
 * Whisper Wake Word Detector
 *
 * 使用 Whisper encoder 作为特征提取器的唤醒词检测器。
 * 支持迁移学习训练的自定义唤醒词检测。
 *
 * 流程：
 * 1. 收集音频到 3 秒窗口
 * 2. 计算 log-mel 特征（与 Whisper 兼容）
 * 3. 运行 Whisper encoder ONNX 模型
 * 4. 运行分类头 ONNX 模型
 * 5. 输出置信度分数
 */

import { createLogger } from '../logging/logger';

const log = createLogger('whisper-detector');

// Whisper 参数
const WHISPER_SAMPLE_RATE = 16000;
const WHISPER_N_MELS = 80;
const WHISPER_N_FFT = 400;
const WHISPER_HOP_LENGTH = 160;
const WHISPER_MAX_LENGTH = 3000; // 30 秒 = 3000 帧

// 检测器配置
export interface WhisperDetectorConfig {
  encoderUrl: string;           // Whisper encoder ONNX URL
  headUrls: Record<string, string>; // keyword -> head ONNX URL
  threshold: number;            // 检测阈值
  windowMs: number;             // 音频窗口长度 (ms)
  hopMs: number;                // 滑动步长 (ms)
}

// 检测器状态
interface WhisperDetectorState {
  initialized: boolean;
  encoderSession: unknown | null;
  headSessions: Map<string, unknown>;
  audioBuffer: Float32Array[];
  bufferSize: number;
  lastProcessTime: number;
}

// 全局状态
let _state: WhisperDetectorState = {
  initialized: false,
  encoderSession: null,
  headSessions: new Map(),
  audioBuffer: [],
  bufferSize: 0,
  lastProcessTime: 0,
};

/**
 * Whisper 检测器类
 */
export class WhisperWakeWordDetector {
  private config: WhisperDetectorConfig;
  private ort: unknown;

  constructor(config: WhisperDetectorConfig) {
    this.config = config;
  }

  /**
   * 初始化检测器
   */
  async init(ort: unknown): Promise<void> {
    if (_state.initialized) {
      log.debug('Whisper detector already initialized');
      return;
    }

    this.ort = ort;
    const ortApi = ort as {
      InferenceSession: {
        create: (url: string, opts?: { executionProviders: string[] }) => Promise<unknown>;
      };
    };

    log.info('Initializing Whisper wake word detector', {
      encoderUrl: this.config.encoderUrl,
      headUrls: this.config.headUrls,
    });

    try {
      // 加载 encoder
      log.info('Loading Whisper encoder...');
      _state.encoderSession = await ortApi.InferenceSession.create(
        this.config.encoderUrl,
        { executionProviders: ['wasm'] }
      );

      // 加载分类头
      for (const [keyword, headUrl] of Object.entries(this.config.headUrls)) {
        log.info('Loading head for keyword', { keyword, headUrl });
        const headSession = await ortApi.InferenceSession.create(
          headUrl,
          { executionProviders: ['wasm'] }
        );
        _state.headSessions.set(keyword, headSession);
      }

      _state.initialized = true;
      log.info('Whisper detector initialized successfully', {
        keywords: Array.from(_state.headSessions.keys()),
      });

    } catch (error) {
      log.error('Failed to initialize Whisper detector', { error: String(error) });
      throw error;
    }
  }

  /**
   * 处理音频块
   *
   * @param chunk - 音频数据 (Float32Array, 16kHz)
   * @returns 检测结果 Map<keyword, confidence>
   */
  async processChunk(chunk: Float32Array): Promise<Map<string, number>> {
    if (!_state.initialized || !_state.encoderSession) {
      return new Map();
    }

    const results = new Map<string, number>();

    // 累积音频
    _state.audioBuffer.push(chunk);
    _state.bufferSize += chunk.length;

    // 计算窗口大小（样本数）
    const windowSamples = (this.config.windowMs / 1000) * WHISPER_SAMPLE_RATE;
    const hopSamples = (this.config.hopMs / 1000) * WHISPER_SAMPLE_RATE;
    const now = Date.now();

    // 检查是否需要处理
    if (_state.bufferSize >= windowSamples &&
        now - _state.lastProcessTime >= this.config.hopMs) {

      // 合并缓冲区
      const audio = this._mergeBuffer(windowSamples);

      // 提取特征并检测
      try {
        const features = await this._extractFeatures(audio);
        if (features) {
          // 对每个关键词运行检测
          for (const [keyword, headSession] of _state.headSessions) {
            const confidence = await this._runHead(features, headSession);
            results.set(keyword, confidence);
          }
        }
      } catch (error) {
        log.warn('Error processing audio chunk', { error: String(error) });
      }

      _state.lastProcessTime = now;

      // 滑动窗口：移除旧数据
      this._slideBuffer(hopSamples);
    }

    return results;
  }

  /**
   * 合并音频缓冲区到指定长度
   */
  private _mergeBuffer(length: number): Float32Array {
    const result = new Float32Array(length);
    let offset = 0;

    // 从缓冲区开头取足够的数据
    for (let i = 0; i < _state.audioBuffer.length && offset < length; i++) {
      const chunk = _state.audioBuffer[i];
      const toCopy = Math.min(chunk.length, length - offset);
      result.set(chunk.slice(0, toCopy), offset);
      offset += toCopy;
    }

    // 如果不足，用零填充
    if (offset < length) {
      // 已经是零初始化，无需操作
    }

    return result;
  }

  /**
   * 滑动窗口：移除指定长度的旧数据
   */
  private _slideBuffer(hopSamples: number): void {
    let remaining = hopSamples;

    while (remaining > 0 && _state.audioBuffer.length > 0) {
      const first = _state.audioBuffer[0];
      if (first.length <= remaining) {
        remaining -= first.length;
        _state.audioBuffer.shift();
      } else {
        _state.audioBuffer[0] = first.slice(remaining);
        remaining = 0;
      }
    }

    _state.bufferSize = _state.audioBuffer.reduce((sum, c) => sum + c.length, 0);
  }

  /**
   * 提取 Whisper 特征
   *
   * 注意：这里简化处理，实际应该使用 Whisper 的 mel 滤波器组。
   * 由于浏览器限制，我们使用预计算的 melspectrogram.onnx 或
   * 简化的特征提取方法。
   */
  private async _extractFeatures(audio: Float32Array): Promise<Float32Array | null> {
    const ortApi = this.ort as {
      Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
    };

    // 计算音频长度对应的帧数
    const audioLength = audio.length;
    const expectedFrames = Math.floor(audioLength / WHISPER_HOP_LENGTH);

    // 填充到 Whisper 期望的长度
    const paddedLength = WHISPER_MAX_LENGTH * WHISPER_HOP_LENGTH;
    const paddedAudio = new Float32Array(paddedLength);
    paddedAudio.set(audio.slice(0, paddedLength));

    // 计算简单的 log-mel 特征（简化版）
    // 实际实现应该使用 melspectrogram.onnx 或 Web Audio API
    const melFeatures = await this._computeMelSpectrogram(paddedAudio);

    if (!melFeatures) {
      return null;
    }

    // 运行 encoder
    const encoderInput = new ortApi.Tensor(
      'float32',
      melFeatures,
      [1, WHISPER_N_MELS, WHISPER_MAX_LENGTH]
    );

    const encoderSession = _state.encoderSession as {
      run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims: number[] }>>;
      inputNames: string[];
    };

    const inputName = encoderSession.inputNames[0];
    const encoderOut = await encoderSession.run({ [inputName]: encoderInput });

    const outputName = Object.keys(encoderOut)[0];
    const encoderFeatures = encoderOut[outputName].data;

    // 返回有效时间段的特征
    const effectiveFrames = Math.min(expectedFrames, encoderOut[outputName].dims[1]);
    const result = new Float32Array(effectiveFrames * encoderOut[outputName].dims[2]);
    result.set(encoderFeatures.slice(0, result.length));

    return result;
  }

  /**
   * 计算 mel 频谱图（与 Whisper 兼容）
   *
   * 使用 STFT + mel 滤波器组，匹配 Whisper 的预处理。
   */
  private async _computeMelSpectrogram(audio: Float32Array): Promise<Float32Array | null> {
    // Whisper mel 参数
    const nMels = 80;
    const nFft = 400;
    const hopLength = 160;
    const sampleRate = 16000;

    // 计算 STFT
    const numFrames = Math.floor((audio.length - nFft) / hopLength) + 1;
    const maxFrames = WHISPER_MAX_LENGTH;

    // 使用实际帧数，不足则填充
    const effectiveFrames = Math.min(numFrames, maxFrames);
    const melData = new Float32Array(nMels * maxFrames);

    // 计算 mel 滤波器组矩阵
    const melFilterBank = this._createMelFilterBank(nMels, nFft, sampleRate);

    // STFT 计算 - 先收集所有 log-mel 值，最后统一归一化
    const logMelValues: number[] = [];

    for (let frame = 0; frame < effectiveFrames; frame++) {
      const start = frame * hopLength;
      const windowed = this._applyHannWindow(audio.slice(start, start + nFft));

      // FFT (使用完整的复数 FFT)
      const fftResult = this._complexFFT(windowed);
      const powerSpectrum = new Float32Array(nFft / 2 + 1);
      for (let i = 0; i <= nFft / 2; i++) {
        powerSpectrum[i] = fftResult.real[i] * fftResult.real[i] + fftResult.imag[i] * fftResult.imag[i];
      }

      // 应用 mel 滤波器组
      const melEnergies = this._applyMelFilterBank(powerSpectrum, melFilterBank);

      // Log
      for (let melBin = 0; melBin < nMels; melBin++) {
        const logMel = Math.log(Math.max(melEnergies[melBin], 1e-10));
        logMelValues.push(logMel);
      }
    }

    // 计算均值和标准差（与训练时一致）
    const mean = logMelValues.reduce((a, b) => a + b, 0) / logMelValues.length;
    const variance = logMelValues.reduce((a, b) => a + (b - mean) * (b - mean), 0) / logMelValues.length;
    const std = Math.sqrt(variance) + 1e-8;

    // 归一化并存储
    for (let i = 0; i < logMelValues.length; i++) {
      const normalized = (logMelValues[i] - mean) / std;
      melData[i] = normalized;
    }

    // 形状：需要转置为 (80, 3000) - Whisper encoder 期望的格式
    const transposed = new Float32Array(nMels * maxFrames);
    for (let i = 0; i < maxFrames; i++) {
      for (let j = 0; j < nMels; j++) {
        transposed[j * maxFrames + i] = melData[i * nMels + j];
      }
    }

    return transposed;
  }

  /**
   * 创建 mel 滤波器组矩阵
   */
  private _createMelFilterBank(nMels: number, nFft: number, sampleRate: number): number[][] {
    const melMin = 0;
    const melMax = this._hzToMel(sampleRate / 2);
    const melPoints = new Float32Array(nMels + 2);
    for (let i = 0; i < nMels + 2; i++) {
      melPoints[i] = melMin + (melMax - melMin) * i / (nMels + 1);
    }

    // 转换回 Hz
    const hzPoints = melPoints.map(m => this._melToHz(m));

    // FFT 频点
    const fftFreqs = new Float32Array(nFft / 2 + 1);
    for (let i = 0; i <= nFft / 2; i++) {
      fftFreqs[i] = i * sampleRate / nFft;
    }

    // 构建滤波器组
    const filterBank: number[][] = [];
    for (let melBin = 0; melBin < nMels; melBin++) {
      const filter: number[] = new Array(nFft / 2 + 1).fill(0);
      const left = hzPoints[melBin];
      const center = hzPoints[melBin + 1];
      const right = hzPoints[melBin + 2];

      for (let fftBin = 0; fftBin <= nFft / 2; fftBin++) {
        const freq = fftFreqs[fftBin];
        if (freq >= left && freq <= center) {
          filter[fftBin] = (freq - left) / (center - left);
        } else if (freq >= center && freq <= right) {
          filter[fftBin] = (right - freq) / (right - center);
        }
      }

      // Slaney 归一化
      const enorm = 2.0 / (hzPoints[melBin + 2] - hzPoints[melBin]);
      for (let i = 0; i < filter.length; i++) {
        filter[i] *= enorm;
      }

      filterBank.push(filter);
    }

    return filterBank;
  }

  /**
   * Hz 到 Mel 转换（Slaney 公式）
   */
  private _hzToMel(hz: number): number {
    const fSp = 200.0 / 3;
    const minLogHz = 1000.0;
    const minLogMel = (minLogHz * fSp);
    const logstep = Math.log(6.4) / 27.0;

    if (hz < minLogHz) {
      return hz * fSp;
    } else {
      return minLogMel + Math.log(hz / minLogHz) / logstep;
    }
  }

  /**
   * Mel 到 Hz 转换
   */
  private _melToHz(mel: number): number {
    const fSp = 200.0 / 3;
    const minLogHz = 1000.0;
    const minLogMel = (minLogHz * fSp);
    const logstep = Math.log(6.4) / 27.0;

    if (mel < minLogMel) {
      return mel / fSp;
    } else {
      return minLogHz * Math.exp(logstep * (mel - minLogMel));
    }
  }

  /**
   * 应用 Hann 窗
   */
  private _applyHannWindow(frame: Float32Array): Float32Array {
    const n = frame.length;
    const windowed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      windowed[i] = frame[i] * 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    }
    return windowed;
  }

  /**
   * 复数 FFT（DFT 实现）
   */
  private _complexFFT(frame: Float32Array): { real: Float32Array; imag: Float32Array } {
    const n = frame.length;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);

    // DFT 实现
    for (let k = 0; k < n; k++) {
      let re = 0;
      let im = 0;
      for (let t = 0; t < n; t++) {
        const angle = 2 * Math.PI * k * t / n;
        re += frame[t] * Math.cos(angle);
        im -= frame[t] * Math.sin(angle);
      }
      real[k] = re;
      imag[k] = im;
    }

    return { real, imag };
  }

  /**
   * 实数 FFT（简化版）- 已弃用，使用 _complexFFT
   * @deprecated
   */
  private _realFFT(frame: Float32Array): Float32Array {
    const n = frame.length;
    const result = new Float32Array(n / 2 + 1);

    // 简化的 DFT 实现（仅计算实数部分）
    // 实际应该使用更高效的算法或 Web Audio API
    for (let k = 0; k <= n / 2; k++) {
      let sum = 0;
      for (let t = 0; t < n; t++) {
        sum += frame[t] * Math.cos(2 * Math.PI * k * t / n);
      }
      result[k] = sum;
    }

    return result;
  }

  /**
   * 应用 mel 滤波器组
   */
  private _applyMelFilterBank(powerSpectrum: Float32Array, filterBank: number[][]): Float32Array {
    const nMels = filterBank.length;
    const result = new Float32Array(nMels);

    for (let melBin = 0; melBin < nMels; melBin++) {
      let sum = 0;
      for (let fftBin = 0; fftBin < powerSpectrum.length; fftBin++) {
        sum += powerSpectrum[fftBin] * filterBank[melBin][fftBin];
      }
      result[melBin] = sum;
    }

    return result;
  }

  /**
   * 运行分类头
   */
  private async _runHead(features: Float32Array, headSession: unknown): Promise<number> {
    const ortApi = this.ort as {
      Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
    };

    const session = headSession as {
      run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>>;
      inputNames: string[];
    };

    // Whisper head 模型期望固定输入形状 (1, 1500, 384)
    // 需要填充或截断到 1500 帧
    const dModel = 384; // whisper-tiny
    const targetSeqLen = 1500;
    const seqLen = Math.floor(features.length / dModel);

    // 创建固定大小的输入张量
    const paddedFeatures = new Float32Array(targetSeqLen * dModel);

    // 复制有效特征
    const copyLen = Math.min(seqLen, targetSeqLen) * dModel;
    paddedFeatures.set(features.slice(0, copyLen));

    // 剩余部分保持为零填充

    const input = new ortApi.Tensor('float32', paddedFeatures, [1, targetSeqLen, dModel]);
    const inputName = session.inputNames[0];

    const output = await session.run({ [inputName]: input });
    const outputKey = Object.keys(output)[0];

    return output[outputKey].data[0];
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return _state.initialized;
  }

  /**
   * 获取支持的关键词列表
   */
  getKeywords(): string[] {
    return Array.from(_state.headSessions.keys());
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    const encoderSession = _state.encoderSession as { release?: () => Promise<void> } | null;
    if (encoderSession?.release) {
      await encoderSession.release();
    }

    for (const [, session] of _state.headSessions) {
      const headSession = session as { release?: () => Promise<void> };
      if (headSession?.release) {
        await headSession.release();
      }
    }

    _state = {
      initialized: false,
      encoderSession: null,
      headSessions: new Map(),
      audioBuffer: [],
      bufferSize: 0,
      lastProcessTime: 0,
    };

    log.info('Whisper detector disposed');
  }
}

// 单例实例
let _detector: WhisperWakeWordDetector | null = null;

/**
 * 获取 Whisper 检测器实例
 */
export function getWhisperDetector(): WhisperWakeWordDetector | null {
  return _detector;
}

/**
 * 初始化 Whisper 检测器
 */
export async function initWhisperDetector(config: WhisperDetectorConfig): Promise<WhisperWakeWordDetector> {
  if (_detector) {
    return _detector;
  }

  _detector = new WhisperWakeWordDetector(config);

  // 获取 ONNX Runtime
  const ort = (window as unknown as { ort?: unknown }).ort;
  if (!ort) {
    throw new Error('ONNX Runtime not loaded');
  }

  await _detector.init(ort);
  return _detector;
}

/**
 * 处理音频块的便捷方法
 */
export async function processWhisperChunk(chunk: Float32Array): Promise<Map<string, number>> {
  if (!_detector) {
    return new Map();
  }
  return _detector.processChunk(chunk);
}