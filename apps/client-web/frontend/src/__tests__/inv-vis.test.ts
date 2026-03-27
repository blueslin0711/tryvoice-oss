/**
 * INV-VIS-01~04: Visual state projection mechanism tests.
 *
 * Tests derived from EXPERIENCE_SPEC invariants (not source code).
 *
 * INV-VIS-01: projectCssClass() deterministically projects (MicState, BotTurnState) → CSS class
 * INV-VIS-02: projectStatusText() 6-level priority cascade
 * INV-VIS-03: Transient status auto-reverts after 2500ms
 * INV-VIS-04: Bot card status dot tracks per-bot reason
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupTestBots, teardownTest, BOT_A, BOT_B } from './helpers/test-setup';

import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import { remoteAgentState } from '../state/remote-agent-state';
import { projectCssClass, projectStatusText, setNetworkOverlay } from '../state/state-projection';
import {
  resetBotToIdle, getBotStatusReason, setCurrentBotId,
  setBotMicState, setInitOverlay, setServerStatusText,
} from '../ui/app-state';
import { t } from '../i18n';

beforeEach(() => setupTestBots(BOT_A, BOT_B));
afterEach(() => {
  setNetworkOverlay(null);
  setInitOverlay(null);
  setServerStatusText(BOT_A, null);
  setServerStatusText(BOT_B, null);
  teardownTest();
});

// ============================================================
// INV-VIS-01: CSS Class Deterministic Projection
// SPEC: projectCssClass(botId) deterministically derived from (MicState, BotTurnState)
// ============================================================
describe('INV-VIS-01: projectCssClass — deterministic (MicState, BotTurnState) → CSS class', () => {
  // --- recording class ---

  it('mic acquiring for this bot yields "recording"', () => {
    // SPEC: mic acquiring/recording for this bot → recording
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    expect(projectCssClass(BOT_A)).toBe('recording');
  });

  it('mic recording for this bot yields "recording"', () => {
    // SPEC: mic acquiring/recording for this bot → recording
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    expect(projectCssClass(BOT_A)).toBe('recording');
  });

  it('botTurnState=listening yields "recording"', () => {
    // SPEC: botTurnState=listening → recording
    botTurnState.transition(BOT_A, 'listening');
    expect(projectCssClass(BOT_A)).toBe('recording');
  });

  it('mic recording for a different bot does not bleed "recording" to this bot', () => {
    // SPEC: mic acquiring/recording for *this* bot — different bot should be ''
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    expect(projectCssClass(BOT_B)).toBe('');
  });

  // --- processing class ---

  it('mic stopping + active bot turn yields "processing" (bridge case)', () => {
    // SPEC: mic stopping/saving AND bot turn active → processing
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    botTurnState.transition(BOT_A, 'listening');
    micState.setStopping();
    expect(projectCssClass(BOT_A)).toBe('processing');
  });

  it('mic saving + active bot turn yields "processing"', () => {
    // SPEC: mic stopping/saving AND bot turn active → processing
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    botTurnState.transition(BOT_A, 'listening');
    micState.setStopping();
    micState.setSaving();
    expect(projectCssClass(BOT_A)).toBe('processing');
  });

  it('botTurnState=stt yields "processing"', () => {
    // SPEC: botTurnState in stt/sending/awaiting/receiving/tts → processing
    botTurnState.transition(BOT_A, 'listening');
    botTurnState.transition(BOT_A, 'stt');
    expect(projectCssClass(BOT_A)).toBe('processing');
  });

  it('botTurnState=sending yields "processing"', () => {
    // SPEC: botTurnState in stt/sending/awaiting/receiving/tts → processing
    botTurnState.transition(BOT_A, 'sending');
    expect(projectCssClass(BOT_A)).toBe('processing');
  });

  it('botTurnState=awaiting yields "processing"', () => {
    // SPEC: botTurnState in stt/sending/awaiting/receiving/tts → processing
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    expect(projectCssClass(BOT_A)).toBe('processing');
  });

  it('botTurnState=receiving yields "processing"', () => {
    // SPEC: botTurnState in stt/sending/awaiting/receiving/tts → processing
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    expect(projectCssClass(BOT_A)).toBe('processing');
  });

  it('botTurnState=tts yields "processing"', () => {
    // SPEC: botTurnState in stt/sending/awaiting/receiving/tts → processing
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'tts');
    expect(projectCssClass(BOT_A)).toBe('processing');
  });

  // --- speaking class ---

  it('botTurnState=speaking yields "speaking"', () => {
    // SPEC: botTurnState=speaking → speaking
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    expect(projectCssClass(BOT_A)).toBe('speaking');
  });

  // --- idle / empty string ---

  it('all idle yields empty string', () => {
    // SPEC: all idle → ''
    expect(projectCssClass(BOT_A)).toBe('');
    expect(projectCssClass(BOT_B)).toBe('');
  });

  it('mic stopping + idle bot turn yields "" (STT failed, not stuck in processing)', () => {
    // SPEC: mic stopping/saving with bot turn IDLE should return ''
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    botTurnState.transition(BOT_A, 'listening');
    micState.setStopping();
    // Turn resets to idle (STT failed scenario)
    botTurnState.resetToIdle(BOT_A, 'not_heard');
    expect(projectCssClass(BOT_A)).toBe('');
  });

  // --- determinism: same inputs always produce same output ---

  it('same (MicState, BotTurnState) pair always yields the same CSS class', () => {
    // SPEC: "deterministically derived"
    botTurnState.transition(BOT_A, 'sending');
    const first = projectCssClass(BOT_A);
    const second = projectCssClass(BOT_A);
    const third = projectCssClass(BOT_A);
    expect(first).toBe('processing');
    expect(second).toBe('processing');
    expect(third).toBe('processing');
  });
});

// ============================================================
// INV-VIS-02: Status Text 6-Level Priority
// SPEC: projectStatusText(botId, fallback) returns first match from P1–P6
// ============================================================
describe('INV-VIS-02: projectStatusText — 6-level priority cascade', () => {
  const FALLBACK = t('status.click_to_talk');

  // --- P1: networkOverlay overrides everything ---

  it('P1: network overlay overrides active turn state', () => {
    // SPEC: P1 networkOverlay (disconnect message) overrides everything
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    setNetworkOverlay('Reconnecting...');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe('Reconnecting...');
  });

  it('P1: network overlay overrides init overlay', () => {
    // SPEC: P1 overrides everything — including P2
    setInitOverlay('Loading wakeword...');
    setNetworkOverlay('Connection lost');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe('Connection lost');
  });

  it('P1→cleared: removing network overlay reveals underlying state', () => {
    // SPEC: P1 when cleared, next priority shows through
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    setNetworkOverlay('Disconnected');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe('Disconnected');
    setNetworkOverlay(null);
    // P3 should now show: awaiting with no agent detail → 'processing'
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.processing'));
  });

  // --- P2: initOverlay overrides turn state ---

  it('P2: init overlay overrides active turn state', () => {
    // SPEC: P2 initOverlay (wakeword loading) overrides turn state
    botTurnState.transition(BOT_A, 'listening');
    setInitOverlay('Loading wakeword...');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe('Loading wakeword...');
  });

  it('P2→cleared: removing init overlay reveals turn state', () => {
    botTurnState.transition(BOT_A, 'listening');
    setInitOverlay('Loading...');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe('Loading...');
    setInitOverlay(null);
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.listening'));
  });

  // --- P3: active turn state with L3 agent detail ---

  it('P3: listening → "listening"', () => {
    // SPEC: listening → 'listening'
    botTurnState.transition(BOT_A, 'listening');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.listening'));
  });

  it('P3: stt → "recognizing"', () => {
    // SPEC: stt → 'recognizing'
    botTurnState.transition(BOT_A, 'listening');
    botTurnState.transition(BOT_A, 'stt');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.recognizing'));
  });

  it('P3: sending → "processing"', () => {
    // SPEC: sending → 'processing'
    botTurnState.transition(BOT_A, 'sending');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.processing'));
  });

  it('P3: awaiting + agent=processing → "thinking"', () => {
    // SPEC: awaiting/receiving + agent=processing → 'thinking'
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    remoteAgentState.update(BOT_A, 'processing');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.thinking'));
  });

  it('P3: awaiting + agent=generating → "generating"', () => {
    // SPEC: awaiting/receiving + agent=generating → 'generating'
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    remoteAgentState.update(BOT_A, 'generating');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.generating'));
  });

  it('P3: awaiting + agent=queued → "processing"', () => {
    // SPEC: awaiting/receiving + agent=queued → 'processing'
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    remoteAgentState.update(BOT_A, 'queued');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.processing'));
  });

  it('P3: receiving + agent=processing → "thinking"', () => {
    // SPEC: awaiting/receiving + agent=processing → 'thinking'
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    remoteAgentState.update(BOT_A, 'processing');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.thinking'));
  });

  it('P3: receiving + agent=generating → "generating"', () => {
    // SPEC: awaiting/receiving + agent=generating → 'generating'
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    remoteAgentState.update(BOT_A, 'generating');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.generating'));
  });

  it('P3: receiving + agent=queued → "processing"', () => {
    // SPEC: awaiting/receiving + agent=queued → 'processing'
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    remoteAgentState.update(BOT_A, 'queued');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.processing'));
  });

  it('P3: tts → "generating"', () => {
    // SPEC: tts → 'generating'
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'tts');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.generating'));
  });

  it('P3: speaking → "speaking"', () => {
    // SPEC: speaking → 'speaking'
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.speaking'));
  });

  // --- P4: transient reason ---

  it('P4: idle with transient reason "cancelled" → cancelled text (before auto-revert)', () => {
    // SPEC: P4 transient reason (cancelled, not_heard, etc.) — 2.5s auto-revert
    resetBotToIdle(BOT_A, 'cancelled');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.cancelled'));
  });

  it('P4: idle with transient reason "not_heard" → not_heard text', () => {
    resetBotToIdle(BOT_A, 'not_heard');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.not_heard'));
  });

  // --- P5: server status text ---

  it('P5: server status text shows when idle with no transient reason', () => {
    // SPEC: P5 server status text
    setServerStatusText(BOT_A, 'Custom server message');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe('Custom server message');
  });

  it('P5: server status text is overridden by P3 active turn', () => {
    // P3 > P5
    setServerStatusText(BOT_A, 'Server says hello');
    botTurnState.transition(BOT_A, 'listening');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.listening'));
  });

  it('P5: server status text is overridden by P1 network overlay', () => {
    // P1 > P5
    setServerStatusText(BOT_A, 'Server says hello');
    setNetworkOverlay('Disconnected');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe('Disconnected');
  });

  // --- P6: fallback default ---

  it('P6: all idle, no overlays, no reason, no server text → fallback default', () => {
    // SPEC: P6 fallback default
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(FALLBACK);
  });

  it('P6: different fallback values are returned when nothing else matches', () => {
    const customFallback = 'Tap to speak';
    expect(projectStatusText(BOT_A, customFallback)).toBe(customFallback);
  });

  // --- Priority ordering: verify higher priority wins ---

  it('P1 > P2 > P3: all three set, P1 wins', () => {
    setNetworkOverlay('Network down');
    setInitOverlay('Loading...');
    botTurnState.transition(BOT_A, 'listening');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe('Network down');
  });

  it('P2 > P3: both set, P2 wins', () => {
    setInitOverlay('Loading...');
    botTurnState.transition(BOT_A, 'listening');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe('Loading...');
  });

  it('P3 > P4: active turn overrides transient reason', () => {
    // Set a transient reason, then activate a turn — P3 should win
    resetBotToIdle(BOT_A, 'cancelled');
    botTurnState.transition(BOT_A, 'sending');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.processing'));
  });

  // --- Per-bot isolation ---

  it('status text is per-bot: bot A active turn, bot B idle → different texts', () => {
    botTurnState.transition(BOT_A, 'listening');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.listening'));
    expect(projectStatusText(BOT_B, FALLBACK)).toBe(FALLBACK);
  });
});

// ============================================================
// INV-VIS-03: Transient Status Auto-Recover
// SPEC: Transient reasons auto-revert to 'default' after 2500ms.
//       New status cancels pending timer.
// ============================================================
describe('INV-VIS-03: transient status auto-revert after 2500ms', () => {
  const FALLBACK = t('status.click_to_talk');

  // --- Basic auto-revert ---

  it('"cancelled" reason reverts to "default" after exactly 2500ms', () => {
    // SPEC: transient reasons auto-revert to 'default' after 2500ms
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'cancelled');
    expect(getBotStatusReason(BOT_A)).toBe('cancelled');

    // Not yet reverted at 2499ms
    vi.advanceTimersByTime(2499);
    expect(getBotStatusReason(BOT_A)).toBe('cancelled');

    // Reverts at 2500ms
    vi.advanceTimersByTime(1);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('"not_heard" reason reverts to "default" after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'not_heard');
    expect(getBotStatusReason(BOT_A)).toBe('not_heard');
    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('"too_short" reason reverts to "default" after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'too_short');
    expect(getBotStatusReason(BOT_A)).toBe('too_short');
    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('"stopped_reading" reason reverts to "default" after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'stopped_reading');
    expect(getBotStatusReason(BOT_A)).toBe('stopped_reading');
    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('"echo_suspected" reason reverts to "default" after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'echo_suspected');
    expect(getBotStatusReason(BOT_A)).toBe('echo_suspected');
    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('"reset_done" reason reverts to "default" after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'reset_done');
    expect(getBotStatusReason(BOT_A)).toBe('reset_done');
    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('"reset_failed" reason reverts to "default" after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'reset_failed');
    expect(getBotStatusReason(BOT_A)).toBe('reset_failed');
    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('"reset_timeout" reason reverts to "default" after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'reset_timeout');
    expect(getBotStatusReason(BOT_A)).toBe('reset_timeout');
    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('"sync_failed" reason reverts to "default" after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'sync_failed');
    expect(getBotStatusReason(BOT_A)).toBe('sync_failed');
    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('[INV-VIS-03] "no_mic" reason reverts to "default" after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'no_mic');
    expect(getBotStatusReason(BOT_A)).toBe('no_mic');
    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('[INV-VIS-03] "mic_denied" reason reverts to "default" after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'mic_denied');
    expect(getBotStatusReason(BOT_A)).toBe('mic_denied');
    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  // --- Timer cancellation: new status cancels pending timer ---

  it('new transient reason cancels the old timer and starts a fresh 2500ms window', () => {
    // SPEC: new status cancels pending timer
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'cancelled');
    expect(getBotStatusReason(BOT_A)).toBe('cancelled');

    // After 1000ms, override with 'not_heard'
    vi.advanceTimersByTime(1000);
    resetBotToIdle(BOT_A, 'not_heard');
    expect(getBotStatusReason(BOT_A)).toBe('not_heard');

    // After old timer would have fired (1500ms more = 2500ms from first set),
    // reason should still be 'not_heard' because old timer was cancelled
    vi.advanceTimersByTime(1500);
    expect(getBotStatusReason(BOT_A)).toBe('not_heard');

    // After new timer's full 2500ms (1000ms more), it reverts
    vi.advanceTimersByTime(1000);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  it('immediate override replaces the previous reason without waiting', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'cancelled');
    expect(getBotStatusReason(BOT_A)).toBe('cancelled');
    resetBotToIdle(BOT_A, 'not_heard');
    expect(getBotStatusReason(BOT_A)).toBe('not_heard');
  });

  // --- Non-transient reason: no auto-revert ---

  it('non-transient reason "default" does not auto-revert (stays indefinitely)', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'default');
    expect(getBotStatusReason(BOT_A)).toBe('default');
    vi.advanceTimersByTime(5000);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  // --- Per-bot independence ---

  it('per-bot timers are independent: bot A and bot B revert separately', () => {
    // SPEC: per-bot status tracking
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'cancelled');
    resetBotToIdle(BOT_B, 'not_heard');
    expect(getBotStatusReason(BOT_A)).toBe('cancelled');
    expect(getBotStatusReason(BOT_B)).toBe('not_heard');

    vi.advanceTimersByTime(2500);
    expect(getBotStatusReason(BOT_A)).toBe('default');
    expect(getBotStatusReason(BOT_B)).toBe('default');
  });

  // --- Transient reason affects projectStatusText (P4) then reverts to P6 ---

  it('transient reason shows in projectStatusText, then reverts to fallback after 2500ms', () => {
    setCurrentBotId(BOT_A);
    resetBotToIdle(BOT_A, 'cancelled');
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(t('status.cancelled'));

    vi.advanceTimersByTime(2500);
    // After auto-revert, should fall through to P6 fallback
    expect(projectStatusText(BOT_A, FALLBACK)).toBe(FALLBACK);
  });
});

// ============================================================
// INV-VIS-04: Bot Card Status Light
// SPEC: Bot status dots show connection + turn state.
//       Status reason tracks per-bot (recording→'ptt', processing→'processing', idle→'default').
// ============================================================
describe('INV-VIS-04: bot card status light — per-bot reason tracking', () => {

  // --- Initial state ---

  it('idle bot has status reason "default"', () => {
    // SPEC: idle → 'default'
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  // --- Recording state ---

  it('setBotMicState recording with reason "ptt" sets reason to "ptt"', () => {
    // SPEC: recording → 'ptt'
    setBotMicState(BOT_A, 'recording', 'ptt');
    expect(getBotStatusReason(BOT_A)).toBe('ptt');
  });

  it('setBotMicState recording with reason "wakeword" sets reason to "wakeword"', () => {
    setBotMicState(BOT_A, 'recording', 'wakeword');
    expect(getBotStatusReason(BOT_A)).toBe('wakeword');
  });

  // --- Processing state ---

  it('setBotMicState processing sets reason to "processing"', () => {
    // SPEC: processing → 'processing'
    setBotMicState(BOT_A, 'recording', 'ptt');
    setBotMicState(BOT_A, 'processing', 'processing');
    expect(getBotStatusReason(BOT_A)).toBe('processing');
  });

  // --- Return to idle ---

  it('resetBotToIdle transitions reason back to "default" (after transient revert)', () => {
    // SPEC: idle → 'default'
    setBotMicState(BOT_A, 'recording', 'ptt');
    expect(getBotStatusReason(BOT_A)).toBe('ptt');
    resetBotToIdle(BOT_A);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });

  // --- Per-bot independence ---

  it('per-bot independence: different bots track different reasons simultaneously', () => {
    // SPEC: status reason tracks per-bot
    setBotMicState(BOT_A, 'recording', 'ptt');
    setBotMicState(BOT_B, 'recording', 'wakeword');
    expect(getBotStatusReason(BOT_A)).toBe('ptt');
    expect(getBotStatusReason(BOT_B)).toBe('wakeword');
  });

  it('changing one bot reason does not affect another bot', () => {
    setBotMicState(BOT_A, 'recording', 'ptt');
    setBotMicState(BOT_B, 'recording', 'wakeword');
    setBotMicState(BOT_A, 'processing', 'processing');
    expect(getBotStatusReason(BOT_A)).toBe('processing');
    expect(getBotStatusReason(BOT_B)).toBe('wakeword');
  });

  // --- Full lifecycle: recording → processing → idle ---

  it('full lifecycle: recording→processing→idle transitions reason correctly', () => {
    // SPEC: recording→'ptt', processing→'processing', idle→'default'
    expect(getBotStatusReason(BOT_A)).toBe('default');

    setBotMicState(BOT_A, 'recording', 'ptt');
    expect(getBotStatusReason(BOT_A)).toBe('ptt');

    setBotMicState(BOT_A, 'processing', 'processing');
    expect(getBotStatusReason(BOT_A)).toBe('processing');

    resetBotToIdle(BOT_A);
    expect(getBotStatusReason(BOT_A)).toBe('default');
  });
});

// ============================================================
// INV-SETTINGS-01: Settings "From Now On" Principle
// SPEC: All runtime setting changes follow "from now on" principle.
// Already-rendered content not retroactively modified. New operations use new settings.
// NOTE: Granularity-specific tests are in inv-audio.test.ts.
// ============================================================
describe('INV-SETTINGS-01: settings "from now on" — verification scenarios', () => {

  it.skip('[INV-SETTINGS-01] changing TTS voice mid-playback: current chunk uses old voice, next chunk uses new voice', () => {
    // SPEC verification #1: Change voice while reading → current chunk old voice, next chunk new voice
    // Blocked: requires AudioPlayer + real TTS provider integration
  });

  it.skip('[INV-SETTINGS-01] changing content granularity: existing intermediate cards remain, new messages filtered by new setting', () => {
    // SPEC verification #2: Change granularity with intermediate cards visible → cards stay, new arrivals filtered
    // Blocked: requires chat-renderer DOM + mergeFromServer integration
  });

  it.skip('[INV-SETTINGS-01] changing volume: currently playing audio immediately changes volume (AudioContext GainNode)', () => {
    // SPEC verification #3: Change volume → current audio volume changes immediately
    // Blocked: requires AudioContext + GainNode integration
  });

  it.skip('[INV-SETTINGS-01] changing wakeword sensitivity: next detection uses new threshold without engine restart', () => {
    // SPEC verification #4: Change sensitivity → next wakeword detection uses new threshold, engine not restarted
    // Blocked: requires wakeword engine integration
  });

  it.skip('[INV-SETTINGS-01] changing Mic AEC: current recording uninterrupted, next getUserMedia uses new constraints', () => {
    // SPEC verification #5: Toggle AEC → current recording continues, next recording has new constraint
    // Blocked: requires MediaStream + getUserMedia integration
  });
});

// ============================================================
// INV-WS-01: WS Close Resets All Bots
// SPEC: When WebSocket closes, all bots must reset to idle
// (BotTurnState and RemoteAgentState both reset).
// ============================================================
describe('INV-WS-01: WS close resets all bots to idle', () => {

  it('[INV-WS-01] all bots reset to idle BotTurnState on WS close', () => {
    // SPEC: "WebSocket 连接关闭时，所有 Bot 必须重置到 idle"
    // Put bots in active states
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_B, 'sending');

    expect(botTurnState.get(BOT_A)).toBe('awaiting');
    expect(botTurnState.get(BOT_B)).toBe('sending');

    // Simulate WS close: reset all bots
    for (const id of [BOT_A, BOT_B]) {
      botTurnState.resetToIdle(id);
      remoteAgentState.resetToIdle(id);
    }

    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(botTurnState.get(BOT_B)).toBe('idle');
  });

  it('[INV-WS-01] RemoteAgentState also resets on WS close', () => {
    // SPEC: "BotTurnState 和 RemoteAgentState 均重置"
    remoteAgentState.update(BOT_A, 'processing');
    remoteAgentState.update(BOT_B, 'generating');

    expect(remoteAgentState.get(BOT_A)).toBe('processing');
    expect(remoteAgentState.get(BOT_B)).toBe('generating');

    for (const id of [BOT_A, BOT_B]) {
      botTurnState.resetToIdle(id);
      remoteAgentState.resetToIdle(id);
    }

    expect(remoteAgentState.get(BOT_A)).toBe('idle');
    expect(remoteAgentState.get(BOT_B)).toBe('idle');
  });

  it('[INV-WS-01] CSS class returns empty after WS close reset (no stuck animation)', () => {
    // SPEC: prevents stuck processing/speaking animation
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    expect(projectCssClass(BOT_A)).toBe('processing');

    // WS close reset
    botTurnState.resetToIdle(BOT_A);
    remoteAgentState.resetToIdle(BOT_A);

    expect(projectCssClass(BOT_A)).toBe('');
  });
});

// ============================================================
// INV-WS-02: Outbox At-Least-Once Delivery
// SPEC: Messages stored in outbox (IDB) before send, retry on failure,
// survive page refresh.
// ============================================================
describe('INV-WS-02: outbox at-least-once delivery', () => {

  it.skip('[INV-WS-02] message stored in outbox before send, retried on WS disconnect, survives page refresh', () => {
    // SPEC: "用户消息必须在发送前存入 outbox（IndexedDB）。发送失败必须重试（最多 3 次）。"
    // Blocked: requires IDB + WS client integration
  });
});

// ============================================================
// INV-WS-03: Server Dedup by (msgType, botId, msgId)
// SPEC: Server deduplicates by (msgType, botId, msgId) with TTL.
// ============================================================
describe('INV-WS-03: server dedup by (msgType, botId, msgId)', () => {

  it.skip('[INV-WS-03] sending same msgId twice results in server processing only once', () => {
    // SPEC: "服务端必须按 (msgType, botId, msgId) 带 TTL 去重"
    // Blocked: requires backend integration test
  });
});

// ============================================================
// INV-WS-04: Server-Generated Messages Pushed to Connected Clients
// SPEC: Adapter-produced assistant messages pushed via message_sync WS message.
// SessionWatcher monitors JSONL + CoalescingSync.
// ============================================================
describe('INV-WS-04: server-generated messages pushed to connected clients', () => {

  it.skip('[INV-WS-04] agent output in tmux triggers message_sync to web client within 2s', () => {
    // SPEC verification #1: Bot completes turn, agent continues output → web receives message_sync within 2s
    // Blocked: requires backend SessionWatcher + WS integration
  });

  it.skip('[INV-WS-04] WS reconnect triggers sync that backfills missed messages', () => {
    // SPEC verification #2: WS reconnect → sync path backfills all missed messages
    // Blocked: requires WS lifecycle + sync integration
  });
});

// ============================================================
// SG-G: Scroll & Rendering (P2) — Playwright E2E
// SPEC: All SC-G scenarios require Playwright E2E automation.
// ============================================================
describe('SG-G: scroll & rendering scenarios', () => {

  it.skip('[SC-G-01] switch bot with no unread → scrolls to bottom, scroll position not preserved across bot switches', () => {
    // SPEC: Bot-A scrolled up, switch to Bot-B (no unread) → scroll to bottom.
    //       Switch back to Bot-A → also starts from bottom (position not preserved).
    // Blocked: requires Playwright E2E (DOM scroll position)
  });

  it.skip('[SC-G-02] page refresh with no unread → scroll to bottom, auto-scroll until user scrolls up', () => {
    // SPEC: F5 refresh → no unread → scroll to bottom (INV-SWITCH-04).
    //       New messages auto-scroll (AUTO mode). User scrolls up → MANUAL mode.
    //       30s no scroll → back to AUTO.
    // Blocked: requires Playwright E2E (scroll events + timers)
  });

  it.skip('[SC-G-03] streaming response in AUTO mode → auto-scroll to keep latest content visible', () => {
    // SPEC: Agent streams response → ResizeObserver + MutationObserver detect DOM changes
    //       → _scrollToBottom() in AUTO mode. Smooth, no jumping.
    // Blocked: requires Playwright E2E (ResizeObserver + streaming)
  });

  it.skip('[SC-G-04] user scrolls up → MANUAL mode → 30s timeout → back to AUTO', () => {
    // SPEC: User scrolls up → MANUAL mode → no auto-scroll.
    //       #scroll-bottom-fab appears. 30s no interaction → AUTO restored.
    //       Or user clicks #scroll-ownership-indicator → immediate AUTO + scroll to bottom.
    // Blocked: requires Playwright E2E (scroll tracking + timer)
  });

  it.skip('[SC-G-05] bfcache restore → resetScrollSession → AUTO mode', () => {
    // SPEC: pageshow event with persisted=true → resetScrollSession()
    //       → AUTO mode → position based on unread state (INV-SWITCH-04).
    // Blocked: requires Playwright E2E (bfcache simulation)
  });
});

// ============================================================
// ISSUE-20: Bot switch scroll position restore (regression)
// SPEC: "switchToBot() saves scrollTop before switching away,
// restores after rendering the new bot's chat."
// Status: FIXED. Same fix as ISSUE-11b.
// BLOCKED: requires Playwright E2E (real scroll layout).
// ============================================================
it.skip('ISSUE-20: bot switch restores scroll position — BLOCKED (requires Playwright E2E with real layout)', () => {
  // SPEC: PI-02 — "each Bot independently maintains scroll position,
  //       switch away and back should restore to the position when left."
  // Cannot test in jsdom: scrollTop/scrollHeight/clientHeight are all 0.
});

// ============================================================
// ISSUE-21: Bot tab drag reorder (regression)
// SPEC: "slot-tabs.ts implements draggable=true, dragstart/dragover/drop
// events, _reorderBot(), _syncSlotOrder() persists to backend."
// Status: FIXED.
// BLOCKED: requires Playwright E2E (real drag events).
// ============================================================
it.skip('ISSUE-21: bot tab drag reorder — BLOCKED (requires Playwright E2E with real drag events)', () => {
  // SPEC: PI-29 — "user can drag Bot tabs to reorder, order persists after refresh."
  // jsdom does not support real DragEvent / DataTransfer.
});

// ============================================================
// ISSUE-23: Page load scroll to bottom (regression)
// SPEC: "chat-renderer.ts initChatRenderer() — ResizeObserver +
// MutationObserver combo auto-scrolls to bottom when scrollHeight
// grows and user hasn't manually scrolled."
// Status: FIXED.
// BLOCKED: requires Playwright E2E (real layout rendering).
// ============================================================
it.skip('ISSUE-23: page load #transcript at bottom — BLOCKED (requires Playwright E2E with real layout)', () => {
  // SPEC: SC-G-02 — "page refresh → chat scrolls to bottom."
  // jsdom has no layout engine; scrollTop/scrollHeight always 0.
});
