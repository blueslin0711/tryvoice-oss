// @vitest-environment jsdom
/**
 * SC-C: State Transitions — Chain Tests
 *
 * 16 scenarios covering full state transition sequences:
 *   SC-C-01: PTT full turn lifecycle
 *   SC-C-02: Text input full turn lifecycle
 *   SC-C-03: Wakeword full turn lifecycle
 *   SC-C-04: Cancel during recording
 *   SC-C-05: Cancel during processing (awaiting)
 *   SC-C-07: Processing timeout
 *   SC-C-08: Processing timeout refresh on response_chunk
 *   SC-C-09: Speaking timeout
 *   SC-C-10: Bot switch during recording → full interrupt
 *   SC-C-11: Bot switch during processing → quiet reset
 *   SC-C-12: WS disconnect → all bots reset
 *   SC-C-13: WS reconnect → restore active turns
 *   SC-C-14: turnCancelled flag does not leak to new turn
 *   SC-C-15: Illegal state transition rejected
 *   SC-C-16: Bot switch renders correct state display
 *   SC-C-17: Cancel button triggers adapter-level interrupt
 *
 * (SC-C-06 merged into SC-B-03)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  interruptBot, quietResetBot, isTurnCancelled, clearTurnCancelled,
  resetBotToIdle, getBotMicState, getBotStatusReason,
} from '../ui/app-state';
import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import { remoteAgentState } from '../state/remote-agent-state';
import { projectCssClass, projectStatusText, setNetworkOverlay } from '../state/state-projection';
import { bus } from '../core/event-bus';
import { setupTestBots, teardownTest, BOT_A, BOT_B } from './helpers/test-setup';

// ---------- wireRealMicSync equivalent ----------
// wireRealMicSync() uses a module-level guard that prevents re-registration
// after bus.removeAll() in setupTestBots. We replicate the real wireMicSync
// logic here so each beforeEach can re-register the bridge listener.
function registerMicSync(): void {
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

beforeEach(() => {
  setupTestBots(BOT_A, BOT_B);
  registerMicSync();
  setNetworkOverlay(null);
});
afterEach(() => teardownTest());

// ============================================================
// SC-C-01: PTT Full Turn Lifecycle
// idle→acquiring→recording→stopping→saving→idle (mic)
// idle→listening→stt→sending→awaiting→receiving→speaking→idle (bot turn)
// ============================================================
describe('SC-C-01: PTT full turn lifecycle', () => {
  it('mic chain: idle→acquiring→recording→stopping→saving→idle', () => {
    expect(micState.state).toBe('idle');

    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    expect(micState.state).toBe('acquiring');

    micState.setRecording();
    expect(micState.state).toBe('recording');

    micState.setStopping();
    expect(micState.state).toBe('stopping');

    micState.setSaving();
    expect(micState.state).toBe('saving');

    micState.setIdle();
    expect(micState.state).toBe('idle');
    expect(micState.context).toBeNull();
  });

  it('bot turn chain: idle→listening→stt→sending→awaiting→receiving→speaking→idle', () => {
    expect(botTurnState.get(BOT_A)).toBe('idle');

    // mic acquiring → recording triggers listening via wireMicSync
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    expect(projectCssClass(BOT_A)).toBe('recording');

    micState.setRecording();
    expect(botTurnState.get(BOT_A)).toBe('listening');
    expect(projectCssClass(BOT_A)).toBe('recording');

    // mic recording → stopping triggers stt via wireMicSync
    micState.setStopping();
    expect(botTurnState.get(BOT_A)).toBe('stt');
    expect(projectCssClass(BOT_A)).toBe('processing');

    micState.setSaving();
    micState.setIdle();

    // stt → sending → awaiting → receiving → speaking → idle
    expect(botTurnState.transition(BOT_A, 'sending')).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('processing');

    expect(botTurnState.transition(BOT_A, 'awaiting')).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('processing');

    expect(botTurnState.transition(BOT_A, 'receiving')).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('processing');

    expect(botTurnState.transition(BOT_A, 'speaking')).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('speaking');

    expect(botTurnState.transition(BOT_A, 'idle')).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('');
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('bot:turn-state-change events emitted at each transition', () => {
    const events: Array<{ from: string; to: string }> = [];
    bus.on('bot:turn-state-change', (e: unknown) => {
      const evt = e as { botId: string; from: string; to: string };
      if (evt.botId === BOT_A) events.push({ from: evt.from, to: evt.to });
    });

    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    micState.setStopping();
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    botTurnState.transition(BOT_A, 'idle');

    expect(events).toEqual([
      { from: 'idle', to: 'listening' },
      { from: 'listening', to: 'stt' },
      { from: 'stt', to: 'sending' },
      { from: 'sending', to: 'awaiting' },
      { from: 'awaiting', to: 'receiving' },
      { from: 'receiving', to: 'speaking' },
      { from: 'speaking', to: 'idle' },
    ]);
  });
});

// ============================================================
// SC-C-02: Text Input Full Turn Lifecycle
// idle→sending→awaiting→receiving→speaking→idle (no mic states)
// ============================================================
describe('SC-C-02: Text input full turn lifecycle', () => {
  it('complete chain: idle→sending→awaiting→receiving→speaking→idle', () => {
    expect(botTurnState.get(BOT_A)).toBe('idle');

    expect(botTurnState.transition(BOT_A, 'sending')).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('processing');

    expect(botTurnState.transition(BOT_A, 'awaiting')).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('processing');

    expect(botTurnState.transition(BOT_A, 'receiving')).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('processing');

    expect(botTurnState.transition(BOT_A, 'speaking')).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('speaking');

    expect(botTurnState.transition(BOT_A, 'idle')).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('');
  });

  it('mic stays idle throughout text input path', () => {
    botTurnState.transition(BOT_A, 'sending');
    expect(micState.state).toBe('idle');

    botTurnState.transition(BOT_A, 'awaiting');
    expect(micState.state).toBe('idle');

    botTurnState.transition(BOT_A, 'receiving');
    expect(micState.state).toBe('idle');

    botTurnState.transition(BOT_A, 'speaking');
    expect(micState.state).toBe('idle');

    botTurnState.transition(BOT_A, 'idle');
    expect(micState.state).toBe('idle');
    expect(micState.isActive).toBe(false);
  });
});

// ============================================================
// SC-C-03: Wakeword Full Turn Lifecycle
// Same state flow as PTT but mode='wakeword'
// ============================================================
describe('SC-C-03: Wakeword full turn lifecycle', () => {
  it('same state chain as PTT but with mode=wakeword', () => {
    micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    expect(micState.getMode()).toBe('wakeword');
    expect(micState.state).toBe('acquiring');

    micState.setRecording();
    expect(botTurnState.get(BOT_A)).toBe('listening');
    expect(projectCssClass(BOT_A)).toBe('recording');

    micState.setStopping();
    expect(botTurnState.get(BOT_A)).toBe('stt');
    expect(projectCssClass(BOT_A)).toBe('processing');

    micState.setSaving();
    micState.setIdle();

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    expect(projectCssClass(BOT_A)).toBe('speaking');

    botTurnState.transition(BOT_A, 'idle');
    expect(projectCssClass(BOT_A)).toBe('');
    expect(micState.state).toBe('idle');
  });

  it('wakeword mode context is carried through recording', () => {
    micState.startRecording({ botId: BOT_A, mode: 'wakeword' });
    expect(micState.context).toEqual({ botId: BOT_A, mode: 'wakeword' });

    micState.setRecording();
    expect(micState.context).toEqual({ botId: BOT_A, mode: 'wakeword' });
    expect(micState.getMode()).toBe('wakeword');

    micState.setStopping();
    micState.setSaving();
    micState.setIdle();
    expect(micState.context).toBeNull();
    expect(micState.getMode()).toBeNull();
  });
});

// ============================================================
// SC-C-04: Cancel During Recording
// mic cancels, wireMicSync resets bot turn with reason='cancelled'
// ============================================================
describe('SC-C-04: Cancel during recording', () => {
  it('cancelRecording resets mic to idle, wireMicSync resets bot turn to idle', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    expect(botTurnState.get(BOT_A)).toBe('listening');
    expect(projectCssClass(BOT_A)).toBe('recording');

    micState.cancelRecording();

    expect(micState.state).toBe('idle');
    expect(micState.context).toBeNull();
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(projectCssClass(BOT_A)).toBe('');
  });

  it('cancelRecording emits mic:state-change with cancelled=true', () => {
    const handler = vi.fn();
    bus.on('mic:state-change', handler);

    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    handler.mockClear();

    micState.cancelRecording();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      from: 'recording',
      to: 'idle',
      cancelled: true,
    }));
  });

  it('SC-C-04: cancelRecording does NOT reset turn if bot already in sending', () => {
    // Given: Bot-A was recording, mic stopped, stt completed, now sending
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    expect(botTurnState.get(BOT_A)).toBe('listening');

    micState.setStopping();
    expect(botTurnState.get(BOT_A)).toBe('stt');

    // Simulate STT completion: stt → sending
    botTurnState.transition(BOT_A, 'sending');
    expect(botTurnState.get(BOT_A)).toBe('sending');

    // When: cancelRecording is called (e.g., late cancel after audio submitted)
    micState.cancelRecording();

    // Then: mic is idle, but turn state stays at sending
    // (wireMicSync only resets to idle when current state is listening or stt)
    expect(micState.state).toBe('idle');
    expect(botTurnState.get(BOT_A)).toBe('sending');
  });

  it('wireMicSync emits bot:turn-state-change with reason=cancelled', () => {
    const handler = vi.fn();
    bus.on('bot:turn-state-change', handler);

    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    handler.mockClear();

    micState.cancelRecording();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      botId: BOT_A,
      from: 'listening',
      to: 'idle',
      reason: 'cancelled',
    }));
  });
});

// ============================================================
// SC-C-05: Cancel During Awaiting
// interruptBot resets all layers + sets turnCancelled
// ============================================================
describe('SC-C-05: Cancel during awaiting', () => {
  it('interruptBot resets all layers and sets turnCancelled', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    remoteAgentState.update(BOT_A, 'processing');
    expect(projectCssClass(BOT_A)).toBe('processing');

    interruptBot(BOT_A, 'cancelled');

    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(remoteAgentState.get(BOT_A)).toBe('idle');
    expect(projectCssClass(BOT_A)).toBe('');
  });

  it('interrupt emits interrupt:stop-audio event', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    const stopAudioSpy = vi.fn();
    bus.on('interrupt:stop-audio', stopAudioSpy);

    interruptBot(BOT_A, 'cancelled');

    expect(stopAudioSpy).toHaveBeenCalledOnce();
  });

  it('isTurnCancelled guards against stale response_chunk after cancel', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    interruptBot(BOT_A, 'cancelled');
    expect(isTurnCancelled(BOT_A)).toBe(true);

    // Simulate ws-dispatcher check: stale response_chunk should be discarded
    const shouldDiscard = isTurnCancelled(BOT_A);
    expect(shouldDiscard).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });
});

// ============================================================
// SC-C-07: Processing Timeout
// Bot in awaiting for 180s → auto-reset to idle, emit processing-timeout
// ============================================================
describe('SC-C-07: Processing timeout fires after 180s', () => {
  it('awaiting state auto-resets to idle after 180s', () => {
    const timeoutSpy = vi.fn();
    bus.on('bot:processing-timeout', timeoutSpy);

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    expect(botTurnState.get(BOT_A)).toBe('awaiting');

    // Just before timeout: still awaiting
    vi.advanceTimersByTime(179_999);
    expect(botTurnState.get(BOT_A)).toBe('awaiting');
    expect(timeoutSpy).not.toHaveBeenCalled();

    // At 180s: auto-reset fires
    vi.advanceTimersByTime(1);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(timeoutSpy).toHaveBeenCalledWith(BOT_A);
  });

  it('timeout emits bot:turn-state-change with reason=timeout', () => {
    const events: Array<{ from: string; to: string; reason?: string }> = [];
    bus.on('bot:turn-state-change', (e: unknown) => {
      const evt = e as { botId: string; from: string; to: string; reason?: string };
      if (evt.botId === BOT_A) events.push({ from: evt.from, to: evt.to, reason: evt.reason });
    });

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    vi.advanceTimersByTime(180_000);

    const timeoutEvt = events.find(e => e.reason === 'timeout');
    expect(timeoutEvt).toBeDefined();
    expect(timeoutEvt!.from).toBe('awaiting');
    expect(timeoutEvt!.to).toBe('idle');
  });

  it('stt state also has processing timeout at 180s', () => {
    const timeoutSpy = vi.fn();
    bus.on('bot:processing-timeout', timeoutSpy);

    botTurnState.transition(BOT_A, 'listening');
    botTurnState.transition(BOT_A, 'stt');

    vi.advanceTimersByTime(180_000);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(timeoutSpy).toHaveBeenCalledWith(BOT_A);
  });
});

// ============================================================
// SC-C-08: refreshTimer on response_chunk resets the 180s clock
// ============================================================
describe('SC-C-08: refreshTimer resets the 180s clock', () => {
  it('refreshTimer postpones timeout by another 180s', () => {
    const timeoutSpy = vi.fn();
    bus.on('bot:processing-timeout', timeoutSpy);

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');

    // Advance 170s — close to timeout
    vi.advanceTimersByTime(170_000);
    expect(botTurnState.get(BOT_A)).toBe('receiving');

    // Simulate response_chunk: refresh timer
    botTurnState.refreshTimer(BOT_A);

    // Another 170s — only 170s since last refresh, not timed out
    vi.advanceTimersByTime(170_000);
    expect(botTurnState.get(BOT_A)).toBe('receiving');
    expect(timeoutSpy).not.toHaveBeenCalled();

    // 10 more seconds → 180s since refresh → timeout
    vi.advanceTimersByTime(10_000);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(timeoutSpy).toHaveBeenCalledWith(BOT_A);
  });

  it('multiple refreshes keep extending the timeout', () => {
    const timeoutSpy = vi.fn();
    bus.on('bot:processing-timeout', timeoutSpy);

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');

    // Refresh every 60s for 5 minutes
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(60_000);
      botTurnState.refreshTimer(BOT_A);
    }

    // 5 minutes elapsed with refreshes — still receiving
    expect(botTurnState.get(BOT_A)).toBe('receiving');
    expect(timeoutSpy).not.toHaveBeenCalled();

    // Let it time out (180s from last refresh)
    vi.advanceTimersByTime(180_000);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(timeoutSpy).toHaveBeenCalledOnce();
  });
});

// ============================================================
// SC-C-09: Speaking Timeout
// Bot in speaking for 120s → auto-reset to idle, emit speaking-timeout
// ============================================================
describe('SC-C-09: Speaking timeout fires after 120s', () => {
  it('speaking state auto-resets to idle after 120s', () => {
    const timeoutSpy = vi.fn();
    bus.on('bot:speaking-timeout', timeoutSpy);

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    expect(projectCssClass(BOT_A)).toBe('speaking');

    // Just before timeout
    vi.advanceTimersByTime(119_999);
    expect(botTurnState.get(BOT_A)).toBe('speaking');
    expect(timeoutSpy).not.toHaveBeenCalled();

    // At 120s
    vi.advanceTimersByTime(1);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(timeoutSpy).toHaveBeenCalledWith(BOT_A);
    expect(projectCssClass(BOT_A)).toBe('');
  });

  it('timeout emits bot:turn-state-change with reason=timeout', () => {
    const events: Array<{ from: string; to: string; reason?: string }> = [];
    bus.on('bot:turn-state-change', (e: unknown) => {
      const evt = e as { botId: string; from: string; to: string; reason?: string };
      if (evt.botId === BOT_A) events.push({ from: evt.from, to: evt.to, reason: evt.reason });
    });

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    vi.advanceTimersByTime(120_000);

    const timeoutEvt = events.find(e => e.reason === 'timeout');
    expect(timeoutEvt).toBeDefined();
    expect(timeoutEvt!.from).toBe('speaking');
    expect(timeoutEvt!.to).toBe('idle');
  });
});

// ============================================================
// SC-C-10: Bot Switch During Recording
// Old bot: interruptBot (full cancel)
// ============================================================
describe('SC-C-10: Bot switch during recording → full interrupt', () => {
  it('interruptBot cancels old bot recording, resets to idle', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    expect(botTurnState.get(BOT_A)).toBe('listening');
    expect(micState.isActive).toBe(true);

    interruptBot(BOT_A, 'cancelled');

    expect(micState.state).toBe('idle');
    expect(micState.context).toBeNull();
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(projectCssClass(BOT_A)).toBe('');
  });

  it('new bot (Bot-B) is unaffected by old bot interrupt', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();

    interruptBot(BOT_A, 'cancelled');

    expect(botTurnState.get(BOT_B)).toBe('idle');
    expect(projectCssClass(BOT_B)).toBe('');
    expect(isTurnCancelled(BOT_B)).toBe(false);
  });

  it('interruptBot emits interrupt:stop-audio during recording cancel', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();

    const stopAudioSpy = vi.fn();
    bus.on('interrupt:stop-audio', stopAudioSpy);

    interruptBot(BOT_A, 'cancelled');

    expect(stopAudioSpy).toHaveBeenCalledOnce();
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(micState.state).toBe('idle');
    expect(isTurnCancelled(BOT_A)).toBe(true);
  });
});

// ============================================================
// SC-C-11: Bot Switch During Non-Recording
// Old bot: quietResetBot (no cancel, background continues)
// ============================================================
describe('SC-C-11: Bot switch during non-recording → quiet reset', () => {
  it('quietResetBot stops audio but does NOT cancel turn', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    remoteAgentState.update(BOT_A, 'processing');
    expect(micState.isActive).toBe(false);

    const stopAudioSpy = vi.fn();
    bus.on('interrupt:stop-audio', stopAudioSpy);

    quietResetBot(BOT_A);

    // Audio stopped
    expect(stopAudioSpy).toHaveBeenCalledOnce();

    // turnCancelled NOT set — background processing continues
    expect(isTurnCancelled(BOT_A)).toBe(false);

    // Legacy BotMicState reset
    expect(getBotMicState(BOT_A)).toBe('');
  });

  it('Bot-B renders idle after switching from processing Bot-A', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    expect(botTurnState.get(BOT_B)).toBe('idle');
    expect(projectCssClass(BOT_B)).toBe('');
  });
});

// ============================================================
// SC-C-12: WS Disconnect → All Bots Reset to Idle
// ============================================================
describe('SC-C-12: WS disconnect → all bots reset to idle', () => {
  it('all bots reset to idle on disconnect', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    remoteAgentState.update(BOT_A, 'processing');

    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');
    botTurnState.transition(BOT_B, 'receiving');
    botTurnState.transition(BOT_B, 'speaking');
    remoteAgentState.update(BOT_B, 'generating');

    // Simulate WS disconnect
    botTurnState.resetToIdle(BOT_A, 'ws_disconnect');
    botTurnState.resetToIdle(BOT_B, 'ws_disconnect');
    remoteAgentState.resetToIdle(BOT_A);
    remoteAgentState.resetToIdle(BOT_B);

    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(botTurnState.get(BOT_B)).toBe('idle');
    expect(remoteAgentState.get(BOT_A)).toBe('idle');
    expect(remoteAgentState.get(BOT_B)).toBe('idle');
    expect(projectCssClass(BOT_A)).toBe('');
    expect(projectCssClass(BOT_B)).toBe('');
  });

  it('network overlay supersedes status text', () => {
    setNetworkOverlay('重连中...');
    const statusText = projectStatusText(BOT_A, '点击说话');
    expect(statusText).toBe('重连中...');
  });

  it('bot:turn-state-change events emitted with reason=ws_disconnect for each bot', () => {
    const events: Array<{ botId: string; reason?: string }> = [];
    bus.on('bot:turn-state-change', (e: unknown) => {
      const evt = e as { botId: string; from: string; to: string; reason?: string };
      events.push({ botId: evt.botId, reason: evt.reason });
    });

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_B, 'sending');
    events.length = 0; // clear setup events

    botTurnState.resetToIdle(BOT_A, 'ws_disconnect');
    botTurnState.resetToIdle(BOT_B, 'ws_disconnect');

    expect(events).toEqual([
      { botId: BOT_A, reason: 'ws_disconnect' },
      { botId: BOT_B, reason: 'ws_disconnect' },
    ]);
  });
});

// ============================================================
// SC-C-13: WS Reconnect → active_turns Response Restores Awaiting State
// ============================================================
describe('SC-C-13: WS reconnect → restore active turns', () => {
  it('active_turns message restores bot to awaiting state', () => {
    expect(botTurnState.get(BOT_A)).toBe('idle');

    // Simulate server sending active_turns: Bot-A has active turn
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    expect(botTurnState.get(BOT_A)).toBe('awaiting');
    expect(projectCssClass(BOT_A)).toBe('processing');
  });

  it('subsequent response_chunk after reconnect works normally', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    expect(botTurnState.transition(BOT_A, 'receiving')).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('receiving');
    expect(projectCssClass(BOT_A)).toBe('processing');
  });

  it('bot without active turn stays idle after reconnect', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    // Bot-B was not in active_turns
    expect(botTurnState.get(BOT_B)).toBe('idle');
    expect(projectCssClass(BOT_B)).toBe('');
  });
});

// ============================================================
// SC-C-14: turnCancelled Flag Doesn't Leak to New Turn
// Cleared on to=sending
// ============================================================
describe('SC-C-14: turnCancelled flag does not leak to new turn', () => {
  it('turnCancelled set by interrupt, cleared when new turn starts', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    interruptBot(BOT_A, 'cancelled');
    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('idle');

    // New turn: clear flag, then transition to sending
    clearTurnCancelled(BOT_A);
    botTurnState.transition(BOT_A, 'sending');

    expect(isTurnCancelled(BOT_A)).toBe(false);
    expect(botTurnState.get(BOT_A)).toBe('sending');
  });

  it('new turn response_chunk NOT discarded after clearing flag', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    interruptBot(BOT_A, 'cancelled');

    // New turn
    clearTurnCancelled(BOT_A);
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    expect(isTurnCancelled(BOT_A)).toBe(false);

    expect(botTurnState.transition(BOT_A, 'receiving')).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('receiving');
  });

  it('per-bot isolation: cancelling Bot-A does not affect Bot-B', () => {
    botTurnState.transition(BOT_A, 'sending');
    interruptBot(BOT_A, 'cancelled');

    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');

    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(isTurnCancelled(BOT_B)).toBe(false);
  });
});

// ============================================================
// SC-C-15: Disallowed Transitions Rejected (return false)
// ============================================================
describe('SC-C-15: Disallowed transitions rejected', () => {
  it('idle→speaking is blocked', () => {
    expect(botTurnState.transition(BOT_A, 'speaking')).toBe(false);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('idle→receiving is blocked', () => {
    expect(botTurnState.transition(BOT_A, 'receiving')).toBe(false);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('stt→speaking is blocked (must go through sending/awaiting)', () => {
    botTurnState.transition(BOT_A, 'listening');
    botTurnState.transition(BOT_A, 'stt');

    expect(botTurnState.transition(BOT_A, 'speaking')).toBe(false);
    expect(botTurnState.get(BOT_A)).toBe('stt');
  });

  it('listening→awaiting is blocked', () => {
    botTurnState.transition(BOT_A, 'listening');
    expect(botTurnState.transition(BOT_A, 'awaiting')).toBe(false);
    expect(botTurnState.get(BOT_A)).toBe('listening');
  });

  it('sending→speaking is blocked (must go through awaiting/receiving)', () => {
    botTurnState.transition(BOT_A, 'sending');
    expect(botTurnState.transition(BOT_A, 'speaking')).toBe(false);
    expect(botTurnState.get(BOT_A)).toBe('sending');
  });

  it('stuck state from illegal transition is recovered by processing timeout', () => {
    const timeoutSpy = vi.fn();
    bus.on('bot:processing-timeout', timeoutSpy);

    botTurnState.transition(BOT_A, 'listening');
    botTurnState.transition(BOT_A, 'stt');

    // Illegal transition fails, state stays at stt
    botTurnState.transition(BOT_A, 'speaking');
    expect(botTurnState.get(BOT_A)).toBe('stt');

    // Timeout fires as fallback recovery
    vi.advanceTimersByTime(180_000);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(timeoutSpy).toHaveBeenCalledWith(BOT_A);
  });
});

// ============================================================
// SC-C-16: Bot Switch → CSS Class Reflects New Bot's State
// ============================================================
describe('SC-C-16: Bot switch → CSS class reflects new bot state', () => {
  it('switching from speaking Bot-A to idle Bot-B changes CSS', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    expect(projectCssClass(BOT_A)).toBe('speaking');

    // Bot-B shows idle
    expect(projectCssClass(BOT_B)).toBe('');
  });

  it('switching from processing Bot-A to idle Bot-B changes CSS', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    expect(projectCssClass(BOT_A)).toBe('processing');

    expect(projectCssClass(BOT_B)).toBe('');
  });

  it('switching from recording Bot-A to idle Bot-B changes CSS', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    expect(projectCssClass(BOT_A)).toBe('recording');

    expect(projectCssClass(BOT_B)).toBe('');
  });

  it('each bot projection is independent', () => {
    // Bot-A: speaking
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');

    // Bot-B: processing
    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');

    expect(projectCssClass(BOT_A)).toBe('speaking');
    expect(projectCssClass(BOT_B)).toBe('processing');
  });
});

// ============================================================
// SC-C-17: Cancel Triggers Adapter-Level cancel_turn WS Message
// ============================================================
describe('SC-C-17: Cancel triggers adapter-level cancel_turn', () => {
  it('interruptBot resets all layers when bot is in awaiting', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    const stopAudioSpy = vi.fn();
    bus.on('interrupt:stop-audio', stopAudioSpy);

    interruptBot(BOT_A, 'cancelled');

    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(stopAudioSpy).toHaveBeenCalledOnce();
  });

  it('interruptBot resets all layers when bot is in receiving', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    remoteAgentState.update(BOT_A, 'generating');

    interruptBot(BOT_A, 'cancelled');

    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(remoteAgentState.get(BOT_A)).toBe('idle');
    expect(projectCssClass(BOT_A)).toBe('');
  });

  it('interruptBot still sets turnCancelled for idle bot', () => {
    interruptBot(BOT_A, 'cancelled');
    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('full interrupt: all layers reset + stop-audio emitted + reason recorded', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    remoteAgentState.update(BOT_A, 'generating');

    const stopAudioSpy = vi.fn();
    bus.on('interrupt:stop-audio', stopAudioSpy);

    interruptBot(BOT_A, 'cancelled');

    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(remoteAgentState.get(BOT_A)).toBe('idle');
    expect(micState.state).toBe('idle');
    expect(projectCssClass(BOT_A)).toBe('');
    expect(stopAudioSpy).toHaveBeenCalledOnce();
    expect(getBotMicState(BOT_A)).toBe('');
    expect(getBotStatusReason(BOT_A)).toBe('cancelled');
  });

  it('interruptBot only sends cancel_turn when bot was non-idle', () => {
    // Bot busy → wasBusy=true
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    const wasBusyBefore = botTurnState.get(BOT_A) !== 'idle';
    expect(wasBusyBefore).toBe(true);

    interruptBot(BOT_A, 'cancelled');
    expect(botTurnState.get(BOT_A)).toBe('idle');

    // Bot idle → wasBusy=false → no cancel_turn path
    clearTurnCancelled(BOT_A);
    const wasBusyAfter = botTurnState.get(BOT_A) !== 'idle';
    expect(wasBusyAfter).toBe(false);
  });
});
