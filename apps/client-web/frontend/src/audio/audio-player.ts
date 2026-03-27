// Audio playback state machine — port of audio-player.js
// idle → playing → paused → idle

import { bus } from '../core/event-bus';
import type { PlayerState } from '../core/types';

let _state: PlayerState = 'idle';
let _queue: Array<{ msgEl: HTMLElement | null; audioB64: string; text: string }> = [];
let _currentIdx = -1;
let _generation = 0;
let _currentSource: AudioBufferSourceNode | null = null;
let _audioCtx: AudioContext | null = null;
let _gainNode: GainNode | null = null;
let _analyser: AnalyserNode | null = null;
let _analyserBuf: Float32Array<ArrayBuffer> | null = null;
let _captureDestNode: MediaStreamAudioDestinationNode | null = null;
let _ttsRmsRaf: number = 0;
let _playbackStartTime = 0;   // audioCtx.currentTime when source.start() was called
let _playbackOffset = 0;      // offset into the audio buffer (seconds)
let _currentBuffer: AudioBuffer | null = null; // decoded audio buffer for resume

let _requestTTS: ((text: string, callback: (b64: string | null) => void) => void) | null = null;

// TTS failure tracking: count consecutive failures to surface feedback
let _consecutiveFailures = 0;
const TTS_FAILURE_THRESHOLD = 3;

// Prefetch: request TTS for upcoming chunks while current one plays
const PREFETCH_AHEAD = 1;
const _prefetching = new Set<number>();

function _prefetchAhead(): void {
  if (!_requestTTS || _currentIdx < 0) return;
  const gen = _generation;
  for (let i = _currentIdx + 1; i < Math.min(_currentIdx + 1 + PREFETCH_AHEAD, _queue.length); i++) {
    if (_prefetching.has(i)) continue;
    const item = _queue[i];
    if (item.audioB64 || !item.text) continue;
    _prefetching.add(i);
    _requestTTS(item.text, (b64) => {
      _prefetching.delete(i);
      if (gen !== _generation) return;
      if (b64) {
        item.audioB64 = b64;
      }
    });
  }
}

function _ensureCtx(initialVolume?: number): AudioContext {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    _gainNode = _audioCtx.createGain();
    _gainNode.gain.value = (initialVolume !== undefined ? initialVolume : 100) / 100;
    // No DynamicsCompressor — TTS services already output normalized audio.
    // A compressor caused volume pumping: loud on first chunk after silence
    // (compressor released), then quiet in steady-state (compressor engaged).
    _gainNode.connect(_audioCtx.destination);
    _analyser = _audioCtx.createAnalyser();
    _analyser.fftSize = 256;
    _analyserBuf = new Float32Array(_analyser.fftSize);
    // Keepalive silent oscillator
    const osc = _audioCtx.createOscillator();
    osc.frequency.value = 1;
    const g = _audioCtx.createGain();
    g.gain.value = 0.001;
    osc.connect(g).connect(_audioCtx.destination);
    osc.start();
  }
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume().catch((e) => {
      console.warn('[audio-player] AudioContext.resume() failed:', e);
    });
  }
  return _audioCtx;
}

function _stopCurrentSource(): void {
  if (_currentSource) {
    _currentSource.onended = null;
    try { _currentSource.stop(); } catch (_e) { /* ignore */ }
    _currentSource = null;
  }
  window.speechSynthesis?.cancel();
}

function _emit(phase: string, msgEl: HTMLElement | null, chunkText?: string): void {
  bus.emit('audio:state', { state: _state, msgEl, phase, chunkText: chunkText || '' });
}

function _normalizeBuffer(buffer: AudioBuffer): void {
  const TARGET_RMS = 0.1585;
  const SILENCE_THRESHOLD = 0.01;
  const WINDOW_SIZE = 1600;
  const MAX_GAIN = 6.0;
  const LIMITER_CEILING = 0.95;

  let totalSquared = 0;
  let activeCount = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += WINDOW_SIZE) {
      const end = Math.min(i + WINDOW_SIZE, data.length);
      let winSq = 0;
      for (let j = i; j < end; j++) winSq += data[j] * data[j];
      const winRms = Math.sqrt(winSq / (end - i));
      if (winRms > SILENCE_THRESHOLD) {
        totalSquared += winSq;
        activeCount += (end - i);
      }
    }
  }
  if (activeCount < 100) return;
  const activeRms = Math.sqrt(totalSquared / activeCount);
  if (activeRms < 0.001) return;

  let gain = TARGET_RMS / activeRms;
  if (gain > MAX_GAIN) gain = MAX_GAIN;
  if (gain < 0.1) gain = 0.1;

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      let s = data[i] * gain;
      if (s > LIMITER_CEILING) {
        s = LIMITER_CEILING + (1 - LIMITER_CEILING) * Math.tanh((s - LIMITER_CEILING) / (1 - LIMITER_CEILING));
      } else if (s < -LIMITER_CEILING) {
        s = -LIMITER_CEILING - (1 - LIMITER_CEILING) * Math.tanh((-s - LIMITER_CEILING) / (1 - LIMITER_CEILING));
      }
      data[i] = s;
    }
  }
}

async function _playB64(b64: string, onEnd: () => void, offset = 0): Promise<void> {
  try {
    const ctx = _ensureCtx();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) {
        console.warn('[audio-player] AudioContext.resume() in _playB64 failed — audio will not play:', e);
      }
    }
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    ctx.decodeAudioData(buf, (buffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(_gainNode!);
      if (_analyser) src.connect(_analyser);
      src.onended = () => { _currentSource = null; _currentBuffer = null; onEnd(); };
      _currentSource = src;
      _currentBuffer = buffer;
      _playbackOffset = offset;
      _playbackStartTime = ctx.currentTime;
      src.start(0, offset);
    }, onEnd);
  } catch (_e) { onEnd(); }
}

function _browserSpeak(text: string, onEnd: () => void): void {
  const synth = window.speechSynthesis;
  synth.cancel();
  if (!text) { onEnd(); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  u.rate = 1.05;
  u.onend = () => onEnd();
  u.onerror = () => onEnd();
  synth.speak(u);
}

function _playNext(): void {
  _currentIdx++;
  if (_currentIdx >= _queue.length) {
    _state = 'idle';
    _queue = [];
    _currentIdx = -1;
    _stopTtsRmsPump();
    _emit('end', null);
    return;
  }
  _playItem(_queue[_currentIdx]);
}

function _playItem(item: { msgEl: HTMLElement | null; audioB64: string; text: string }): void {
  const gen = _generation;
  _state = 'playing';
  _emit('start', item.msgEl, item.text);
  _startTtsRmsPump();

  const onDone = () => {
    if (gen !== _generation) return;
    _emit('itemEnd', item.msgEl, item.text);
    _playNext();
  };

  if (item.audioB64) {
    _consecutiveFailures = 0;
    _prefetchAhead();
    _playB64(item.audioB64, onDone);
  } else if (item.text) {
    if (_requestTTS) {
      _requestTTS(item.text, (b64) => {
        if (gen !== _generation) return;
        if (b64) {
          _consecutiveFailures = 0;
          item.audioB64 = b64;
          _prefetchAhead();
          _playB64(b64, onDone);
        } else {
          // TTS synthesis failed — emit failure event for UI feedback
          _consecutiveFailures++;
          bus.emit('audio:tts-failed', { element: item.msgEl });
          if (_consecutiveFailures >= TTS_FAILURE_THRESHOLD) {
            bus.emit('audio:tts-failures-exceeded');
          }
          _browserSpeak(item.text, onDone);
        }
      });
      // Prefetch subsequent chunks in parallel while waiting for current
      _prefetchAhead();
    } else {
      _browserSpeak(item.text, onDone);
    }
  } else {
    _playNext();
  }
}

function _startTtsRmsPump(): void {
  if (_ttsRmsRaf) return;
  const pump = () => {
    if (_state !== 'playing' || !_analyser || !_analyserBuf) {
      _ttsRmsRaf = 0;
      bus.emit('audio:tts-rms', 0);
      return;
    }
    _analyser.getFloatTimeDomainData(_analyserBuf);
    let sum = 0;
    for (let i = 0; i < _analyserBuf.length; i++) sum += _analyserBuf[i] * _analyserBuf[i];
    const rms = Math.sqrt(sum / _analyserBuf.length);
    bus.emit('audio:tts-rms', rms);
    _ttsRmsRaf = requestAnimationFrame(pump);
  };
  _ttsRmsRaf = requestAnimationFrame(pump);
}

function _stopTtsRmsPump(): void {
  if (_ttsRmsRaf) { cancelAnimationFrame(_ttsRmsRaf); _ttsRmsRaf = 0; }
  bus.emit('audio:tts-rms', 0);
}

export const audioPlayer = {
  init(opts: { requestTTS?: typeof _requestTTS; initialVolume?: number }): void {
    _requestTTS = opts.requestTTS || null;
    if (typeof opts.initialVolume === 'number') {
      _ensureCtx(opts.initialVolume);
    }
  },

  setVolume(v: number): void {
    if (_gainNode) _gainNode.gain.value = v / 100;
    if (!_audioCtx) _ensureCtx(v);
  },

  get state(): PlayerState { return _state; },
  get isPlaying(): boolean { return _state === 'playing'; },
  get isPaused(): boolean { return _state === 'paused'; },

  getAudioContext(): AudioContext { return _ensureCtx(); },
  getGainNode(): GainNode | null { return _gainNode; },

  getPlaybackStream(): MediaStream {
    const ctx = _ensureCtx();
    if (!_captureDestNode) {
      _captureDestNode = ctx.createMediaStreamDestination();
      _gainNode!.connect(_captureDestNode);
    }
    return _captureDestNode.stream;
  },

  enqueue(msgEl: HTMLElement | null, audioB64: string, text: string): void {
    if (_state === 'paused') return;
    _queue.push({ msgEl, audioB64: audioB64 || '', text: text || '' });
    if (_state === 'idle') {
      _currentIdx = -1;
      _playNext();
    } else if (_state === 'playing') {
      _prefetchAhead();
    }
  },

  pause(): void {
    if (_state !== 'playing') return;
    _generation++;
    // Calculate how far we played into the current buffer
    if (_audioCtx && _currentBuffer) {
      const elapsed = _audioCtx.currentTime - _playbackStartTime;
      _playbackOffset = _playbackOffset + elapsed;
      if (_playbackOffset >= _currentBuffer.duration) _playbackOffset = 0;
    }
    _stopCurrentSource();
    _state = 'paused';
    _emit('pause', _queue[_currentIdx]?.msgEl || null);
  },

  resume(): void {
    if (_state !== 'paused') return;
    if (_queue.length > 0 && _currentIdx >= 0 && _currentIdx < _queue.length) {
      const item = _queue[_currentIdx];
      const gen = ++_generation;
      _state = 'playing';
      _emit('start', item.msgEl, item.text);
      _startTtsRmsPump();
      const onDone = () => {
        if (gen !== _generation) return;
        _playbackOffset = 0;
        _emit('itemEnd', item.msgEl, item.text);
        _playNext();
      };
      if (item.audioB64 && _playbackOffset > 0) {
        _playB64(item.audioB64, onDone, _playbackOffset);
      } else if (item.audioB64) {
        _playB64(item.audioB64, onDone);
      } else if (item.text) {
        _browserSpeak(item.text, onDone);
      } else {
        onDone();
      }
    } else {
      _state = 'idle';
      _emit('end', null);
    }
  },

  stop(): void {
    _generation++;
    _stopCurrentSource();
    _playbackOffset = 0;
    _currentBuffer = null;
    _state = 'idle';
    _queue = [];
    _currentIdx = -1;
    _prefetching.clear();
    _stopTtsRmsPump();
    _emit('end', null);
  },

  cancelPlayback(): void {
    _generation++;
    _stopCurrentSource();
    _playbackOffset = 0;
    _currentBuffer = null;
    _queue = [];
    _currentIdx = -1;
    _state = 'paused';
    _prefetching.clear();
    _stopTtsRmsPump();
    _emit('end', null);
  },

  resetPause(): void {
    if (_state === 'paused') {
      this.stop();
    }
  },
};

// Stop audio on user-initiated interrupt — emit 'end' so event-wiring
// properly hides cancel button and schedules announcements.
bus.on('interrupt:stop-audio', () => {
  if (_state === 'idle') return;
  _generation++;
  _stopCurrentSource();
  _playbackOffset = 0;
  _currentBuffer = null;
  _state = 'idle';
  _queue = [];
  _currentIdx = -1;
  _prefetching.clear();
  _stopTtsRmsPump();
  _emit('end', null);
});
