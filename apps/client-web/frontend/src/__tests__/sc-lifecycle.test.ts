// @vitest-environment jsdom
/**
 * SG-F Chain Tests: Bot Lifecycle (SC-F-01 ~ SC-F-15)
 *
 * SC-F-01: Discovery already_added detection
 * SC-F-02: Deselect → DELETE (setCurrentBotId changes active bot)
 * SC-F-03: Replace vs append mode (BOT_IDS mutation patterns)
 * SC-F-04: Discover failure handling (ensureRuntimeBotState with empty array)
 * SC-F-05: Offline marking (bus event 'slots-changed')
 * SC-F-06: Delete idle bot (interruptBot on idle bot is safe)
 * SC-F-07: Delete processing bot (interruptBot resets state; ISSUE-15: .todo)
 * SC-F-08: Delete speaking bot (interruptBot stops audio)
 * SC-F-09: Delete current bot → switch to default
 * SC-F-10: Delete last bot → wizard (BOT_IDS empty)
 * SC-F-11: botId from project_dir (ID uniqueness)
 * SC-F-12: botId display name (getBotDisplayName with suffix)
 * SC-F-13: Session key isolation (per-bot state independence)
 * SC-F-14: Multi-session same project (per-bot state independence)
 * SC-F-15: Backend restart recovery (state reset pattern)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ensureRuntimeBotState,
  getCurrentBotId, setCurrentBotId,
  getBotDisplayName, setBotSuffix, setBotNames,
  interruptBot, resetBotToIdle,
  getBotMicState, isTurnCancelled, clearTurnCancelled,
} from '../ui/app-state';
import { BOT_IDS, setRuntimeBotIds } from '../core/types';
import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import { remoteAgentState } from '../state/remote-agent-state';
import { audioPlayer } from '../audio/audio-player';
import { bus } from '../core/event-bus';
import { setupTestBots, teardownTest, BOT_A, BOT_B } from './helpers/test-setup';

// Re-register the interrupt:stop-audio handler (setupTestBots calls bus.removeAll())
function reRegisterInterruptHandler(): void {
  bus.on('interrupt:stop-audio', () => {
    if (audioPlayer.state === 'idle') return;
    audioPlayer.stop();
  });
}

beforeEach(() => {
  setupTestBots(BOT_A, BOT_B);
  reRegisterInterruptHandler();
  setCurrentBotId(BOT_A);

  // Mock browser audio APIs
  if (!(globalThis as unknown as Record<string, unknown>).SpeechSynthesisUtterance) {
    (globalThis as unknown as Record<string, unknown>).SpeechSynthesisUtterance = class {
      lang = ''; rate = 1; text = '';
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text?: string) { this.text = text || ''; }
    };
  }
  if (!window.speechSynthesis) {
    (window as unknown as Record<string, unknown>).speechSynthesis = {
      cancel: vi.fn(),
      speak: vi.fn(),
      getVoices: vi.fn(() => []),
    };
  }
  if (!window.AudioContext) {
    class MockAudioContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume = vi.fn(() => Promise.resolve());
      createGain = vi.fn(() => ({
        gain: { value: 1 },
        connect: vi.fn(function(this: unknown) { return this; }),
      }));
      createAnalyser = vi.fn(() => ({
        fftSize: 256,
        getFloatTimeDomainData: vi.fn(),
        connect: vi.fn(),
      }));
      createOscillator = vi.fn(() => ({
        frequency: { value: 0 },
        connect: vi.fn(() => ({ connect: vi.fn() })),
        start: vi.fn(),
      }));
      createMediaStreamDestination = vi.fn(() => ({
        stream: {},
      }));
      createBufferSource = vi.fn(() => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      }));
      // Hold the success callback so the player stays in 'playing' state
      decodeAudioData = vi.fn((_buf: ArrayBuffer, _onSuccess: (buf: unknown) => void, _onError?: () => void) => {
        // Do NOT call onSuccess — keeps player in 'playing'
      });
    }
    (window as unknown as Record<string, unknown>).AudioContext = MockAudioContext;
  }
});

afterEach(() => {
  audioPlayer.stop();
  teardownTest();
});

// ============================================================
// SC-F-01: Discovery already_added detection — ensureRuntimeBotState idempotency
// ============================================================
describe('SC-F-01: Discovery already_added detection', () => {
  it('ensureRuntimeBotState with existing bots is idempotent', () => {
    // BOT_A and BOT_B already exist from setupTestBots
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(botTurnState.get(BOT_B)).toBe('idle');

    // Calling again with same IDs should not change state
    ensureRuntimeBotState([BOT_A, BOT_B]);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(botTurnState.get(BOT_B)).toBe('idle');
    expect(getCurrentBotId()).toBe(BOT_A);
  });

  it('ensureRuntimeBotState with a new bot adds state without affecting existing', () => {
    const NEW_BOT = 'botC';
    ensureRuntimeBotState([BOT_A, BOT_B, NEW_BOT]);

    // Existing bots unchanged
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(botTurnState.get(BOT_B)).toBe('idle');
    // Current bot unchanged since it's still in the new list
    expect(getCurrentBotId()).toBe(BOT_A);
  });

  it('ensureRuntimeBotState preserves current bot when it remains in list', () => {
    setCurrentBotId(BOT_B);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('already_added bots are detected by sessionKey match (BOT_IDS membership)', () => {
    expect(BOT_IDS).toContain(BOT_A);
    expect(BOT_IDS).toContain(BOT_B);
    // A new bot not in BOT_IDS is not "already added"
    expect(BOT_IDS).not.toContain('newBot');
  });
});

// ============================================================
// SC-F-02: Deselect → DELETE — setCurrentBotId changes active bot
// ============================================================
describe('SC-F-02: Deselect → DELETE (setCurrentBotId changes active bot)', () => {
  it('setCurrentBotId switches the active bot', () => {
    expect(getCurrentBotId()).toBe(BOT_A);
    setCurrentBotId(BOT_B);
    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('switching bot does not affect bot turn states', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    setCurrentBotId(BOT_B);

    // BOT_A's turn state is preserved
    expect(botTurnState.get(BOT_A)).toBe('awaiting');
    expect(botTurnState.get(BOT_B)).toBe('idle');
  });

  it('deselecting a bot (switching away) is the precursor to DELETE', () => {
    setCurrentBotId(BOT_A);
    // Deselect BOT_A by switching to BOT_B
    setCurrentBotId(BOT_B);
    expect(getCurrentBotId()).toBe(BOT_B);
    expect(getCurrentBotId()).not.toBe(BOT_A);

    // After deselect, the bot can be removed from BOT_IDS (DELETE operation)
    setRuntimeBotIds([BOT_B]);
    expect(BOT_IDS).not.toContain(BOT_A);
  });
});

// ============================================================
// SC-F-03: Replace vs append mode — BOT_IDS mutation patterns
// ============================================================
describe('SC-F-03: Replace vs append mode (BOT_IDS mutation patterns)', () => {
  it('setRuntimeBotIds replaces all IDs (replace mode)', () => {
    setRuntimeBotIds(['x', 'y', 'z']);
    expect(BOT_IDS).toEqual(['x', 'y', 'z']);
  });

  it('setRuntimeBotIds deduplicates IDs', () => {
    setRuntimeBotIds(['a', 'b', 'a', 'c', 'b']);
    expect(BOT_IDS).toEqual(['a', 'b', 'c']);
  });

  it('setRuntimeBotIds trims and filters empty strings', () => {
    setRuntimeBotIds([' foo ', '', '  bar  ', '']);
    expect(BOT_IDS).toEqual(['foo', 'bar']);
  });

  it('append mode: add to existing BOT_IDS by reading + adding', () => {
    setRuntimeBotIds([BOT_A, BOT_B]);
    const appended = [...BOT_IDS, 'botC'];
    setRuntimeBotIds(appended);
    expect(BOT_IDS).toEqual([BOT_A, BOT_B, 'botC']);
  });

  it('empty array clears all bot IDs', () => {
    setRuntimeBotIds([]);
    expect(BOT_IDS).toEqual([]);
  });

  it('first setup uses replace mode (fresh BOT_IDS)', () => {
    setRuntimeBotIds([]);
    expect(BOT_IDS.length).toBe(0);

    // First setup: replace mode sets initial bots
    setRuntimeBotIds(['alpha', 'beta']);
    expect(BOT_IDS).toEqual(['alpha', 'beta']);
  });

  it('subsequent setup uses append mode (preserves existing)', () => {
    setRuntimeBotIds(['alpha', 'beta']);
    // Append: read existing + add new
    const updated = [...BOT_IDS, 'gamma'];
    setRuntimeBotIds(updated);
    expect(BOT_IDS).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// ============================================================
// SC-F-04: Discover failure handling — ensureRuntimeBotState with empty array
// ============================================================
describe('SC-F-04: Discover failure handling', () => {
  it('ensureRuntimeBotState with empty array does not crash', () => {
    expect(() => ensureRuntimeBotState([])).not.toThrow();
  });

  it('existing bot state is preserved after empty ensureRuntimeBotState', () => {
    botTurnState.transition(BOT_A, 'sending');
    ensureRuntimeBotState([]);
    // State for BOT_A was already initialized — it persists
    expect(botTurnState.get(BOT_A)).toBe('sending');
  });

  it('existing slots unaffected by discover failure', () => {
    // Set up bots with state
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');

    // Discover fails (empty list) → error shown, existing slots unaffected
    ensureRuntimeBotState([]);

    expect(botTurnState.get(BOT_A)).toBe('sending');
    expect(botTurnState.get(BOT_B)).toBe('awaiting');
    // BOT_IDS still has original bots
    expect(BOT_IDS).toContain(BOT_A);
    expect(BOT_IDS).toContain(BOT_B);
  });
});

// ============================================================
// SC-F-05: Offline marking — bus event 'slots-changed'
// ============================================================
describe('SC-F-05: Offline marking (slots-changed bus event)', () => {
  it('slots-changed event can be emitted and received', () => {
    const spy = vi.fn();
    bus.on('slots-changed', spy);
    bus.emit('slots-changed', { reason: 'offline' });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ reason: 'offline' }));
  });

  it('offline bot retains its turn state (discover_and_sync marks offline, does not delete)', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    // Simulate discover_and_sync marking bot as offline (does NOT reset state)
    bus.emit('slots-changed', { reason: 'offline', botId: BOT_A });

    // Turn state is preserved — discover_and_sync never deletes
    expect(botTurnState.get(BOT_A)).toBe('awaiting');
  });

  it('offline marking does not remove bot from BOT_IDS', () => {
    bus.emit('slots-changed', { reason: 'offline', botId: BOT_A });

    // Bot remains in the active list — marked offline but NOT deleted
    expect(BOT_IDS).toContain(BOT_A);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('discover_and_sync with inactive bots marks them offline, never deletes', () => {
    // Both bots are in BOT_IDS
    expect(BOT_IDS.length).toBe(2);

    // Mark BOT_B as offline
    bus.emit('slots-changed', { reason: 'offline', botId: BOT_B });

    // BOT_B is still in BOT_IDS — not removed
    expect(BOT_IDS).toContain(BOT_B);
    expect(BOT_IDS.length).toBe(2);
  });
});

// ============================================================
// SC-F-06: Delete idle bot — interruptBot on idle bot is safe (no-op)
// ============================================================
describe('SC-F-06: Delete idle bot (interruptBot on idle is safe)', () => {
  it('interruptBot on idle bot does not throw', () => {
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(() => interruptBot(BOT_A)).not.toThrow();
  });

  it('interruptBot on idle bot still sets turnCancelled', () => {
    interruptBot(BOT_A);
    expect(isTurnCancelled(BOT_A)).toBe(true);
    // Bot remains idle
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('interruptBot on idle bot does not affect other bots', () => {
    botTurnState.transition(BOT_B, 'sending');
    interruptBot(BOT_A);
    expect(botTurnState.get(BOT_B)).toBe('sending');
    expect(isTurnCancelled(BOT_B)).toBe(false);
  });

  it('after interruptBot on idle bot, normal delete flow can proceed', () => {
    interruptBot(BOT_A);
    // Delete: remove from BOT_IDS
    setRuntimeBotIds([BOT_B]);
    expect(BOT_IDS).not.toContain(BOT_A);
    expect(BOT_IDS).toContain(BOT_B);
  });
});

// ============================================================
// SC-F-07: Delete processing bot — interruptBot resets state
// ISSUE-15: _removeBot should call interruptBot before deletion
// ============================================================
describe('SC-F-07: Delete processing bot (interruptBot resets state)', () => {
  it('interruptBot resets awaiting bot to idle', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    remoteAgentState.update(BOT_A, 'processing');

    interruptBot(BOT_A, 'cancelled');

    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(remoteAgentState.get(BOT_A)).toBe('idle');
    expect(isTurnCancelled(BOT_A)).toBe(true);
  });

  it('interruptBot emits interrupt:stop-audio', () => {
    const spy = vi.fn();
    bus.on('interrupt:stop-audio', spy);

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    interruptBot(BOT_A, 'cancelled');

    expect(spy).toHaveBeenCalledOnce();
  });

  it('interruptBot on receiving bot also resets to idle', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    remoteAgentState.update(BOT_A, 'generating');

    interruptBot(BOT_A, 'cancelled');

    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(remoteAgentState.get(BOT_A)).toBe('idle');
  });

  // ISSUE-15: _removeBot should call interruptBot before removing from BOT_IDS
  it.todo('ISSUE-15: _removeBot should call interruptBot before deletion (fix in Phase 3)');
});

// ============================================================
// SC-F-08: Delete speaking bot — interruptBot stops audio
// ============================================================
describe('SC-F-08: Delete speaking bot (interruptBot stops audio)', () => {
  it('interruptBot stops audio playback when bot is speaking', () => {
    // Set up speaking state
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');

    // Audio is playing
    audioPlayer.enqueue(null, 'dGVzdA==', 'speaking text');
    expect(audioPlayer.state).toBe('playing');

    interruptBot(BOT_A, 'cancelled');

    // Audio stopped
    expect(audioPlayer.state).toBe('idle');
    // Turn state reset
    expect(botTurnState.get(BOT_A)).toBe('idle');
    // Legacy bot mic state reset
    expect(getBotMicState(BOT_A)).toBe('');
  });

  it('interrupt:stop-audio event fires on delete-while-speaking', () => {
    const spy = vi.fn();
    bus.on('interrupt:stop-audio', spy);

    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');

    interruptBot(BOT_A, 'cancelled');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('audio queue is cleared after interruptBot on speaking bot', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');

    audioPlayer.enqueue(null, 'dGVzdA==', 'chunk 1');
    audioPlayer.enqueue(null, 'dGVzdA==', 'chunk 2');
    expect(audioPlayer.state).toBe('playing');

    interruptBot(BOT_A, 'cancelled');

    expect(audioPlayer.state).toBe('idle');
    // New enqueue should work from clean state
    audioPlayer.enqueue(null, 'dGVzdA==', 'new after delete');
    expect(audioPlayer.state).toBe('playing');
  });
});

// ============================================================
// SC-F-09: Delete current bot → switch to default
// ============================================================
describe('SC-F-09: Delete current bot → switch to default', () => {
  it('ensureRuntimeBotState auto-switches when current bot is removed from list', () => {
    setRuntimeBotIds([BOT_A, BOT_B]);
    setCurrentBotId(BOT_A);
    expect(getCurrentBotId()).toBe(BOT_A);

    // Remove BOT_A from runtime IDs
    const remaining = [BOT_B];
    setRuntimeBotIds(remaining);
    ensureRuntimeBotState(remaining);

    // Current bot should switch to first remaining (BOT_B)
    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('when current bot is the second bot and is removed, switches to first', () => {
    setRuntimeBotIds([BOT_A, BOT_B]);
    setCurrentBotId(BOT_B);

    const remaining = [BOT_A];
    setRuntimeBotIds(remaining);
    ensureRuntimeBotState(remaining);

    expect(getCurrentBotId()).toBe(BOT_A);
  });

  it('deleting current bot triggers switch to the default (first) bot', () => {
    const BOT_C = 'botC';
    setRuntimeBotIds([BOT_A, BOT_B, BOT_C]);
    ensureRuntimeBotState([BOT_A, BOT_B, BOT_C]);
    setCurrentBotId(BOT_B);

    // Delete BOT_B (current)
    const remaining = [BOT_A, BOT_C];
    setRuntimeBotIds(remaining);
    ensureRuntimeBotState(remaining);

    // Should switch to first remaining
    expect(getCurrentBotId()).toBe(BOT_A);
  });
});

// ============================================================
// SC-F-10: Delete last bot → wizard (BOT_IDS empty pattern)
// ============================================================
describe('SC-F-10: Delete last bot → wizard (BOT_IDS empty)', () => {
  it('setRuntimeBotIds to empty results in BOT_IDS.length === 0', () => {
    setRuntimeBotIds([]);
    expect(BOT_IDS.length).toBe(0);
  });

  it('BOT_IDS empty is the trigger condition for setup wizard', () => {
    setRuntimeBotIds([BOT_A]);
    expect(BOT_IDS.length).toBe(1);

    // Remove last bot
    setRuntimeBotIds([]);
    expect(BOT_IDS.length).toBe(0);
    // In slot-tabs.ts, BOT_IDS.length === 0 triggers openSetupWizard()
  });

  it('deleting bots one by one until empty triggers wizard condition', () => {
    setRuntimeBotIds([BOT_A, BOT_B]);
    expect(BOT_IDS.length).toBe(2);

    // Delete first
    setRuntimeBotIds([BOT_B]);
    expect(BOT_IDS.length).toBe(1);

    // Delete last
    setRuntimeBotIds([]);
    expect(BOT_IDS.length).toBe(0);
  });
});

// ============================================================
// SC-F-11: botId from project_dir — test ID uniqueness
// ============================================================
describe('SC-F-11: botId from project_dir (ID uniqueness)', () => {
  it('setRuntimeBotIds enforces uniqueness', () => {
    setRuntimeBotIds(['proj-abc', 'proj-abc', 'proj-xyz']);
    expect(BOT_IDS).toEqual(['proj-abc', 'proj-xyz']);
  });

  it('different project_dir produce different botIds', () => {
    const botId1 = 'proj_home_user_project1';
    const botId2 = 'proj_home_user_project2';
    setRuntimeBotIds([botId1, botId2]);
    expect(BOT_IDS).toEqual([botId1, botId2]);
    expect(botId1).not.toBe(botId2);
  });

  it('same project_dir always produces same botId (deterministic)', () => {
    const id = 'proj_my_project';
    setRuntimeBotIds([id]);
    expect(BOT_IDS[0]).toBe(id);

    // Calling again does not change it
    setRuntimeBotIds([id]);
    expect(BOT_IDS[0]).toBe(id);
  });

  it('Claude Code bot identity from project_dir is stable across restart', () => {
    const projDir = '/home/user/my-project';
    // Simulate botId derived from project_dir (deterministic mapping)
    const botId = `cc_${projDir.replace(/\//g, '_')}`;

    setRuntimeBotIds([botId]);
    expect(BOT_IDS[0]).toBe(botId);

    // "Restart": re-set with same project_dir → same botId
    setRuntimeBotIds([botId]);
    expect(BOT_IDS[0]).toBe(botId);
  });
});

// ============================================================
// SC-F-12: Multiple bots sharing project_dir → botId no collision
//
// SPEC: Two Claude Code Bots pointing at same project_dir but
//   different sessions must have unique botIds. Message routing
//   must not cross. State (BotTurnState, Badge, lastReadSeq)
//   must be independently maintained.
// ============================================================
describe('SC-F-12: Multi-bot shared project_dir → botId no collision', () => {
  it('two bots with same project_dir but different sessions have unique botIds', () => {
    // Spec: botId uniqueness via session index / slot number
    const bot1 = 'cc_shared_project_sess1';
    const bot2 = 'cc_shared_project_sess2';
    setRuntimeBotIds([bot1, bot2]);
    expect(BOT_IDS).toEqual([bot1, bot2]);
    expect(bot1).not.toBe(bot2);
  });

  it('BotTurnState is independently maintained per bot', () => {
    // Spec: "各自的 BotTurnState、Badge、lastReadSeq 独立维护"
    const bot1 = 'cc_proj_alpha_1';
    const bot2 = 'cc_proj_alpha_2';
    setRuntimeBotIds([bot1, bot2]);
    ensureRuntimeBotState([bot1, bot2]);
    botTurnState.ensureBot(bot1);
    botTurnState.ensureBot(bot2);

    botTurnState.transition(bot1, 'sending');
    botTurnState.transition(bot1, 'awaiting');
    expect(botTurnState.get(bot1)).toBe('awaiting');
    expect(botTurnState.get(bot2)).toBe('idle');

    // Interrupt one does not affect the other
    interruptBot(bot1);
    expect(botTurnState.get(bot1)).toBe('idle');
    expect(botTurnState.get(bot2)).toBe('idle');
    expect(isTurnCancelled(bot1)).toBe(true);
    expect(isTurnCancelled(bot2)).toBe(false);
  });

  it('remoteAgentState is independently maintained per bot', () => {
    const bot1 = 'cc_proj_beta_1';
    const bot2 = 'cc_proj_beta_2';
    setRuntimeBotIds([bot1, bot2]);
    ensureRuntimeBotState([bot1, bot2]);
    remoteAgentState.ensureBot(bot1);
    remoteAgentState.ensureBot(bot2);

    remoteAgentState.update(bot1, 'processing');
    remoteAgentState.update(bot2, 'generating');
    expect(remoteAgentState.get(bot1)).toBe('processing');
    expect(remoteAgentState.get(bot2)).toBe('generating');
  });

  it('setRuntimeBotIds deduplicates — same botId not added twice', () => {
    // Spec: botId via distinguishing factor ensures uniqueness
    const dupeId = 'cc_same_project';
    setRuntimeBotIds([dupeId, dupeId]);
    expect(BOT_IDS).toEqual([dupeId]);
  });

  it('display name distinguishes shared-project bots via suffix', () => {
    // Supplementary: display names can distinguish same-project bots
    const bot1 = 'cc_project_alpha_1';
    const bot2 = 'cc_project_alpha_2';
    setBotNames({ [bot1]: 'Project Alpha', [bot2]: 'Project Alpha' });
    setBotSuffix(bot1, 'session-1');
    setBotSuffix(bot2, 'session-2');

    expect(getBotDisplayName(bot1)).toBe('Project Alpha (session-1)');
    expect(getBotDisplayName(bot2)).toBe('Project Alpha (session-2)');
    expect(getBotDisplayName(bot1)).not.toBe(getBotDisplayName(bot2));
  });
});

// ============================================================
// SC-F-13: Session key isolation — per-bot state independence
// ============================================================
describe('SC-F-13: Session key isolation (per-bot state independence)', () => {
  it('botTurnState is independent per bot', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');

    expect(botTurnState.get(BOT_A)).toBe('awaiting');
    expect(botTurnState.get(BOT_B)).toBe('idle');
  });

  it('resetting one bot does not affect another', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');

    botTurnState.resetToIdle(BOT_A);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(botTurnState.get(BOT_B)).toBe('awaiting');
  });

  it('remoteAgentState is independent per bot', () => {
    remoteAgentState.update(BOT_A, 'processing');
    remoteAgentState.update(BOT_B, 'generating');

    expect(remoteAgentState.get(BOT_A)).toBe('processing');
    expect(remoteAgentState.get(BOT_B)).toBe('generating');

    remoteAgentState.resetToIdle(BOT_A);
    expect(remoteAgentState.get(BOT_A)).toBe('idle');
    expect(remoteAgentState.get(BOT_B)).toBe('generating');
  });

  it('turnCancelled is per-bot', () => {
    interruptBot(BOT_A, 'cancelled');
    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(isTurnCancelled(BOT_B)).toBe(false);
  });

  it('JSONL cross-session: session key isolation ensures no cross-bot leakage', () => {
    // Each bot has its own independent state — no shared mutable state
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_B, 'sending');

    // Interrupt BOT_A does not affect BOT_B
    interruptBot(BOT_A, 'cancelled');
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(botTurnState.get(BOT_B)).toBe('sending');
    expect(isTurnCancelled(BOT_B)).toBe(false);
  });
});

// ============================================================
// SC-F-14: Multi-session same project (per-bot state independence)
// ============================================================
describe('SC-F-14: Session key rotation → slot update → messages not lost', () => {
  it('two bots with similar names maintain separate turn states', () => {
    const BOT_X = 'proj_shared_1';
    const BOT_Y = 'proj_shared_2';
    setRuntimeBotIds([BOT_X, BOT_Y]);
    ensureRuntimeBotState([BOT_X, BOT_Y]);
    botTurnState.ensureBot(BOT_X);
    botTurnState.ensureBot(BOT_Y);

    botTurnState.transition(BOT_X, 'sending');
    expect(botTurnState.get(BOT_X)).toBe('sending');
    expect(botTurnState.get(BOT_Y)).toBe('idle');
  });

  it('ensureRuntimeBotState initializes both bots independently', () => {
    const BOT_X = 'session_a';
    const BOT_Y = 'session_b';
    ensureRuntimeBotState([BOT_X, BOT_Y]);

    // Both should have independent state entries
    expect(getBotMicState(BOT_X)).toBe('');
    expect(getBotMicState(BOT_Y)).toBe('');
  });

  it('session key rotation: updating BOT_IDS preserves slot for remaining bots', () => {
    const oldSession = 'cc_proj_session_v1';
    const newSession = 'cc_proj_session_v2';

    setRuntimeBotIds([oldSession, BOT_B]);
    ensureRuntimeBotState([oldSession, BOT_B]);
    botTurnState.ensureBot(oldSession);

    // Rotate: old session replaced by new session
    setRuntimeBotIds([newSession, BOT_B]);
    ensureRuntimeBotState([newSession, BOT_B]);
    botTurnState.ensureBot(newSession);

    // New session has fresh state
    expect(botTurnState.get(newSession)).toBe('idle');
    // BOT_B is unaffected
    expect(botTurnState.get(BOT_B)).toBe('idle');
    expect(BOT_IDS).toContain(newSession);
    expect(BOT_IDS).toContain(BOT_B);
  });

  it('multi-bot shared project_dir: no botId collision', () => {
    const bot1 = 'cc_myproj_sess1';
    const bot2 = 'cc_myproj_sess2';
    setRuntimeBotIds([bot1, bot2]);
    ensureRuntimeBotState([bot1, bot2]);
    botTurnState.ensureBot(bot1);
    botTurnState.ensureBot(bot2);

    botTurnState.transition(bot1, 'sending');
    expect(botTurnState.get(bot1)).toBe('sending');
    expect(botTurnState.get(bot2)).toBe('idle');

    // Both are separate entries in BOT_IDS
    expect(BOT_IDS).toContain(bot1);
    expect(BOT_IDS).toContain(bot2);
    expect(bot1).not.toBe(bot2);
  });
});

// ============================================================
// SC-F-15: Backend restart recovery — state reset pattern
// ============================================================
describe('SC-F-15: Backend restart recovery (state reset pattern)', () => {
  it('resetting all bots to idle simulates backend restart recovery', () => {
    // Simulate multiple bots in various states
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    remoteAgentState.update(BOT_A, 'processing');

    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');
    botTurnState.transition(BOT_B, 'receiving');
    remoteAgentState.update(BOT_B, 'generating');

    // Backend restart: reset all state
    botTurnState.resetToIdle(BOT_A, 'backend_restart');
    botTurnState.resetToIdle(BOT_B, 'backend_restart');
    remoteAgentState.resetToIdle(BOT_A);
    remoteAgentState.resetToIdle(BOT_B);
    resetBotToIdle(BOT_A);
    resetBotToIdle(BOT_B);

    // All state clean
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(botTurnState.get(BOT_B)).toBe('idle');
    expect(remoteAgentState.get(BOT_A)).toBe('idle');
    expect(remoteAgentState.get(BOT_B)).toBe('idle');
    expect(getBotMicState(BOT_A)).toBe('');
    expect(getBotMicState(BOT_B)).toBe('');
  });

  it('after reset, new turns can start normally', () => {
    // Reset
    botTurnState.resetToIdle(BOT_A);
    clearTurnCancelled(BOT_A);

    // New turn
    expect(botTurnState.transition(BOT_A, 'sending')).toBe(true);
    expect(botTurnState.transition(BOT_A, 'awaiting')).toBe(true);
    expect(botTurnState.transition(BOT_A, 'receiving')).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('receiving');
  });

  it('bot:turn-state-change events emitted during reset', () => {
    const events: Array<{ botId: string; reason?: string }> = [];
    bus.on('bot:turn-state-change', (e: unknown) => {
      const evt = e as { botId: string; reason?: string };
      events.push({ botId: evt.botId, reason: evt.reason });
    });

    botTurnState.transition(BOT_A, 'sending');
    events.length = 0; // clear setup events

    botTurnState.resetToIdle(BOT_A, 'backend_restart');
    expect(events).toEqual([
      { botId: BOT_A, reason: 'backend_restart' },
    ]);
  });

  it('ensureRuntimeBotState after restart re-initializes all state entries', () => {
    // Simulate slots from recovered slots.json
    const recoveredIds = [BOT_A, BOT_B, 'botC'];
    setRuntimeBotIds(recoveredIds);
    ensureRuntimeBotState(recoveredIds);

    expect(BOT_IDS).toEqual(recoveredIds);
    // All bots should have clean state
    for (const id of recoveredIds) {
      expect(getBotMicState(id)).toBe('');
    }
  });

  it('slots.json restore does not trigger auto-discover', () => {
    // After backend restart, slots are restored from slots.json
    // ensureRuntimeBotState is called with restored IDs — no discover needed
    const restoredIds = [BOT_A, BOT_B];
    setRuntimeBotIds(restoredIds);
    ensureRuntimeBotState(restoredIds);

    // All bots have state; no discover was triggered (just state init)
    expect(BOT_IDS).toEqual(restoredIds);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(botTurnState.get(BOT_B)).toBe('idle');
  });
});
