// Layer 2: BotTurnState — per-bot turn lifecycle state machine
//
// idle → listening → stt → sending → awaiting → receiving → tts → speaking → idle
//
// Text input path: idle → sending → awaiting → ...
//
// Key invariant: only ONE bot can be in 'listening' (enforced by MicState singleton).
// Multiple bots can be in other non-idle states concurrently.

import { bus } from '../core/event-bus';
import { createLogger } from '../logging/logger';
import { getTurnTimeoutHints } from '../network/ws-dispatcher';

const log = createLogger('state.bot-turn');

export type BotTurnStateValue =
  | 'idle'
  | 'listening'
  | 'stt'
  | 'sending'
  | 'awaiting'
  | 'receiving'
  | 'tts'
  | 'speaking';

const ALLOWED: Record<BotTurnStateValue, readonly BotTurnStateValue[]> = {
  idle:      ['listening', 'sending'],      // listening=mic, sending=text input
  listening: ['stt', 'idle'],               // stt=recording done, idle=cancel
  stt:       ['sending', 'idle'],           // sending=transcript ready, idle=not heard
  sending:   ['awaiting', 'idle'],          // awaiting=sent, idle=failed
  awaiting:  ['receiving', 'idle'],         // receiving=first chunk, idle=timeout/cancel
  receiving: ['tts', 'speaking', 'idle'],   // tts=text→voice, speaking=audio chunk, idle=done
  tts:       ['speaking', 'idle'],          // speaking=audio ready, idle=error
  speaking:  ['idle'],                      // idle=finished/interrupted
};

function getProcessingTimeoutMs(): number {
  const hints = getTurnTimeoutHints();
  return hints.processingTimeoutMs || 180_000;
}
const SPEAKING_TIMEOUT_MS = 120_000;

const _states: Record<string, BotTurnStateValue> = {};
const _timers: Record<string, ReturnType<typeof setTimeout> | null> = {};

function _clearTimer(botId: string): void {
  if (_timers[botId]) {
    clearTimeout(_timers[botId]!);
    _timers[botId] = null;
  }
}

function _startTimer(botId: string, state: BotTurnStateValue): void {
  _clearTimer(botId);

  // Processing states share the configured timeout (includes tts to prevent stuck state)
  if (state === 'awaiting' || state === 'receiving' || state === 'stt' || state === 'sending' || state === 'tts') {
    const timeoutMs = getProcessingTimeoutMs();
    log.info('timer start', { botId, type: 'processing', timeoutMs });
    _timers[botId] = setTimeout(() => {
      if (['awaiting', 'receiving', 'stt', 'sending', 'tts'].includes(_states[botId])) {
        log.info('timer fired', { botId, type: 'processing' });
        _states[botId] = 'idle';
        bus.emit('bot:turn-state-change', { botId, from: state, to: 'idle', reason: 'timeout' });
        bus.emit('bot:processing-timeout', botId);
      }
    }, timeoutMs);
  }

  if (state === 'speaking') {
    log.info('timer start', { botId, type: 'speaking', timeoutMs: SPEAKING_TIMEOUT_MS });
    _timers[botId] = setTimeout(() => {
      if (_states[botId] === 'speaking') {
        log.info('timer fired', { botId, type: 'speaking' });
        _states[botId] = 'idle';
        bus.emit('bot:turn-state-change', { botId, from: 'speaking', to: 'idle', reason: 'timeout' });
        bus.emit('bot:speaking-timeout', botId);
      }
    }, SPEAKING_TIMEOUT_MS);
  }
}

// --- Public API ---

export const botTurnState = {
  /** Get current turn state for a bot */
  get(botId: string): BotTurnStateValue {
    return _states[botId] || 'idle';
  },

  /** Refresh the timeout timer without changing state (e.g. on each response_chunk) */
  refreshTimer(botId: string): void {
    const state = _states[botId] || 'idle';
    if (state !== 'idle') _startTimer(botId, state);
  },

  /** Transition a bot to a new turn state */
  transition(botId: string, to: BotTurnStateValue): boolean {
    const from = _states[botId] || 'idle';
    if (from === to) return true;

    if (to !== 'idle') {
      const allowed = ALLOWED[from];
      if (!allowed || !allowed.includes(to)) {
        log.warn('Blocked turn transition', { bot_id: botId, from, to });
        return false;
      }
    }

    log.info('transition', { botId, from, to });
    _states[botId] = to;
    _startTimer(botId, to);
    if (to === 'idle') _clearTimer(botId);
    bus.emit('bot:turn-state-change', { botId, from, to });
    return true;
  },

  /** Force reset to idle (always allowed) */
  resetToIdle(botId: string, reason?: string): void {
    const from = _states[botId] || 'idle';
    _states[botId] = 'idle';
    _clearTimer(botId);
    if (from !== 'idle') {
      log.info('resetToIdle', { botId, from, reason: reason || 'reset' });
      bus.emit('bot:turn-state-change', { botId, from, to: 'idle', reason: reason || 'reset' });
    }
  },

  /** Ensure state entry exists for a bot */
  ensureBot(botId: string): void {
    if (!(botId in _states)) _states[botId] = 'idle';
  },

  /** Reset all for testing */
  _reset(): void {
    for (const botId of Object.keys(_states)) {
      _clearTimer(botId);
      _states[botId] = 'idle';
    }
  },
};

// --- Cross-layer wiring: MicState → BotTurnState ---

let _micWired = false;

export function wireMicSync(): void {
  if (_micWired) return;
  _micWired = true;

  bus.on('mic:state-change', (evt: unknown) => {
    const { from, to, context, cancelled } = evt as {
      from: string; to: string;
      context: { botId: string; mode: string } | null;
      cancelled?: boolean;
    };
    if (!context) return;
    const botId = context.botId;

    // acquiring → recording: transition bot to listening
    if (to === 'recording') {
      botTurnState.transition(botId, 'listening');
    }

    // recording → stopping/saving: transition bot to stt
    if ((to === 'stopping' || to === 'saving') && from === 'recording') {
      botTurnState.transition(botId, 'stt');
    }

    // Cancel: reset bot to idle
    if (to === 'idle' && cancelled) {
      const current = botTurnState.get(botId);
      if (current === 'listening' || current === 'stt') {
        botTurnState.resetToIdle(botId, 'cancelled');
      }
    }
  });
}
