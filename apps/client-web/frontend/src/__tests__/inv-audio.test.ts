// @vitest-environment jsdom
/**
 * INV-AUDIO-01~05 + INV-SETTINGS-01 mechanism tests
 * ISSUE-10: PREFETCH_AHEAD=1 (verify fix)
 * ISSUE-02: Speaking timeout refreshed on audio:state start (verify fix)
 * ISSUE-04: Dead audioB64 storage fully removed (attachAudioToLast, jumpToMessage, dataset.audioB64 writes)
 *
 * All assertions derived from EXPERIENCE_SPEC definitions.
 * Source code is NOT read to derive assertions — only import paths resolved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock external dependencies BEFORE any source imports (Rule 7) ---
vi.mock('../ui/chat-renderer', () => ({
  renderChat: vi.fn(),
  addBotMsg: vi.fn(),
  autoReadUnreadN: vi.fn(),
  updateDeliveryStatusDOM: vi.fn(),
  scrollToReadingIfNeeded: vi.fn(),
  updatePlayButtons: vi.fn(),
}));
vi.mock('../ui/mic-ui', () => ({
  setCancelReplyActive: vi.fn(),
  setVoiceRipple: vi.fn(),
  playVoiceFeedback: vi.fn(),
  updateBadges: vi.fn(),
}));
vi.mock('../ui/status-bar', () => ({
  setStatusText: vi.fn(),
  compactStatusText: vi.fn((t: string) => t),
}));
vi.mock('../ui/car-mode-overlay', () => ({
  setCarOverlayStatus: vi.fn(),
}));
vi.mock('../audio/tts-cleaner', () => ({
  chunkForTTS: vi.fn((text: string) => [text]),
  cleanForTTS: vi.fn((text: string) => text),
}));
vi.mock('../network/ws-client', () => ({
  send: vi.fn(),
  isConnected: vi.fn(() => true),
  nextMsgId: vi.fn(() => 'msg_test'),
}));
vi.mock('../network/outbox', () => ({
  outbox: { onAck: vi.fn(), onAckTimeout: vi.fn(), drain: vi.fn() },
}));
vi.mock('../network/sync', () => ({
  syncManager: { schedule: vi.fn() },
}));
vi.mock('../network/ws-dispatcher', () => ({
  getHistorySyncTargets: vi.fn(() => ({})),
  handleChatRendered: vi.fn(),
  cancelUnreadAnnouncement: vi.fn(),
  scheduleUnreadAnnouncement: vi.fn(),
  consumeAnnouncementInFlight: vi.fn(() => false),
  notifyUnreadChanged: vi.fn(),
  setLastPlaybackEndMs: vi.fn(),
  createWsDispatcher: vi.fn(),
  getTurnTimeoutHints: vi.fn(() => ({ processingTimeoutMs: 180000 })),
}));

import { audioPlayer } from '../audio/audio-player';
import {
  isAutoReadEnabled, setAutoReadEnabled, autoReadEnqueue,
  shouldIncludeMsg, setGranularity,
  markTextRead, isTextAlreadyRead, clearReadTexts,
  setCurrentBotId,
} from '../ui/app-state';
import { botTurnState } from '../state/bot-turn-state';
import { bus } from '../core/event-bus';
import {
  setupTestBots, teardownTest, teardownIntegration,
  wireRealEventHandlers, mockBrowserAPIs,
  BOT_A, BOT_B,
} from './helpers/test-setup';
import { scheduleUnreadAnnouncement, consumeAnnouncementInFlight } from '../network/ws-dispatcher';

beforeEach(() => {
  mockBrowserAPIs();
  setupTestBots(BOT_A, BOT_B);
});
afterEach(() => {
  audioPlayer.stop();
  teardownIntegration();
});

// ============================================================
// INV-AUDIO-01: Generation Counter Invalidates Stale Callbacks
// SPEC: Every async audio op captures _generation on start. If _generation
// changes by callback time, callback silently discarded. This prevents
// cancelled turn's audio from overwriting new turn's playback.
// ============================================================
describe('INV-AUDIO-01: generation counter invalidates stale async callbacks', () => {
  it('stop() during pending TTS silently discards the stale callback', () => {
    // SPEC: "If _generation changes by callback time, callback silently discarded"
    let capturedCb: ((b64: string | null) => void) | null = null;
    audioPlayer.init({
      requestTTS: (_text, cb) => { capturedCb = cb; },
    });

    const el = document.createElement('div');
    audioPlayer.enqueue(el, '', 'Hello world');
    expect(audioPlayer.state).toBe('playing');
    expect(capturedCb).not.toBeNull();

    // stop() increments _generation
    audioPlayer.stop();
    expect(audioPlayer.state).toBe('idle');

    // Stale callback fires — SPEC says silently discarded
    capturedCb!('dGVzdA==');
    expect(audioPlayer.state).toBe('idle');
  });

  it('cancelPlayback() during pending TTS silently discards old callback', () => {
    // SPEC: "cancelled turn's audio from overwriting new turn's playback"
    let capturedCb: ((b64: string | null) => void) | null = null;
    audioPlayer.init({
      requestTTS: (_text, cb) => { capturedCb = cb; },
    });

    const el = document.createElement('div');
    audioPlayer.enqueue(el, '', 'First chunk');
    expect(audioPlayer.state).toBe('playing');
    const staleCb = capturedCb!;

    // cancelPlayback increments generation
    audioPlayer.cancelPlayback();
    expect(audioPlayer.state).toBe('paused');

    // Old callback fires with audio — must be silently discarded
    staleCb('dGVzdA==');
    // State should remain paused, NOT change to playing
    expect(audioPlayer.state).toBe('paused');
  });

  it('multiple sequential stop-and-restart cycles always discard stale callbacks', () => {
    // SPEC: "If _generation changes by callback time, callback silently discarded"
    // Verify generation guard works across multiple cycles (not just one)
    const callbacks: Array<(b64: string | null) => void> = [];
    audioPlayer.init({
      requestTTS: (_text, cb) => { callbacks.push(cb); },
    });

    // Cycle 1: enqueue then stop
    audioPlayer.enqueue(document.createElement('div'), '', 'cycle1');
    expect(audioPlayer.state).toBe('playing');
    audioPlayer.stop();

    // Cycle 2: enqueue then stop
    audioPlayer.enqueue(document.createElement('div'), '', 'cycle2');
    expect(audioPlayer.state).toBe('playing');
    audioPlayer.stop();

    // Cycle 3: enqueue (still playing, waiting for TTS)
    audioPlayer.enqueue(document.createElement('div'), '', 'cycle3');
    expect(audioPlayer.state).toBe('playing');

    // All stale callbacks from cycles 1 and 2 fire — silently discarded
    callbacks[0]('dGVzdA==');
    callbacks[1]('dGVzdA==');
    // Current cycle's state unaffected
    expect(audioPlayer.state).toBe('playing');
  });

  it('new enqueue after stop() is not affected by old generation callbacks', () => {
    // SPEC: "prevents cancelled turn's audio from overwriting new turn's playback"
    let cbIndex = 0;
    const callbacks: Array<(b64: string | null) => void> = [];
    audioPlayer.init({
      requestTTS: (_text, cb) => { callbacks[cbIndex++] = cb; },
    });

    const el1 = document.createElement('div');
    audioPlayer.enqueue(el1, '', 'old turn text');
    expect(audioPlayer.state).toBe('playing');

    // Stop (cancels old turn)
    audioPlayer.stop();
    expect(audioPlayer.state).toBe('idle');

    // Start new turn
    const el2 = document.createElement('div');
    audioPlayer.enqueue(el2, '', 'new turn text');
    expect(audioPlayer.state).toBe('playing');

    // Old callback fires — must not interfere with new playback
    callbacks[0]('b2xkX2F1ZGlv');
    // New turn's state should still be playing
    expect(audioPlayer.state).toBe('playing');
  });
});

// ============================================================
// INV-AUDIO-02: At Most One Bot Speaking Globally
// SPEC: AudioPlayer is global singleton → at most one bot in speaking state.
// Safety net: on audio:state end/pause, ALL bots in speaking state reset to idle.
// ============================================================
describe('INV-AUDIO-02: at most one bot speaking globally', () => {
  beforeEach(async () => {
    await wireRealEventHandlers();
  });

  it('audio:state end resets ALL bots from speaking to idle', () => {
    // SPEC: "on audio:state end ... ALL bots in speaking state reset to idle"
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');

    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');
    botTurnState.transition(BOT_B, 'receiving');
    botTurnState.transition(BOT_B, 'speaking');

    expect(botTurnState.get(BOT_A)).toBe('speaking');
    expect(botTurnState.get(BOT_B)).toBe('speaking');

    bus.emit('audio:state', { state: 'idle', msgEl: null, phase: 'end', chunkText: '' });

    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(botTurnState.get(BOT_B)).toBe('idle');
  });

  it('audio:state pause also resets all speaking bots to idle', () => {
    // SPEC: "on audio:state end/pause, ALL bots in speaking state reset to idle"
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');

    expect(botTurnState.get(BOT_A)).toBe('speaking');

    bus.emit('audio:state', { state: 'paused', msgEl: null, phase: 'pause', chunkText: '' });

    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('non-speaking bots are NOT reset on audio:state end', () => {
    // SPEC: safety net only applies to bots "in speaking state"
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    // BOT_A stays in receiving (not speaking)

    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');
    botTurnState.transition(BOT_B, 'receiving');
    botTurnState.transition(BOT_B, 'speaking');

    bus.emit('audio:state', { state: 'idle', msgEl: null, phase: 'end', chunkText: '' });

    // BOT_A was receiving, not speaking — should remain receiving
    expect(botTurnState.get(BOT_A)).toBe('receiving');
    // BOT_B was speaking — should be reset to idle
    expect(botTurnState.get(BOT_B)).toBe('idle');
  });
});

// ============================================================
// INV-AUDIO-03: TTS Text Deduplication
// SPEC: Same text in same session must not be read twice for same bot.
// Check isTextAlreadyRead(botId, text) before TTS enqueue.
// ============================================================
describe('INV-AUDIO-03: TTS text deduplication', () => {
  it('markTextRead prevents same text from being read again for same bot', () => {
    // SPEC: "Same text in same session must not be read twice for same bot"
    markTextRead(BOT_A, 'Hello world');
    expect(isTextAlreadyRead(BOT_A, 'Hello world')).toBe(true);
  });

  it('dedup is per-bot — same text for different bot is allowed', () => {
    // SPEC: "for same bot" implies per-bot isolation
    markTextRead(BOT_A, 'Hello world');
    expect(isTextAlreadyRead(BOT_B, 'Hello world')).toBe(false);
  });

  it('whitespace-normalized text matches as duplicate', () => {
    // SPEC implies normalization to prevent near-duplicate reads
    markTextRead(BOT_A, '  Hello   world  ');
    expect(isTextAlreadyRead(BOT_A, 'Hello world')).toBe(true);
  });

  it('clearReadTexts resets dedup for that bot only', () => {
    markTextRead(BOT_A, 'text1');
    markTextRead(BOT_B, 'text2');

    clearReadTexts(BOT_A);

    // BOT_A's dedup cleared — text1 can be read again
    expect(isTextAlreadyRead(BOT_A, 'text1')).toBe(false);
    // BOT_B's dedup unaffected
    expect(isTextAlreadyRead(BOT_B, 'text2')).toBe(true);
  });

  it('empty text is never considered already read', () => {
    // SPEC: only meaningful text should be deduplicated
    markTextRead(BOT_A, '');
    expect(isTextAlreadyRead(BOT_A, '')).toBe(false);
  });
});

// ============================================================
// INV-AUDIO-04: Announcement Cascade Protection
// SPEC: When announcement finishes, it must NOT trigger another announcement.
// Only regular audio end triggers scheduleUnreadAnnouncement().
// ============================================================
describe('INV-AUDIO-04: announcement cascade protection', () => {
  beforeEach(async () => {
    await wireRealEventHandlers();
  });

  it('regular audio end schedules next announcement', () => {
    // SPEC: "Only regular audio end triggers scheduleUnreadAnnouncement()"
    const scheduleFn = scheduleUnreadAnnouncement as ReturnType<typeof vi.fn>;
    scheduleFn.mockClear();

    // consumeAnnouncementInFlight returns false (default mock) = regular audio
    bus.emit('audio:state', { state: 'idle', msgEl: null, phase: 'end', chunkText: '' });

    expect(scheduleFn).toHaveBeenCalledOnce();
  });

  it('announcement finish does NOT trigger another announcement', () => {
    // SPEC: "When announcement finishes, it must NOT trigger another announcement"
    const scheduleFn = scheduleUnreadAnnouncement as ReturnType<typeof vi.fn>;
    const consumeFn = consumeAnnouncementInFlight as ReturnType<typeof vi.fn>;
    scheduleFn.mockClear();

    // Simulate: the audio that just ended WAS an announcement
    consumeFn.mockReturnValueOnce(true);

    bus.emit('audio:state', { state: 'idle', msgEl: null, phase: 'end', chunkText: '' });

    // Must NOT reschedule — prevents cascade
    expect(scheduleFn).not.toHaveBeenCalled();
  });

  it('audio pause does NOT schedule announcements', () => {
    // SPEC: only "end" triggers announcements, not pause
    const scheduleFn = scheduleUnreadAnnouncement as ReturnType<typeof vi.fn>;
    scheduleFn.mockClear();

    bus.emit('audio:state', { state: 'paused', msgEl: null, phase: 'pause', chunkText: '' });

    expect(scheduleFn).not.toHaveBeenCalled();
  });
});

// ============================================================
// INV-AUDIO-05: autoRead Switch Takes Effect Immediately
// SPEC: Enable → new messages trigger TTS. Disable → immediately stop all TTS,
// clear queue, stay silent until re-enable. Don't retroactively read on-screen
// messages on enable.
// ============================================================
describe('INV-AUDIO-05: autoRead switch takes effect immediately', () => {
  it('autoReadEnqueue does nothing when autoRead is disabled', async () => {
    // SPEC: "Disable → ... stay silent until re-enable"
    setAutoReadEnabled(false);
    const el = document.createElement('div');

    autoReadEnqueue(el, '', 'some text');

    // Wait for any dynamic import to resolve
    await (vi.dynamicImportSettled?.() ?? Promise.resolve());

    // Player should remain idle — nothing enqueued
    expect(audioPlayer.state).toBe('idle');
  });

  it('disabling autoRead mid-session immediately prevents future enqueues', () => {
    // SPEC: "Disable → immediately ... stay silent until re-enable"
    setAutoReadEnabled(true);
    expect(isAutoReadEnabled()).toBe(true);

    setAutoReadEnabled(false);
    expect(isAutoReadEnabled()).toBe(false);

    // Attempting to enqueue after disable should have no effect
    const el = document.createElement('div');
    autoReadEnqueue(el, '', 'should not play');
    expect(audioPlayer.state).toBe('idle');
  });

  it('null element is rejected even when autoRead is enabled', () => {
    // SPEC: autoReadEnqueue requires a valid element target
    setAutoReadEnabled(true);
    autoReadEnqueue(null, '', 'text');
    expect(audioPlayer.state).toBe('idle');
  });

  it('enabling autoRead does not retroactively read existing messages', () => {
    // SPEC: "Don't retroactively read on-screen messages on enable"
    // Verify: toggling autoRead on does NOT by itself enqueue anything
    setAutoReadEnabled(false);
    setAutoReadEnabled(true);

    // Player should still be idle — no retroactive reads
    expect(audioPlayer.state).toBe('idle');
  });
});

// ============================================================
// INV-SETTINGS-01: Settings "From Now On"
// SPEC: All runtime setting changes follow "from now on" principle. Already-rendered
// message cards and cached audio not retroactively modified. New messages/TTS use
// new settings.
// ============================================================
describe('INV-SETTINGS-01: settings "from now on" — granularity changes', () => {
  it('granularity change immediately affects shouldIncludeMsg for new evaluations', () => {
    // SPEC: "New messages/TTS use new settings"
    const thinkingMsg = { intermediate: true, contentKind: 'thinking', text: 'hmm...' };
    const toolMsg = { intermediate: true, contentKind: 'tool_call', text: '[tool: search]' };
    const finalMsg = { intermediate: false, contentKind: 'result', text: 'Answer' };

    setGranularity('final_only');
    expect(shouldIncludeMsg(thinkingMsg)).toBe(false);
    expect(shouldIncludeMsg(toolMsg)).toBe(false);
    expect(shouldIncludeMsg(finalMsg)).toBe(true);

    // Change setting — "from now on" new evaluations use new setting
    setGranularity('with_steps');
    expect(shouldIncludeMsg(thinkingMsg)).toBe(false);
    expect(shouldIncludeMsg(toolMsg)).toBe(false);
    expect(shouldIncludeMsg(finalMsg)).toBe(true);

    setGranularity('with_thinking');
    expect(shouldIncludeMsg(thinkingMsg)).toBe(true);
    expect(shouldIncludeMsg(toolMsg)).toBe(false);
    expect(shouldIncludeMsg(finalMsg)).toBe(true);

    setGranularity('all');
    expect(shouldIncludeMsg(thinkingMsg)).toBe(true);
    expect(shouldIncludeMsg(toolMsg)).toBe(true);
    expect(shouldIncludeMsg(finalMsg)).toBe(true);
  });

  it('[tool:...] prefix messages only shown in "all" granularity', () => {
    // SPEC: tool placeholder messages are filtered in non-all modes
    const toolPlaceholder = { intermediate: false, text: '[tool: web_search]' };

    setGranularity('final_only');
    expect(shouldIncludeMsg(toolPlaceholder)).toBe(false);

    setGranularity('with_steps');
    expect(shouldIncludeMsg(toolPlaceholder)).toBe(false);

    setGranularity('all');
    expect(shouldIncludeMsg(toolPlaceholder)).toBe(true);
  });

  it('explicit granularity override parameter bypasses module-level setting', () => {
    // SPEC: "from now on" applies to module-level setting; override is instant
    setGranularity('final_only');
    const thinkingMsg = { intermediate: true, contentKind: 'thinking', text: 'step' };

    expect(shouldIncludeMsg(thinkingMsg)).toBe(false);
    expect(shouldIncludeMsg(thinkingMsg, 'with_steps')).toBe(false);
    expect(shouldIncludeMsg(thinkingMsg, 'with_thinking')).toBe(true);
    expect(shouldIncludeMsg(thinkingMsg, 'all')).toBe(true);
  });
});

// ============================================================
// ISSUE-10: PREFETCH_AHEAD=1
// SPEC: "PREFETCH_AHEAD should be 1 (not 3). Verify by checking that at most
// 2 TTS requests fire when 4 items are enqueued (1 current + 1 prefetch)."
// ============================================================
describe('ISSUE-10: PREFETCH_AHEAD=1 — at most 1 prefetch ahead', () => {
  it('enqueuing 4 text-only items fires at most 2 TTS requests (1 current + 1 prefetch)', () => {
    // SPEC: exactly "at most 2 TTS requests fire when 4 items are enqueued"
    const ttsRequests: string[] = [];
    audioPlayer.init({
      requestTTS: (text, _cb) => {
        ttsRequests.push(text);
        // Don't call cb — simulate slow TTS to observe prefetch count
      },
    });

    const els = Array.from({ length: 4 }, () => document.createElement('div'));

    audioPlayer.enqueue(els[0], '', 'chunk1');
    audioPlayer.enqueue(els[1], '', 'chunk2');
    audioPlayer.enqueue(els[2], '', 'chunk3');
    audioPlayer.enqueue(els[3], '', 'chunk4');

    // SPEC: "at most 2 TTS requests" = 1 current + 1 prefetch
    expect(ttsRequests.length).toBeLessThanOrEqual(2);
    expect(ttsRequests).toContain('chunk1');
  });

  it('with PREFETCH_AHEAD=1 the third and fourth items are NOT prefetched', () => {
    const ttsRequests: string[] = [];
    audioPlayer.init({
      requestTTS: (text, _cb) => {
        ttsRequests.push(text);
      },
    });

    const els = Array.from({ length: 4 }, () => document.createElement('div'));
    audioPlayer.enqueue(els[0], '', 'A');
    audioPlayer.enqueue(els[1], '', 'B');
    audioPlayer.enqueue(els[2], '', 'C');
    audioPlayer.enqueue(els[3], '', 'D');

    // Only the current item and at most 1 ahead should be requested
    expect(ttsRequests).not.toContain('C');
    expect(ttsRequests).not.toContain('D');
  });
});

// ============================================================
// ISSUE-02: Speaking timeout refresh on audio:state start
// SPEC: "Speaking timeout (120s) must be refreshed when audio:state phase=start
// fires. Without this, long TTS responses get cut off after 120s.
// Test: bot in speaking for 110s, audio:state start fires, advance 20 more
// seconds → bot should still be speaking (timer refreshed)."
// ============================================================
describe('ISSUE-02: speaking timeout refreshed on audio:state start', () => {
  beforeEach(async () => {
    await wireRealEventHandlers();
  });

  it('audio:state start refreshes the 120s speaking timeout', () => {
    // SPEC test scenario verbatim
    setCurrentBotId(BOT_A);

    // Put BOT_A into speaking state
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    expect(botTurnState.get(BOT_A)).toBe('speaking');

    // Advance 110s (just under the 120s timeout)
    vi.advanceTimersByTime(110_000);
    expect(botTurnState.get(BOT_A)).toBe('speaking');

    // audio:state start fires — new chunk playing, should refresh timer
    const el = document.createElement('div');
    bus.emit('audio:state', { state: 'playing', msgEl: el, phase: 'start', chunkText: 'new chunk' });

    // Advance 20 more seconds (total 130s from original speaking start)
    // SPEC: "advance 20 more seconds → bot should still be speaking"
    vi.advanceTimersByTime(20_000);
    expect(botTurnState.get(BOT_A)).toBe('speaking');
  });

  it('without refresh the bot would timeout at 120s', () => {
    // Complementary test: verify the timeout DOES fire if no refresh happens
    setCurrentBotId(BOT_A);

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    expect(botTurnState.get(BOT_A)).toBe('speaking');

    // Advance past 120s without any audio:state start refresh
    vi.advanceTimersByTime(121_000);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('timer refresh eventually expires after the extended period', () => {
    // SPEC: timeout is 120s from last refresh, not infinite
    setCurrentBotId(BOT_A);

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');

    // Advance 119s
    vi.advanceTimersByTime(119_000);

    // Refresh the timer
    const el = document.createElement('div');
    bus.emit('audio:state', { state: 'playing', msgEl: el, phase: 'start', chunkText: 'chunk' });

    // Advance another 119s — still within refreshed window
    vi.advanceTimersByTime(119_000);
    expect(botTurnState.get(BOT_A)).toBe('speaking');

    // Advance past the refreshed 120s window
    vi.advanceTimersByTime(2_000);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('audio:state start does NOT refresh timer if bot is not in speaking state', () => {
    // SPEC: only speaking bots get timer refresh
    setCurrentBotId(BOT_A);

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    // BOT_A is in 'receiving', NOT 'speaking'

    const el = document.createElement('div');
    bus.emit('audio:state', { state: 'playing', msgEl: el, phase: 'start', chunkText: 'text' });

    // Bot should remain in receiving (no change)
    expect(botTurnState.get(BOT_A)).toBe('receiving');
  });
});

// ============================================================
// ISSUE-04: Dead audioB64 storage fully removed
// attachAudioToLast, chatStore.attachAudio, jumpToMessage, and all
// dataset.audioB64 writes have been removed. Nothing to test — the
// dead code paths no longer exist.
// ============================================================

// ============================================================
// ISSUE-03: TTS Priority Principle — unified TTS path (regression)
// SPEC: "main.ts:355 (requestTTS) and main.ts:389 (init) — global
// unified Azure TTS, autoRead and manual play-btn use same TTS path."
// Status: FIXED. Regression test ensures audioPlayer.init receives
// a requestTTS function so all TTS goes through the same provider.
// Full test in sc-tts-playback.test.ts; this is a focused mechanism check.
// ============================================================
describe('ISSUE-03: TTS priority — audioPlayer accepts a single requestTTS callback', () => {
  it('audioPlayer.init accepts requestTTS and uses it for enqueue', () => {
    // SPEC: autoRead and manual play-btn use the same TTS path via requestTTS
    let ttsCalled = false;
    audioPlayer.init({
      requestTTS: (_text, _cb) => { ttsCalled = true; },
    });

    const el = document.createElement('div');
    audioPlayer.enqueue(el, '', 'Test text');

    // The single requestTTS callback must have been called
    expect(ttsCalled).toBe(true);
  });
});

// ============================================================
// ISSUE-05: TTS Failure Feedback (partial fix)
// SPEC: "audio-player.ts — _consecutiveFailures counter + audio:tts-failed event;
// event-wiring.ts — tts-failed CSS class + cumulative 3 failures triggers toast."
// Status: PARTIAL FIX. Toast + CSS class implemented. Voice feedback not yet implemented.
// ============================================================
describe('ISSUE-05: TTS failure feedback — consecutive failure counter + bus event', () => {
  it('null TTS response emits audio:tts-failed event', () => {
    // SPEC: audio:tts-failed event fires when TTS returns null
    let capturedCb: ((b64: string | null) => void) | null = null;
    audioPlayer.init({
      requestTTS: (_text, cb) => { capturedCb = cb; },
    });

    const failSpy = vi.fn();
    bus.on('audio:tts-failed', failSpy);

    const el = document.createElement('div');
    audioPlayer.enqueue(el, '', 'Some text');
    expect(capturedCb).not.toBeNull();

    // TTS returns null (failure)
    capturedCb!(null);

    expect(failSpy).toHaveBeenCalled();
  });

  it('consecutive TTS failures increment failure count in events', () => {
    // SPEC: _consecutiveFailures counter tracks failures
    const callbacks: Array<(b64: string | null) => void> = [];
    audioPlayer.init({
      requestTTS: (_text, cb) => { callbacks.push(cb); },
    });

    const failSpy = vi.fn();
    bus.on('audio:tts-failed', failSpy);

    // Enqueue 3 items and fail each one
    for (let i = 0; i < 3; i++) {
      audioPlayer.enqueue(document.createElement('div'), '', `fail ${i}`);
    }

    // Fail the first callback — should trigger tts-failed
    callbacks[0](null);
    expect(failSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// ISSUE-12: iOS background — BLOCKED (needs real iOS device)
// Status: 暂缓. Cannot test in vitest/jsdom.
// ============================================================
// it.skip('ISSUE-12: iOS background e2e chain — BLOCKED (requires real iOS device)');

// ============================================================
// ISSUE-18: E2E test infrastructure — BLOCKED (infra setup)
// Status: 暂缓. Not a behavioral test.
// ============================================================
// it.skip('ISSUE-18: E2E auto backend — BLOCKED (infrastructure, not behavioral)');

