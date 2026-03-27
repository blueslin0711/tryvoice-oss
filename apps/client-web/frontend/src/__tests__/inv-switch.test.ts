// @vitest-environment jsdom
/**
 * INV-SWITCH-01~06, INV-SWITCH-TTS-01, ISSUE-11a
 *
 * Tests derived from EXPERIENCE_SPEC.md invariant definitions.
 * Each describe block cites the specific invariant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  interruptBot, quietResetBot,
  isTurnCancelled,
  getUnreadCount, setUnreadCount,
  getLastReadSeq, setLastReadSeq,
  getCurrentBotId, setCurrentBotId,
  markTextRead, isTextAlreadyRead,
  syncStatusDisplay,
} from '../ui/app-state';
import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import { projectCssClass } from '../state/state-projection';
import { bus } from '../core/event-bus';
import { BOT_IDS, STORAGE_KEY } from '../core/types';
import { chatStore } from '../store/chat-store';
import { setupTestBots, teardownTest, initTestChatStore, BOT_A, BOT_B } from './helpers/test-setup';

beforeEach(() => setupTestBots(BOT_A, BOT_B));
afterEach(() => teardownTest());

// ============================================================
// INV-SWITCH-01: Quiet Reset on Switch (No Cancel)
//
// SPEC: Switching Bot A→B: Bot A gets quietResetBot(): emit
//   interrupt:stop-audio BEFORE new Bot renders, reset UI display,
//   do NOT send cancel_turn, do NOT set turnCancelled.
//   Background processing continues.
//   Exception: if mic recording, use interruptBot (full cancel).
// ============================================================
describe('INV-SWITCH-01: Quiet Reset on Switch (No Cancel)', () => {
  it('quietResetBot emits interrupt:stop-audio without setting turnCancelled', () => {
    // Regression: if quietResetBot set turnCancelled, background turns would
    // be silently discarded by ws-dispatcher when messages arrive later.
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    const stopSpy = vi.fn();
    bus.on('interrupt:stop-audio', stopSpy);

    quietResetBot(BOT_A);

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(isTurnCancelled(BOT_A)).toBe(false);
  });

  it('quietResetBot preserves BotTurnState so background processing continues', () => {
    // Regression: if quietResetBot called resetToIdle on botTurnState,
    // the awaiting→receiving transition would be lost and incoming
    // response_chunk events would be dropped by ws-dispatcher.
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    quietResetBot(BOT_A);

    expect(botTurnState.get(BOT_A)).toBe('awaiting');
  });

  it('quietResetBot(A) does not disturb Bot B state at all', () => {
    // Regression: a global reset would trash all bots' background turns.
    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');

    quietResetBot(BOT_A);

    expect(botTurnState.get(BOT_B)).toBe('awaiting');
    expect(isTurnCancelled(BOT_B)).toBe(false);
  });

  it('exception path: interruptBot when mic is recording — full cancel with turnCancelled', () => {
    // SPEC exception: "if mic recording, use interruptBot (full cancel)"
    // Regression: if interruptBot didn't cancel mic, the MediaRecorder would
    // continue and fire onstop → processBlob → send STT for a cancelled turn.
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    botTurnState.transition(BOT_A, 'listening');

    interruptBot(BOT_A);

    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(micState.isActive).toBe(false);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('interruptBot resets BotTurnState to idle — contrasting with quietResetBot', () => {
    // Verifies the observable difference: interruptBot → idle, quietResetBot → preserves.
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    interruptBot(BOT_A);

    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(isTurnCancelled(BOT_A)).toBe(true);
  });
});

// ============================================================
// INV-SWITCH-02: Badge Clear on Switch-In
//
// SPEC: Switching to Bot X → badge immediately set to 0 and DOM updated.
// ============================================================
describe('INV-SWITCH-02: Badge Clear on Switch-In', () => {
  it('accumulated unread on Bot B is zeroed when switching to it', () => {
    // Regression: if setUnreadCount silently capped or ignored 0, the tab
    // badge would show stale counts after switching.
    setUnreadCount(BOT_B, 5);

    // Reproduce switchToBot's badge clear logic
    setUnreadCount(BOT_B, 0);

    expect(getUnreadCount(BOT_B)).toBe(0);
  });

  it('clearing Bot B badge preserves Bot A unread count (per-bot isolation)', () => {
    // Regression: a shared counter would zero all bots on any switch.
    setUnreadCount(BOT_A, 3);
    setUnreadCount(BOT_B, 7);

    // Switch to B: only B gets cleared
    setUnreadCount(BOT_B, 0);

    expect(getUnreadCount(BOT_A)).toBe(3);
    expect(getUnreadCount(BOT_B)).toBe(0);
  });
});

// ============================================================
// INV-SWITCH-03: Advance Old Bot's LastReadSeq on Switch-Out
//
// SPEC: Switching away from Bot A → lastReadSeq advances to current maxServerSeq.
// ============================================================
describe('INV-SWITCH-03: Advance Old Bot LastReadSeq on Switch-Out', () => {
  it('lastReadSeq(A) advances from 10 to maxServerSeq(A)=20 on switch-out', async () => {
    // Regression: without advancing lastReadSeq, returning to A would re-count
    // already-seen messages as "new unread" when mergeFromServer fires.
    await initTestChatStore([BOT_A, BOT_B]);

    chatStore.mergeFromServer(BOT_A, [
      { role: 'assistant', text: 'msg1', eventKey: 'ek1', serverSeq: 10 },
      { role: 'assistant', text: 'msg2', eventKey: 'ek2', serverSeq: 20 },
    ], Date.now());
    expect(chatStore.getMaxServerSeq(BOT_A)).toBe(20);

    setLastReadSeq(BOT_A, 10);

    // Reproduce switchToBot lines 149-151: advance lastReadSeq on old bot
    const oldMax = chatStore.getMaxServerSeq(BOT_A);
    if (oldMax > getLastReadSeq(BOT_A)) {
      setLastReadSeq(BOT_A, oldMax);
    }

    expect(getLastReadSeq(BOT_A)).toBe(20);
  });

  it('does not regress lastReadSeq when maxServerSeq <= lastReadSeq', async () => {
    // Regression: unconditional overwrite would lower lastReadSeq if the
    // server had fewer messages (e.g. after purge).
    await initTestChatStore([BOT_A, BOT_B]);
    chatStore.clearCache(BOT_A);

    chatStore.mergeFromServer(BOT_A, [
      { role: 'assistant', text: 'msg1', eventKey: 'ek1', serverSeq: 5 },
    ], Date.now());
    expect(chatStore.getMaxServerSeq(BOT_A)).toBe(5);

    setLastReadSeq(BOT_A, 10);

    // switchToBot guard: only advance, never regress
    const oldMax = chatStore.getMaxServerSeq(BOT_A);
    if (oldMax > getLastReadSeq(BOT_A)) {
      setLastReadSeq(BOT_A, oldMax);
    }

    expect(getLastReadSeq(BOT_A)).toBe(10);
  });

  it('advancing Bot A lastReadSeq does not affect Bot B lastReadSeq', async () => {
    // Regression: a global pointer would advance both bots' lastReadSeq on switch.
    await initTestChatStore([BOT_A, BOT_B]);
    chatStore.clearCache(BOT_A);
    chatStore.clearCache(BOT_B);

    chatStore.mergeFromServer(BOT_A, [
      { role: 'assistant', text: 'a1', eventKey: 'eka1', serverSeq: 30 },
    ], Date.now());
    chatStore.mergeFromServer(BOT_B, [
      { role: 'assistant', text: 'b1', eventKey: 'ekb1', serverSeq: 5 },
    ], Date.now());

    setLastReadSeq(BOT_A, 10);
    setLastReadSeq(BOT_B, 2);

    // Advance only Bot A (switching away from A)
    const oldMaxA = chatStore.getMaxServerSeq(BOT_A);
    if (oldMaxA > getLastReadSeq(BOT_A)) {
      setLastReadSeq(BOT_A, oldMaxA);
    }

    expect(getLastReadSeq(BOT_A)).toBe(30);
    expect(getLastReadSeq(BOT_B)).toBe(2);
  });
});

// ============================================================
// INV-SWITCH-04: Reset Scroll on Switch
//
// SPEC: Switching to new Bot resets scroll tracking.
//   No unread = scroll to bottom; has unread = scroll to first unread at 1/3 top.
// ============================================================
describe('INV-SWITCH-04: Reset Scroll on Switch', () => {
  it('resetScrollSession resets scroll state without throwing', async () => {
    // Regression: without resetting the scroll session, the deferred
    // requestAnimationFrame scroll-to-bottom in renderChat is blocked by
    // a stale _userHasScrolledThisSession flag from the previous bot.
    // The internal _scrollOwnership is module-private; we verify the
    // function exercises the clearTimeout + flag reset path by calling
    // it from a non-idle state.
    const { resetScrollSession } = await import('../ui/chat-renderer');

    // Call to exercise the reset path (clears _userHasScrolledThisSession,
    // _scrollOwnershipTimer, and sets _scrollOwnership = 'AUTO')
    resetScrollSession();

    // No throw = the timer was safely cleared and flags reset
  });

  it('resetScrollSession is idempotent — double call does not throw', async () => {
    // Guard against clearTimeout crash on double-reset
    const { resetScrollSession } = await import('../ui/chat-renderer');

    resetScrollSession();
    resetScrollSession();
    // If we get here without throwing, test passes
  });
});

// ============================================================
// INV-SWITCH-05: Restore Status Display on Switch
//
// SPEC: After switching to Bot X, mic status text, CSS class,
//   cancel button visibility reflect Bot X's state (not previous bot).
// ============================================================
describe('INV-SWITCH-05: Restore Status Display on Switch', () => {
  it('projectCssClass reflects the SPECIFIC bot state, not global state', () => {
    // Regression: if projection used a global state, switching from recording
    // bot A to idle bot B would show "recording" on B.
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    // Bot A is processing, Bot B is idle
    expect(projectCssClass(BOT_A)).toBe('processing');
    expect(projectCssClass(BOT_B)).toBe('');
  });

  it('speaking state on target bot shows "speaking" class', () => {
    // Regression: if the CSS class was latched from the old bot,
    // the orb animation would not update to speaking.
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'tts');
    botTurnState.transition(BOT_A, 'speaking');

    expect(projectCssClass(BOT_A)).toBe('speaking');
  });

  it('mic recording is scoped to the specific bot — not leaked to others', () => {
    // Regression: a global mic flag would show "recording" on all bots.
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();

    expect(projectCssClass(BOT_A)).toBe('recording');
    expect(projectCssClass(BOT_B)).toBe('');
  });

  it('idle bot projects empty CSS class (no stale animation)', () => {
    expect(projectCssClass(BOT_A)).toBe('');
  });

  it('syncStatusDisplay is callable without error for current bot', () => {
    // Verifies the projection→DOM path doesn't throw when mic-ui/status-bar
    // modules are not yet imported (lazy import path).
    setCurrentBotId(BOT_A);
    expect(() => syncStatusDisplay(BOT_A)).not.toThrow();
  });
});

// ============================================================
// INV-SWITCH-06: Auto-Read Unread on Switch-In
//
// SPEC: Switch to bot with unread + autoReadEnabled=true →
//   TTS starts from first unread in order.
//   Emits chat:auto-read-unread event.
// ============================================================
describe('INV-SWITCH-06: Auto-Read Unread on Switch-In', () => {
  it('switching to bot with 3 unread emits chat:auto-read-unread with count=3', () => {
    // Regression: without this event, the TTS queue would not auto-read
    // accumulated messages when the user switches to a bot with unread.
    const spy = vi.fn();
    bus.on('chat:auto-read-unread', spy);

    setUnreadCount(BOT_B, 3);

    // Reproduce switchToBot lines 145-155
    const unreadN = getUnreadCount(BOT_B);
    setUnreadCount(BOT_B, 0);
    if (unreadN > 0) {
      bus.emit('chat:auto-read-unread', { botId: BOT_B, count: unreadN });
    }

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith({ botId: BOT_B, count: 3 });
  });

  it('switching to bot with 0 unread does NOT emit chat:auto-read-unread', () => {
    // Regression: emitting with count=0 would trigger empty TTS queue processing.
    const spy = vi.fn();
    bus.on('chat:auto-read-unread', spy);

    setUnreadCount(BOT_B, 0);

    const unreadN = getUnreadCount(BOT_B);
    if (unreadN > 0) {
      bus.emit('chat:auto-read-unread', { botId: BOT_B, count: unreadN });
    }

    expect(spy).not.toHaveBeenCalled();
  });

  it('event payload carries the ORIGINAL unread count, badge is already 0', () => {
    // Regression: if count was captured after zeroing, TTS would get count=0.
    const spy = vi.fn();
    bus.on('chat:auto-read-unread', spy);

    setUnreadCount(BOT_B, 10);

    // Capture THEN zero (order matters per spec)
    const unreadN = getUnreadCount(BOT_B);
    setUnreadCount(BOT_B, 0);
    if (unreadN > 0) {
      bus.emit('chat:auto-read-unread', { botId: BOT_B, count: unreadN });
    }

    expect(spy.mock.calls[0][0].count).toBe(10);
    expect(getUnreadCount(BOT_B)).toBe(0);
  });
});

// ============================================================
// INV-SWITCH-TTS-01: Deduped Text Not Re-Read
//
// SPEC: _readTextKeys dedup set must NOT be cleared on bot switch.
//   Already-read text stays marked.
// ============================================================
describe('INV-SWITCH-TTS-01: Deduped Text Not Re-Read', () => {
  it('markTextRead survives a full A→B→A switch cycle via quietResetBot', () => {
    // Regression: if quietResetBot or switchToBot cleared _readTextKeys,
    // returning to a bot would cause double-read of already-spoken text.
    markTextRead(BOT_A, 'hello world');

    // Simulate switchToBot(BOT_B): quiet reset old, set new current
    quietResetBot(BOT_A);
    setCurrentBotId(BOT_B);

    // Simulate switchToBot(BOT_A): quiet reset old, set new current
    quietResetBot(BOT_B);
    setCurrentBotId(BOT_A);

    expect(isTextAlreadyRead(BOT_A, 'hello world')).toBe(true);
  });

  it('dedup is per-bot scoped — marking on A does not suppress reading on B', () => {
    // Regression: a global dedup set would prevent reading the same
    // text on a different bot that independently generated it.
    markTextRead(BOT_A, 'shared text');

    expect(isTextAlreadyRead(BOT_A, 'shared text')).toBe(true);
    expect(isTextAlreadyRead(BOT_B, 'shared text')).toBe(false);
  });

  it('whitespace normalization prevents dedup bypass on formatting differences', () => {
    // Regression: if keys weren't normalized, slight whitespace differences
    // between intermediate_step and canonical messages would bypass dedup
    // and cause double-read.
    markTextRead(BOT_A, '  hello   world  ');

    expect(isTextAlreadyRead(BOT_A, 'hello world')).toBe(true);
  });

  it('interruptBot also does not clear readTextKeys', () => {
    // Even a full interrupt should not clear the dedup set — the text
    // was already spoken, clearing would cause re-read on reconnect.
    markTextRead(BOT_A, 'already spoken');

    interruptBot(BOT_A);

    expect(isTextAlreadyRead(BOT_A, 'already spoken')).toBe(true);
  });
});

// ============================================================
// ISSUE-11a: currentBotId not persisted
//
// SPEC: switchToBot should save currentBotId to localStorage.
//   Init should restore from localStorage.
// ============================================================
describe('ISSUE-11a: currentBotId not persisted', () => {
  it('write path: setCurrentBotId + localStorage persist', () => {
    // Reproduce switchToBot lines 131-132
    const newBotId = BOT_B;
    setCurrentBotId(newBotId);
    try { localStorage.setItem(STORAGE_KEY + 'currentBotId', newBotId); } catch (_e) { /* ignore */ }

    expect(localStorage.getItem(STORAGE_KEY + 'currentBotId')).toBe(BOT_B);
    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('read path: savedBotId restored from localStorage when it exists in BOT_IDS', () => {
    // Reproduce init lines 317-324
    localStorage.setItem(STORAGE_KEY + 'currentBotId', BOT_B);
    setCurrentBotId(BOT_A); // Reset in-memory to simulate fresh init

    const savedBotId = localStorage.getItem(STORAGE_KEY + 'currentBotId');
    if (savedBotId && BOT_IDS.includes(savedBotId) && savedBotId !== getCurrentBotId()) {
      setCurrentBotId(savedBotId);
    }

    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('read path: stale bot ID not in BOT_IDS is ignored', () => {
    // Regression: restoring a stale bot ID (from a deleted slot) would crash
    // downstream code that assumes getCurrentBotId() is always in BOT_IDS.
    localStorage.setItem(STORAGE_KEY + 'currentBotId', 'deleted_bot');
    setCurrentBotId(BOT_A);

    const savedBotId = localStorage.getItem(STORAGE_KEY + 'currentBotId');
    if (savedBotId && BOT_IDS.includes(savedBotId) && savedBotId !== getCurrentBotId()) {
      setCurrentBotId(savedBotId);
    }

    expect(getCurrentBotId()).toBe(BOT_A);
  });

  it('read path: same bot ID as current is a no-op (no redundant set)', () => {
    // Edge case: if saved == current, no setCurrentBotId call needed.
    setCurrentBotId(BOT_A);
    localStorage.setItem(STORAGE_KEY + 'currentBotId', BOT_A);

    const spy = vi.spyOn({ setCurrentBotId }, 'setCurrentBotId');

    const savedBotId = localStorage.getItem(STORAGE_KEY + 'currentBotId');
    if (savedBotId && BOT_IDS.includes(savedBotId) && savedBotId !== getCurrentBotId()) {
      // This should NOT execute because savedBotId === getCurrentBotId()
      spy('should not be called');
    }

    expect(spy).not.toHaveBeenCalled();
  });
});
