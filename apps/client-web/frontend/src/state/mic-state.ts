// Layer 1: MicState — global singleton managing physical microphone lifecycle
//
// States: idle → acquiring → recording → stopping → idle
//                                          ↘ saving → idle
//
// Key invariant: only ONE MicState instance exists; startRecording() in non-idle
// state is rejected. Each recording carries context { botId, mode }.

import { bus } from '../core/event-bus';
import { createLogger } from '../logging/logger';

const log = createLogger('state.mic');

export type MicMode = 'ptt' | 'wakeword';
export type MicStateValue = 'idle' | 'acquiring' | 'recording' | 'stopping' | 'saving';

export interface MicContext {
  botId: string;
  mode: MicMode;
}

const ALLOWED: Record<MicStateValue, readonly MicStateValue[]> = {
  idle:      ['acquiring'],
  acquiring: ['recording', 'idle'],        // idle = failed / cancelled
  recording: ['stopping', 'idle'],         // idle = cancel
  stopping:  ['saving', 'idle'],           // idle = immediate finish
  saving:    ['idle'],
};

let _state: MicStateValue = 'idle';
let _context: MicContext | null = null;

function _transition(to: MicStateValue, ctx?: MicContext | null): boolean {
  const from = _state;
  if (from === to) return true;
  if (!ALLOWED[from].includes(to)) {
    log.warn('Blocked mic transition', { from, to });
    return false;
  }
  _state = to;
  if (ctx !== undefined) _context = ctx;
  if (to === 'idle') _context = null;
  log.info('transition', { from, to, botId: _context?.botId, mode: _context?.mode });
  bus.emit('mic:state-change', { from, to, context: _context });
  return true;
}

// --- Public API ---

export const micState = {
  /** Current mic state */
  get state(): MicStateValue { return _state; },

  /** True when mic is not idle (acquiring, recording, stopping, saving) */
  get isActive(): boolean { return _state !== 'idle'; },

  /** Context of current recording (botId + mode), null when idle */
  get context(): MicContext | null { return _context; },

  /** Mode of current recording, or null */
  getMode(): MicMode | null { return _context?.mode ?? null; },

  /**
   * Begin a new recording.
   * Rejects if mic is not idle.
   */
  startRecording(ctx: MicContext): boolean {
    if (_state !== 'idle') {
      log.warn('startRecording rejected — mic not idle', { state: _state });
      return false;
    }
    log.info('acquire', { botId: ctx.botId, mode: ctx.mode });
    return _transition('acquiring', ctx);
  },

  /** Mic stream acquired, MediaRecorder started */
  setRecording(): boolean {
    return _transition('recording');
  },

  /** MediaRecorder.stop() called */
  setStopping(): boolean {
    return _transition('stopping');
  },

  /** Processing recorded data (build blob, chunked STT) */
  setSaving(): boolean {
    return _transition('saving');
  },

  /** Recording finished or cancelled — back to idle */
  setIdle(): boolean {
    log.info('release', { from: _state, botId: _context?.botId, mode: _context?.mode });
    return _transition('idle');
  },

  /** Cancel: force back to idle from any state */
  cancelRecording(): void {
    if (_state === 'idle') return;
    const from = _state;
    _state = 'idle';
    const ctx = _context;
    _context = null;
    log.info('release', { from, botId: ctx?.botId, mode: ctx?.mode, cancelled: true });
    bus.emit('mic:state-change', { from, to: 'idle', context: ctx, cancelled: true });
  },

  /** Reset for testing */
  _reset(): void {
    _state = 'idle';
    _context = null;
  },
};
