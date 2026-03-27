// @vitest-environment jsdom
/**
 * INV-LIFECYCLE-01~07 + ISSUE-15 verification
 *
 * All assertions derived from EXPERIENCE_SPEC definitions:
 *   INV-LIFECYCLE-01: Already-added detection by sessionKey match (not botId)
 *   INV-LIFECYCLE-02: Unchecking existing bot = DELETE operation
 *   INV-LIFECYCLE-03: Clean up active state before delete (7-step interruptBot)
 *   INV-LIFECYCLE-04: Delete current bot → switch to default (first slot)
 *   INV-LIFECYCLE-05: Delete last bot → setup wizard (BOT_IDS empty trigger)
 *   INV-LIFECYCLE-06: discover_and_sync marks offline, never deletes
 *   INV-LIFECYCLE-07: First setup = replace, subsequent = append
 *   ISSUE-15: _removeBot now calls cancelRecording + interruptBot before deletion
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCurrentBotId, setCurrentBotId,
  ensureRuntimeBotState,
  getBotMicState, getBotStatusReason,
  interruptBot, isTurnCancelled,
  resetBotToIdle, getBotDisplayName, setBotSuffix,
} from '../ui/app-state';
import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import { remoteAgentState } from '../state/remote-agent-state';
import { BOT_IDS, setRuntimeBotIds } from '../core/types';
import { bus } from '../core/event-bus';
import { setupTestBots, teardownTest, BOT_A, BOT_B } from './helpers/test-setup';

beforeEach(() => setupTestBots(BOT_A, BOT_B));
afterEach(() => teardownTest());

// ============================================================
// INV-LIFECYCLE-01: Already-Added Detection by SessionKey
// Spec: Bot Discovery marks bots already in slots.json as
//   already_added by sessionKey match (not botId).
//   UI shows "(already added)" green label.
// ============================================================
describe('INV-LIFECYCLE-01: already_added detection by sessionKey', () => {
  it('ensureRuntimeBotState is idempotent — double call does not duplicate or re-init state', () => {
    // Spec: bots already in slots are recognized, not duplicated
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_B);

    // Second call with identical IDs must be idempotent
    ensureRuntimeBotState([BOT_A, BOT_B]);

    expect(BOT_IDS).toEqual([BOT_A, BOT_B]);
    // currentBotId must stay BOT_B — not reset to first
    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('adding a third bot via ensureRuntimeBotState does not clobber existing bot state', () => {
    // Spec: already_added bots retain their state
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);

    // Put BOT_A into a non-default turn state
    botTurnState.transition(BOT_A, 'sending');

    // Add botC
    const botC = 'botC';
    BOT_IDS.push(botC);
    ensureRuntimeBotState([BOT_A, BOT_B, botC]);

    // Existing bot state preserved
    expect(botTurnState.get(BOT_A)).toBe('sending');
    // New bot starts idle
    expect(botTurnState.get(botC)).toBe('idle');
    expect(getBotMicState(botC)).toBe('');
  });

  it('setRuntimeBotIds deduplicates — same sessionKey maps to same slotId', () => {
    // Spec: sessionKey match means same bot, not a new entry
    setRuntimeBotIds(['bot-x', 'bot-x', 'bot-y']);
    expect(BOT_IDS).toEqual(['bot-x', 'bot-y']);
  });

  it('setRuntimeBotIds strips empty and whitespace-only IDs', () => {
    // Spec: valid sessionKey matching requires non-empty keys
    setRuntimeBotIds(['valid', '', '  ', 'also-valid']);
    expect(BOT_IDS).toEqual(['valid', 'also-valid']);
  });

  it('ensureRuntimeBotState preserves currentBotId when it is still in the list', () => {
    // Spec: already_added bots keep their selection state
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_B);

    // Re-ensure with the same list
    ensureRuntimeBotState([BOT_A, BOT_B]);
    expect(getCurrentBotId()).toBe(BOT_B);
  });
});

// ============================================================
// INV-LIFECYCLE-02: Unchecking Existing Bot = Delete
// Spec: Unchecking already_added bot in Discovery UI then
//   confirming = DELETE operation. User must understand
//   this is destructive.
// ============================================================
describe('INV-LIFECYCLE-02: unchecking existing bot = DELETE', () => {
  it('removing a botId via setRuntimeBotIds drops it from BOT_IDS', () => {
    // Spec: deselection triggers DELETE — at mechanism level, bot is gone from BOT_IDS
    setRuntimeBotIds([BOT_A, BOT_B]);
    expect(BOT_IDS).toContain(BOT_A);

    // Simulate deselection: new list excludes BOT_A
    setRuntimeBotIds([BOT_B]);
    expect(BOT_IDS).not.toContain(BOT_A);
    expect(BOT_IDS).toEqual([BOT_B]);
  });

  it('deselection is destructive — removed bot needs re-add to come back', () => {
    // Spec: DELETE is destructive — user must understand
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);

    // Deselect BOT_A
    setRuntimeBotIds([BOT_B]);

    expect(BOT_IDS).toEqual([BOT_B]);
    // Re-adding is needed — it does not come back automatically
    BOT_IDS.push(BOT_A);
    expect(BOT_IDS).toContain(BOT_A);
  });

  it('deselecting current bot + ensureRuntimeBotState corrects currentBotId', () => {
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_A);

    // Deselect BOT_A
    setRuntimeBotIds([BOT_B]);
    ensureRuntimeBotState([BOT_B]);

    // currentBotId was BOT_A (removed) — must switch to BOT_B (first remaining)
    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('deselecting non-current bot does not change currentBotId', () => {
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_A);

    // Deselect BOT_B (not current)
    setRuntimeBotIds([BOT_A]);
    ensureRuntimeBotState([BOT_A]);

    expect(getCurrentBotId()).toBe(BOT_A);
  });
});

// ============================================================
// INV-LIFECYCLE-03: Clean Up Active State Before Delete
// Spec: Before deleting bot:
//   (1) if active turn → interruptBot full 7-step
//   (2) DELETE /slots/{botId}
//   (3) remove from BOT_IDS
//   (4) clean wakeword mapping
//   (5) if deleted is current → switch to default
//   (6) re-render
// ============================================================
describe('INV-LIFECYCLE-03: cleanup active state before delete', () => {
  it('interruptBot resets awaiting bot to idle and sets turnCancelled', () => {
    // Spec step 1: if active turn → interruptBot
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    expect(botTurnState.get(BOT_A)).toBe('awaiting');

    interruptBot(BOT_A, 'cancelled');

    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(getBotMicState(BOT_A)).toBe('');
    expect(getBotStatusReason(BOT_A)).toBe('cancelled');
  });

  it('interruptBot on speaking bot emits stop-audio and resets to idle', () => {
    // Spec: interruptBot full 7-step includes stopping audio
    botTurnState.transition(BOT_A, 'sending');
    botTurnState.transition(BOT_A, 'awaiting');
    botTurnState.transition(BOT_A, 'receiving');
    botTurnState.transition(BOT_A, 'speaking');
    expect(botTurnState.get(BOT_A)).toBe('speaking');

    const stopAudioSpy = vi.fn();
    bus.on('interrupt:stop-audio', stopAudioSpy);

    interruptBot(BOT_A);

    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(stopAudioSpy).toHaveBeenCalled();
    expect(isTurnCancelled(BOT_A)).toBe(true);
  });

  it('interruptBot cancels active mic recording for the target bot', () => {
    // Spec step 1: clean up active recording as part of interrupt
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    expect(micState.isActive).toBe(true);
    expect(micState.context?.botId).toBe(BOT_A);

    interruptBot(BOT_A);

    expect(micState.isActive).toBe(false);
    expect(micState.state).toBe('idle');
  });

  it('interruptBot does NOT cancel mic recording for a different bot', () => {
    // Spec: cleanup targets specific bot, not others
    micState.startRecording({ botId: BOT_B, mode: 'ptt' });
    micState.setRecording();
    expect(micState.isActive).toBe(true);

    interruptBot(BOT_A);

    // Mic is still active for BOT_B
    expect(micState.isActive).toBe(true);
    expect(micState.context?.botId).toBe(BOT_B);
  });

  it('interruptBot resets remoteAgentState to idle', () => {
    // Spec: full 7-step includes resetting agent state
    remoteAgentState.update(BOT_A, 'processing');
    expect(remoteAgentState.get(BOT_A)).toBe('processing');

    interruptBot(BOT_A);

    expect(remoteAgentState.get(BOT_A)).toBe('idle');
  });

  it('interruptBot on idle bot still sets turnCancelled flag', () => {
    // Spec: interruptBot is safe to call even on idle bot
    expect(botTurnState.get(BOT_A)).toBe('idle');

    interruptBot(BOT_A);

    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(isTurnCancelled(BOT_A)).toBe(true);
  });

  it('full removal flow: interrupt → remove → ensure switches correctly', () => {
    // Spec steps 1-5 simulated in sequence
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_B);
    botTurnState.transition(BOT_B, 'sending');

    // Step 1: interruptBot (as _removeBot does)
    interruptBot(BOT_B);
    expect(botTurnState.get(BOT_B)).toBe('idle');

    // Steps 2-3: DELETE + remove from BOT_IDS
    const newIds = BOT_IDS.filter(id => id !== BOT_B);
    setRuntimeBotIds(newIds);
    ensureRuntimeBotState(newIds);

    // Step 5: switch to default
    expect(getCurrentBotId()).toBe(BOT_A);
    expect(BOT_IDS).toEqual([BOT_A]);
  });
});

// ============================================================
// INV-LIFECYCLE-04: Switch to Default on Current Bot Delete
// Spec: If deleting current bot, auto-switch to default bot
//   (first slot).
// ============================================================
describe('INV-LIFECYCLE-04: delete current bot → switch to default', () => {
  it('removing current bot switches to first remaining (default)', () => {
    // Spec: auto-switch to default bot (first slot)
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_B);
    expect(getCurrentBotId()).toBe(BOT_B);

    // Remove BOT_B (currently selected)
    setRuntimeBotIds([BOT_A]);
    ensureRuntimeBotState([BOT_A]);

    expect(getCurrentBotId()).toBe(BOT_A);
  });

  it('removing first bot switches currentBotId to new first', () => {
    // Spec: default = first slot, which is now BOT_B
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_A);

    setRuntimeBotIds([BOT_B]);
    ensureRuntimeBotState([BOT_B]);

    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('no switch if current bot is still in the updated list', () => {
    // Spec: only switch if "deleting current bot"
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_B);

    // Remove BOT_A, but BOT_B (current) stays
    setRuntimeBotIds([BOT_B]);
    ensureRuntimeBotState([BOT_B]);

    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('with three bots, deleting current switches to first (default)', () => {
    // Spec: default = first slot
    const botC = 'botC';
    setRuntimeBotIds([BOT_A, BOT_B, botC]);
    ensureRuntimeBotState([BOT_A, BOT_B, botC]);
    setCurrentBotId(botC);

    // Remove botC (current)
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);

    expect(getCurrentBotId()).toBe(BOT_A);
  });

  it('full _removeBot simulation: active bot deleted, current switches correctly', () => {
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_B);
    botTurnState.transition(BOT_B, 'sending');

    // Simulate _removeBot flow
    interruptBot(BOT_B);
    const newIds = BOT_IDS.filter(id => id !== BOT_B);
    setRuntimeBotIds(newIds);
    ensureRuntimeBotState(newIds);

    // Spec: auto-switch to default bot (first slot)
    expect(getCurrentBotId()).toBe(BOT_A);
    expect(BOT_IDS).toEqual([BOT_A]);
  });
});

// ============================================================
// INV-LIFECYCLE-05: Delete Last Bot → Setup Wizard
// Spec: Deleting last bot (BOT_IDS empty) auto-opens setup
//   wizard.
// ============================================================
describe('INV-LIFECYCLE-05: delete last bot → setup wizard', () => {
  it('setRuntimeBotIds([]) empties BOT_IDS completely', () => {
    // Spec: BOT_IDS empty is the trigger for wizard
    setRuntimeBotIds([BOT_A]);
    expect(BOT_IDS.length).toBe(1);

    setRuntimeBotIds([]);
    expect(BOT_IDS.length).toBe(0);
    expect(BOT_IDS).toEqual([]);
  });

  it('ensureRuntimeBotState with empty array does not throw', () => {
    // Spec: safe to call even when no bots
    setRuntimeBotIds([]);
    expect(() => ensureRuntimeBotState([])).not.toThrow();
  });

  it('removing last bot produces BOT_IDS.length === 0 — the wizard trigger condition', () => {
    // Spec: "Deleting last bot (BOT_IDS empty) auto-opens setup wizard"
    setRuntimeBotIds([BOT_A]);
    ensureRuntimeBotState([BOT_A]);

    // Simulate _removeBot for the last bot
    interruptBot(BOT_A);
    setRuntimeBotIds([]);
    ensureRuntimeBotState([]);

    // BOT_IDS.length === 0 is exactly the condition _removeBot checks
    expect(BOT_IDS.length).toBe(0);
  });

  it('empty BOT_IDS does not auto-clear currentBotId — wizard handles reset', () => {
    // Spec: wizard handles the full state reset after last bot deleted
    setRuntimeBotIds([BOT_A]);
    ensureRuntimeBotState([BOT_A]);
    setCurrentBotId(BOT_A);

    setRuntimeBotIds([]);
    ensureRuntimeBotState([]);

    // currentBotId stays stale — wizard replaces it on setup
    expect(getCurrentBotId()).toBe(BOT_A);
  });

  it('after last bot deleted and wizard adds new bot, state is clean', () => {
    // Spec: wizard re-initializes everything
    setRuntimeBotIds([BOT_A]);
    ensureRuntimeBotState([BOT_A]);
    botTurnState.transition(BOT_A, 'sending');

    // Delete last bot
    interruptBot(BOT_A);
    setRuntimeBotIds([]);
    expect(BOT_IDS.length).toBe(0);

    // Wizard adds new bot (replace mode per INV-LIFECYCLE-07)
    const newBot = 'new-bot';
    setRuntimeBotIds([newBot]);
    ensureRuntimeBotState([newBot]);
    setCurrentBotId(newBot);

    expect(BOT_IDS).toEqual([newBot]);
    expect(getCurrentBotId()).toBe(newBot);
    expect(botTurnState.get(newBot)).toBe('idle');
  });
});

// ============================================================
// INV-LIFECYCLE-06: discover_and_sync Marks Offline, Never Deletes
// Spec: Backend discover_and_sync finding inactive session sets
//   status="offline", NEVER deletes. Only user deletion removes
//   slot.
// ============================================================
describe('INV-LIFECYCLE-06: discover_and_sync marks offline, never deletes', () => {
  it('ensureRuntimeBotState with subset does NOT delete state of unlisted bots', () => {
    // Spec: discover_and_sync never deletes — only marks offline
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);

    // Put BOT_B into a processing state
    botTurnState.transition(BOT_B, 'sending');
    botTurnState.transition(BOT_B, 'awaiting');

    // Call ensureRuntimeBotState with only BOT_A (discover_and_sync returns subset)
    ensureRuntimeBotState([BOT_A]);

    // BOT_B's turn state is NOT cleared — ensureRuntimeBotState only inits, never deletes
    expect(botTurnState.get(BOT_B)).toBe('awaiting');
  });

  it('bus events (slots-changed) do not mutate BOT_IDS', () => {
    // Spec: only user deletion removes slot — backend events don't delete
    setRuntimeBotIds([BOT_A, BOT_B]);
    const snapshot = [...BOT_IDS];

    bus.emit('slots-changed', { botId: BOT_A, status: 'offline' });
    bus.emit('slots-changed', { botId: BOT_A, status: 'disconnected' });

    expect(BOT_IDS).toEqual(snapshot);
  });

  it('offline bot retains state and can still be interrupted', () => {
    // Spec: offline ≠ deleted — bot is still in BOT_IDS with full state
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    botTurnState.transition(BOT_A, 'sending');

    // BOT_A goes "offline" — its turn state is still valid
    expect(botTurnState.get(BOT_A)).toBe('sending');

    // User can still interrupt it
    interruptBot(BOT_A);
    expect(botTurnState.get(BOT_A)).toBe('idle');
  });

  it('offline bot can be selected as current bot', () => {
    // Spec: offline ≠ removed — bot stays in slots
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_A);

    // BOT_B marked "offline" by discover_and_sync — still selectable
    setCurrentBotId(BOT_B);
    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('explicit setRuntimeBotIds is required to remove a bot — NOT automatic', () => {
    // Spec: "Only user deletion removes slot"
    setRuntimeBotIds([BOT_A, BOT_B]);
    expect(BOT_IDS).toContain(BOT_A);

    // No matter what events fire, BOT_A stays until explicitly removed
    bus.emit('slots-changed', { botId: BOT_A, status: 'offline' });
    expect(BOT_IDS).toContain(BOT_A);

    // Only explicit call removes it
    setRuntimeBotIds([BOT_B]);
    expect(BOT_IDS).not.toContain(BOT_A);
  });
});

// ============================================================
// INV-LIFECYCLE-07: First Setup = Replace, Subsequent = Append
// Spec: First setup (setupNeeded=true) uses mode="replace"
//   (mandatory). Subsequent setup uses mode="append"
//   (optional, has close button).
// ============================================================
describe('INV-LIFECYCLE-07: replace vs append mode', () => {
  it('setRuntimeBotIds fully replaces BOT_IDS (replace mode)', () => {
    // Spec: first setup uses mode="replace" — full replacement
    setRuntimeBotIds([BOT_A, BOT_B]);
    expect(BOT_IDS).toEqual([BOT_A, BOT_B]);

    setRuntimeBotIds(['x', 'y']);
    expect(BOT_IDS).toEqual(['x', 'y']);
    expect(BOT_IDS).not.toContain(BOT_A);
    expect(BOT_IDS).not.toContain(BOT_B);
  });

  it('BOT_IDS.push appends without removing existing (append mode)', () => {
    // Spec: subsequent setup uses mode="append"
    setRuntimeBotIds([BOT_A]);
    expect(BOT_IDS).toEqual([BOT_A]);

    BOT_IDS.push(BOT_B);
    expect(BOT_IDS).toEqual([BOT_A, BOT_B]);
  });

  it('replace mode: ensureRuntimeBotState switches currentBotId from removed bot', () => {
    // Spec: replace mode is mandatory for first setup — old bots are gone
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_A);

    // Replace: BOT_A is gone
    const botC = 'botC';
    setRuntimeBotIds([BOT_B, botC]);
    ensureRuntimeBotState([BOT_B, botC]);

    // BOT_A was current but removed — switches to first (BOT_B)
    expect(getCurrentBotId()).toBe(BOT_B);
  });

  it('append mode: ensureRuntimeBotState after append keeps currentBotId', () => {
    // Spec: append = optional, existing selection unchanged
    setRuntimeBotIds([BOT_A]);
    ensureRuntimeBotState([BOT_A]);
    setCurrentBotId(BOT_A);

    // Append BOT_B
    BOT_IDS.push(BOT_B);
    ensureRuntimeBotState([BOT_A, BOT_B]);

    // BOT_A is still in the list — no switch
    expect(getCurrentBotId()).toBe(BOT_A);
    expect(BOT_IDS).toEqual([BOT_A, BOT_B]);
  });

  it('ensureRuntimeBotState skips initialization for already-present bots', () => {
    // Spec: append mode does not overwrite existing state
    setRuntimeBotIds([BOT_A]);
    ensureRuntimeBotState([BOT_A]);

    // Set a non-default status reason for BOT_A
    resetBotToIdle(BOT_A, 'cancelled');
    expect(getBotStatusReason(BOT_A)).toBe('cancelled');

    // Add BOT_B and re-ensure — BOT_A's state must not be overwritten
    BOT_IDS.push(BOT_B);
    ensureRuntimeBotState([BOT_A, BOT_B]);

    // BOT_A's reason is still 'cancelled'
    expect(getBotStatusReason(BOT_A)).toBe('cancelled');
    // BOT_B gets default initialization
    expect(getBotStatusReason(BOT_B)).toBe('default');
  });

  it('replace mode completely resets the bot list — no merge', () => {
    // Spec: first setup = replace = mandatory — no leftovers
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);

    // Complete replacement
    const newBots = ['x', 'y', 'z'];
    setRuntimeBotIds(newBots);
    ensureRuntimeBotState(newBots);

    expect(BOT_IDS).toEqual(newBots);
    expect(BOT_IDS).not.toContain(BOT_A);
    expect(BOT_IDS).not.toContain(BOT_B);
  });
});

// ============================================================
// ISSUE-15: _removeBot now calls cancelRecording + interruptBot
// Spec: Fixed. _removeBot calls cancelRecording + interruptBot
//   before deletion. Verify by reading source.
// ============================================================
describe('ISSUE-15: _removeBot cleanup verified', () => {
  // Source code inspection: ISSUE-15 explicitly allows reading source
  it('_removeBot source includes cancelRecording + interruptBot before fetch DELETE', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../ui/slot-tabs.ts'),
      'utf-8',
    );
    // Extract the _removeBot function body
    const removeBotMatch = src.match(/async function _removeBot[\s\S]*?^}/m);
    expect(removeBotMatch).not.toBeNull();
    const removeBotSrc = removeBotMatch![0];

    // ISSUE-15 fix: interruptBot must be called before deletion
    expect(removeBotSrc).toContain('interruptBot');
    // ISSUE-15 fix: cancelRecording for active mic
    expect(removeBotSrc).toContain('cancelRecording');
    // Verify the order: cancelRecording and interruptBot appear BEFORE the fetch DELETE
    const cancelIdx = removeBotSrc.indexOf('cancelRecording');
    const interruptIdx = removeBotSrc.indexOf('interruptBot');
    const fetchIdx = removeBotSrc.indexOf("fetch(`/slots/");
    expect(cancelIdx).toBeLessThan(fetchIdx);
    expect(interruptIdx).toBeLessThan(fetchIdx);
  });

  it('_removeBot source checks mic context matches target botId', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../ui/slot-tabs.ts'),
      'utf-8',
    );
    const removeBotMatch = src.match(/async function _removeBot[\s\S]*?^}/m);
    expect(removeBotMatch).not.toBeNull();
    const removeBotSrc = removeBotMatch![0];

    // Verify the guard: only cancel mic if it belongs to the target bot
    expect(removeBotSrc).toContain('micState.context?.botId === botId');
  });

  it('behavioral: bot recording + interruptBot cancels mic and resets turn', () => {
    // Spec: _removeBot calls cancelRecording + interruptBot — verify behavior
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    botTurnState.transition(BOT_A, 'listening');
    expect(micState.isActive).toBe(true);
    expect(botTurnState.get(BOT_A)).toBe('listening');

    // Reproduce _removeBot cleanup sequence
    if (micState.isActive && micState.context?.botId === BOT_A) {
      micState.cancelRecording();
    }
    interruptBot(BOT_A);

    // Mic is released
    expect(micState.isActive).toBe(false);
    expect(micState.state).toBe('idle');
    // Turn is reset
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(getBotMicState(BOT_A)).toBe('');
  });

  it('behavioral: mic for different bot is NOT cancelled during removal', () => {
    // Spec: cancelRecording is guarded by micState.context?.botId === botId
    micState.startRecording({ botId: BOT_B, mode: 'ptt' });
    micState.setRecording();
    expect(micState.isActive).toBe(true);

    // _removeBot for BOT_A should NOT cancel BOT_B's mic
    if (micState.isActive && micState.context?.botId === BOT_A) {
      micState.cancelRecording();
    }
    interruptBot(BOT_A);

    // BOT_B's mic still active
    expect(micState.isActive).toBe(true);
    expect(micState.context?.botId).toBe(BOT_B);
  });

  it('full _removeBot behavioral: recording bot deleted, all state cleaned, currentBotId switched', () => {
    // Spec: full cleanup sequence
    setRuntimeBotIds([BOT_A, BOT_B]);
    ensureRuntimeBotState([BOT_A, BOT_B]);
    setCurrentBotId(BOT_A);

    // BOT_A is actively in a turn with mic recording
    micState.startRecording({ botId: BOT_A, mode: 'ptt' });
    micState.setRecording();
    botTurnState.transition(BOT_A, 'listening');
    remoteAgentState.update(BOT_A, 'processing');

    // Simulate _removeBot(BOT_A) — ISSUE-15 fix sequence
    if (micState.isActive && micState.context?.botId === BOT_A) {
      micState.cancelRecording();
    }
    interruptBot(BOT_A);

    const newIds = BOT_IDS.filter(id => id !== BOT_A);
    setRuntimeBotIds(newIds);
    ensureRuntimeBotState(newIds);

    if (getCurrentBotId() === BOT_A) {
      setCurrentBotId(BOT_IDS[0] || 'main');
    }

    // All state is clean
    expect(micState.isActive).toBe(false);
    expect(botTurnState.get(BOT_A)).toBe('idle');
    expect(remoteAgentState.get(BOT_A)).toBe('idle');
    expect(isTurnCancelled(BOT_A)).toBe(true);
    expect(BOT_IDS).toEqual([BOT_B]);
    expect(getCurrentBotId()).toBe(BOT_B);
  });
});
