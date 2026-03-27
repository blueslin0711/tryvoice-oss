// @vitest-environment jsdom
/**
 * INV-WW-01: Wakeword mechanism tests.
 *
 * INV-WW-01: Cancel word fires ONLY when micState.isActive || audioPlayer.state !== 'idle'.
 *            NOT during processing/awaiting/receiving states.
 * ISSUE-13:  Verified fixed — _cwShouldCheck condition uses audioPlayer.state only,
 *            no longer references botTurnState.
 *
 * NOTE: INV-WW-02 (echo self-suppression) is deprecated per EXPERIENCE_SPEC.md line 13.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupTestBots, teardownTest, BOT_A, BOT_B } from './helpers/test-setup';
import * as fs from 'fs';
import * as path from 'path';

import { micState } from '../state/mic-state';
import { botTurnState, type BotTurnStateValue } from '../state/bot-turn-state';

// Mock audioPlayer — module-level singleton.
// vi.mock is hoisted, so the factory must be self-contained (no external refs).
vi.mock('../audio/audio-player', () => ({
  audioPlayer: {
    state: 'idle',
    stop: vi.fn(),
    getAudioContext: vi.fn(() => ({ state: 'running', resume: vi.fn() })),
    pause: vi.fn(),
    resume: vi.fn(),
  },
}));

// Import audioPlayer AFTER the mock so the mock is in effect.
import { audioPlayer } from '../audio/audio-player';

/**
 * Replicates the cancel-word visibility condition from EXPERIENCE_SPEC INV-WW-01:
 *   micState.isActive || audioPlayer.state !== 'idle'
 */
function deriveCancelVisible(): boolean {
  return micState.isActive || audioPlayer.state !== 'idle';
}

beforeEach(() => {
  setupTestBots(BOT_A, BOT_B);
  (audioPlayer as Record<string, unknown>).state = 'idle';
});
afterEach(() => teardownTest());

// ============================================================
// INV-WW-01: Cancel word condition
// ============================================================
describe('INV-WW-01: Cancel word effective ONLY when recording OR speaking/paused', () => {
  // --- Positive cases: cancel word SHOULD fire ---

  it('mic acquiring (recording initiated) -> cancel visible', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    expect(micState.isActive).toBe(true);
    expect(deriveCancelVisible()).toBe(true);
  });

  it('mic recording (actively capturing audio) -> cancel visible', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    expect(micState.state).toBe('recording');
    expect(micState.isActive).toBe(true);
    expect(deriveCancelVisible()).toBe(true);
  });

  it('mic stopping (wind-down, still active) -> cancel visible', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    micState.setStopping();
    expect(micState.state).toBe('stopping');
    expect(micState.isActive).toBe(true);
    expect(deriveCancelVisible()).toBe(true);
  });

  it('mic saving (still active until idle) -> cancel visible', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    micState.setStopping();
    micState.setSaving();
    expect(micState.isActive).toBe(true);
    expect(deriveCancelVisible()).toBe(true);
  });

  it('audioPlayer playing (TTS playback) -> cancel visible', () => {
    (audioPlayer as Record<string, unknown>).state = 'playing';
    expect(micState.isActive).toBe(false);
    expect(deriveCancelVisible()).toBe(true);
  });

  it('audioPlayer paused -> cancel visible (paused is non-idle)', () => {
    (audioPlayer as Record<string, unknown>).state = 'paused';
    expect(deriveCancelVisible()).toBe(true);
  });

  it('both mic active AND audioPlayer playing -> cancel visible', () => {
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    (audioPlayer as Record<string, unknown>).state = 'playing';
    expect(deriveCancelVisible()).toBe(true);
  });

  // --- Negative cases: cancel word must NOT fire ---

  it('mic idle + audioPlayer idle -> cancel NOT visible', () => {
    expect(micState.isActive).toBe(false);
    expect(audioPlayer.state).toBe('idle');
    expect(deriveCancelVisible()).toBe(false);
  });

  it('botTurnState awaiting (processing) with mic idle + audioPlayer idle -> cancel NOT visible', () => {
    // Core ISSUE-13 scenario: bot is processing but nothing audible/recording.
    // Only manual abort button can interrupt processing, not cancel word.
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    expect(botTurnState.get(BOT_A)).toBe('awaiting');
    expect(deriveCancelVisible()).toBe(false);
  });

  it('botTurnState receiving with mic idle + audioPlayer idle -> cancel NOT visible', () => {
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    expect(botTurnState.get(BOT_A)).toBe('receiving');
    expect(deriveCancelVisible()).toBe(false);
  });

  it('botTurnState sending with mic idle + audioPlayer idle -> cancel NOT visible', () => {
    botTurnState.transition(BOT_A, 'sending');
    expect(botTurnState.get(BOT_A)).toBe('sending');
    expect(deriveCancelVisible()).toBe(false);
  });

  // --- Lifecycle tracking ---

  it('full mic lifecycle: cancel visible throughout active states, then disappears at idle', () => {
    // acquiring
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    expect(deriveCancelVisible()).toBe(true);

    // recording
    micState.setRecording();
    expect(deriveCancelVisible()).toBe(true);

    // stopping
    micState.setStopping();
    expect(deriveCancelVisible()).toBe(true);

    // saving
    micState.setSaving();
    expect(deriveCancelVisible()).toBe(true);

    // idle — no longer active
    micState.setIdle();
    expect(deriveCancelVisible()).toBe(false);
  });

  it('audioPlayer state transitions: cancel tracks playing/paused vs idle', () => {
    expect(deriveCancelVisible()).toBe(false); // idle

    (audioPlayer as Record<string, unknown>).state = 'playing';
    expect(deriveCancelVisible()).toBe(true);

    (audioPlayer as Record<string, unknown>).state = 'paused';
    expect(deriveCancelVisible()).toBe(true);

    (audioPlayer as Record<string, unknown>).state = 'idle';
    expect(deriveCancelVisible()).toBe(false);
  });

  it('all processing states without mic/audio -> none are cancel-visible', () => {
    // Per spec: only manual abort button interrupts processing.
    const processingPaths: string[][] = [
      ['sending'],
      ['sending', 'awaiting'],
      ['sending', 'awaiting', 'receiving'],
    ];

    for (const transitions of processingPaths) {
      botTurnState._reset();
      botTurnState.ensureBot(BOT_A);
      for (const to of transitions) {
        botTurnState.transition(BOT_A, to as BotTurnStateValue);
      }
      expect(deriveCancelVisible()).toBe(false);
    }
  });

  it('cancel visible is independent per bot — only depends on shared mic/audioPlayer', () => {
    // micState and audioPlayer are global singletons, not per-bot.
    // Setting bot B to awaiting should not affect cancel visibility.
    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');
    expect(deriveCancelVisible()).toBe(false);

    // Start recording for bot A — cancel becomes visible
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    expect(deriveCancelVisible()).toBe(true);

    // Bot B still awaiting, doesn't matter
    expect(botTurnState.get(BOT_B)).toBe('awaiting');
    expect(deriveCancelVisible()).toBe(true);
  });
});

// ============================================================
// ISSUE-13: Verify the source code fix
// ============================================================
describe('ISSUE-13: _cwShouldCheck condition must use audioPlayer.state only, not botTurnState', () => {
  it('_cwShouldCheck uses audioPlayer.state !== idle, no botTurnState reference', () => {
    const srcPath = path.resolve(__dirname, '../wakeword/wakeword-manager.ts');
    const src = fs.readFileSync(srcPath, 'utf-8');

    // Extract the _cwShouldCheck assignment
    const match = src.match(/const _cwShouldCheck = (.+);/);
    expect(match).not.toBeNull();

    const condition = match![1];

    // FIXED condition must reference audioPlayer.state
    expect(condition).toContain('audioPlayer.state');

    // FIXED condition must NOT reference botTurnState or any turn-related variable
    expect(condition).not.toContain('botTurn');
    expect(condition).not.toContain('_cwBotTurn');
    expect(condition).not.toContain('_owwBotTurn');
    expect(condition).not.toContain('turn');
  });

  it('ISSUE-13 fix is documented in a comment near _cwShouldCheck', () => {
    const srcPath = path.resolve(__dirname, '../wakeword/wakeword-manager.ts');
    const src = fs.readFileSync(srcPath, 'utf-8');

    const lines = src.split('\n');
    const condLine = lines.findIndex(l => l.includes('const _cwShouldCheck'));
    expect(condLine).toBeGreaterThan(0);

    // Check surrounding lines (5 lines before) for ISSUE-13 reference
    const context = lines.slice(Math.max(0, condLine - 5), condLine + 1).join('\n');
    expect(context).toContain('ISSUE-13');
  });

  it('old buggy condition (botTurn !== idle && botTurn !== listening) is absent from _cwShouldCheck', () => {
    const srcPath = path.resolve(__dirname, '../wakeword/wakeword-manager.ts');
    const src = fs.readFileSync(srcPath, 'utf-8');

    const match = src.match(/const _cwShouldCheck = (.+);/);
    expect(match).not.toBeNull();

    const condition = match![1];

    // The FIXED condition should be exactly `audioPlayer.state !== 'idle'`
    // The old buggy condition was: `audioPlayer.state !== 'idle' || (botTurn !== 'idle' && botTurn !== 'listening')`
    // Verify it's the simple form with no || operator (no second disjunct)
    expect(condition.trim()).toBe("audioPlayer.state !== 'idle'");

    // Double-check: no botTurn reference anywhere in the condition
    expect(condition).not.toContain('botTurn');
    expect(condition).not.toContain('listening');
  });
});

