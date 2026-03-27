/**
 * Shared test helpers for invariant test suite (V2).
 *
 * Provides:
 *   - Unit test setup (setupTestBots / teardownTest)
 *   - Integration test setup (wireRealEventHandlers, wireRealMicSync, etc.)
 *   - Browser API mocks (AudioContext, speechSynthesis, fetch, IDB)
 *   - WS message factory and event sequence helpers
 */
import { vi } from 'vitest';
import { micState } from '../../state/mic-state';
import { botTurnState } from '../../state/bot-turn-state';
import { remoteAgentState } from '../../state/remote-agent-state';
import { bus } from '../../core/event-bus';
import { BOT_IDS } from '../../core/types';
import {
  resetBotToIdle, clearTurnCancelled, ensureRuntimeBotState,
  setCurrentBotId,
} from '../../ui/app-state';
import { chatStore } from '../../store/chat-store';
import { setLogLevel, flush as flushLogBuffer } from '../../logging/logger';

export const BOT_A = 'botA';
export const BOT_B = 'botB';

// ============================================================
// Unit test setup (lightweight, no handler wiring)
// ============================================================

/**
 * Standard beforeEach: fake timers, reset all state layers,
 * ensure bots exist, clear event bus, suppress log noise.
 */
export function setupTestBots(...botIds: string[]): void {
  vi.useFakeTimers();
  micState._reset();
  botTurnState._reset();
  remoteAgentState._reset();
  // Populate BOT_IDS so ensureRuntimeBotState works
  BOT_IDS.length = 0;
  for (const id of botIds) BOT_IDS.push(id);
  ensureRuntimeBotState(botIds);
  for (const id of botIds) {
    resetBotToIdle(id);
    clearTurnCancelled(id);
    botTurnState.ensureBot(id);
    remoteAgentState.ensureBot(id);
  }
  if (botIds.length > 0) setCurrentBotId(botIds[0]);
  bus.removeAll();
  setLogLevel('error');
  flushLogBuffer();
}

/**
 * Standard afterEach: restore mocks + real timers.
 */
export function teardownTest(): void {
  vi.restoreAllMocks();
  vi.useRealTimers();
}

// ============================================================
// Integration test setup (wires REAL handlers from source modules)
// ============================================================

// Track whether handlers are wired so we don't double-bind
let _eventHandlersWired = false;
let _micSyncWired = false;

/**
 * Wire the REAL event-wiring handlers (badge, TTS, delivery status, cancel-reply).
 *
 * NOTE: event-wiring.ts imports DOM-dependent modules (chat-renderer, mic-ui).
 * These must be mocked BEFORE calling this function. Use mockBrowserAPIs() first,
 * then vi.mock the DOM modules:
 *
 *   vi.mock('../../ui/chat-renderer', () => ({
 *     renderChat: vi.fn(),
 *     addBotMsg: vi.fn(),
 *     autoReadUnreadN: vi.fn(),
 *     updateDeliveryStatusDOM: vi.fn(),
 *     scrollToReadingIfNeeded: vi.fn(),
 *     updatePlayButtons: vi.fn(),
 *   }));
 *   vi.mock('../../ui/mic-ui', () => ({
 *     setCancelReplyActive: vi.fn(),
 *     setVoiceRipple: vi.fn(),
 *     playVoiceFeedback: vi.fn(),
 *     updateBadges: vi.fn(),
 *   }));
 *
 * Then call wireRealEventHandlers().
 */
export async function wireRealEventHandlers(): Promise<void> {
  if (_eventHandlersWired) return;
  const ew = await import('../../ui/event-wiring');
  // bindAudioStateEvents needs a transcript element
  const transcript = document.createElement('div');
  transcript.id = 'transcript';
  document.body.appendChild(transcript);
  ew.bindAudioStateEvents(transcript);
  ew.bindChatStoreChanged();
  _eventHandlersWired = true;
}

/**
 * Wire the REAL wireMicSync (MicState → BotTurnState bridging).
 * This connects mic state changes to bot turn state transitions.
 */
export async function wireRealMicSync(): Promise<void> {
  if (_micSyncWired) return;
  const { wireMicSync } = await import('../../state/bot-turn-state');
  wireMicSync();
  _micSyncWired = true;
}

/**
 * Wire the REAL ws-dispatcher. Returns the onWsMessage handler.
 *
 * NOTE: ws-dispatcher imports ws-client (network). Mock ws-client.send() first:
 *   vi.mock('../../network/ws-client', () => ({ send: vi.fn(), isConnected: vi.fn(() => true), nextMsgId: vi.fn(() => 'msg_1') }));
 */
export async function wireRealWsDispatcher(): Promise<(data: Record<string, unknown>) => void> {
  const { createWsDispatcher } = await import('../../network/ws-dispatcher');
  return createWsDispatcher();
}

/**
 * Mock browser APIs not available in jsdom: AudioContext, speechSynthesis.
 * Call in beforeEach BEFORE any audio-player imports.
 */
export function mockBrowserAPIs(): void {
  // speechSynthesis
  if (!window.speechSynthesis) {
    (window as unknown as Record<string, unknown>).speechSynthesis = {
      cancel: vi.fn(),
      speak: vi.fn(),
      getVoices: vi.fn(() => []),
    };
  }
  // AudioContext
  if (!window.AudioContext) {
    class MockAudioContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume = vi.fn(() => Promise.resolve());
      createGain = vi.fn(() => {
        const node = { gain: { value: 1 }, connect: vi.fn() };
        node.connect = vi.fn(() => node);
        return node;
      });
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
      createMediaStreamDestination = vi.fn(() => ({ stream: {} }));
    }
    (window as unknown as Record<string, unknown>).AudioContext = MockAudioContext;
  }
  // SpeechSynthesisUtterance
  if (typeof window.SpeechSynthesisUtterance === 'undefined') {
    (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance = class {
      lang = '';
      rate = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
    };
  }
}

/**
 * Clean up integration wiring. Call in afterEach for integration tests.
 */
export function teardownIntegration(): void {
  _eventHandlersWired = false;
  _micSyncWired = false;
  // Remove test transcript element
  const el = document.getElementById('transcript');
  if (el) el.remove();
  // Stop audioPlayer if running
  import('../../audio/audio-player').then(({ audioPlayer }) => {
    audioPlayer.stop();
  }).catch(() => {});
  teardownTest();
}

// ============================================================
// Helpers
// ============================================================

/**
 * Build a mock WS message object.
 */
export function wsMsg(
  type: string,
  botId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, botId, ...extra };
}

/**
 * Simulate a full PTT turn lifecycle:
 *   idle → sending → awaiting → receiving → idle
 */
export function simulatePttTurn(botId: string): void {
  botTurnState.transition(botId, 'sending');
  botTurnState.transition(botId, 'awaiting');
  botTurnState.transition(botId, 'receiving');
  botTurnState.resetToIdle(botId);
}

/**
 * Initialize chatStore for testing. Call after setupTestBots.
 * Handles IDB mocking internally.
 */
export async function initTestChatStore(botIds: string[]): Promise<void> {
  chatStore.init(botIds);
  await chatStore.loadAll(botIds);
}

/**
 * Add a server-confirmed message to chatStore via mergeFromServer.
 * This is the correct way to add messages in tests (not addMessage for confirmed msgs).
 */
export function mergeServerMessages(
  botId: string,
  messages: Array<{
    role: string;
    text: string;
    serverSeq: number;
    eventKey?: string;
    intermediate?: boolean;
    contentKind?: string;
  }>,
  revision?: number,
): void {
  const formatted = messages.map((m, i) => ({
    role: m.role,
    text: m.text,
    tts_text: m.text,
    server_seq: m.serverSeq,
    event_key: m.eventKey || `evt_${botId}_${m.serverSeq}_${i}`,
    ts: new Date().toISOString(),
    intermediate: m.intermediate || false,
    content_kind: m.contentKind || 'result',
    message_id: `mid_${m.serverSeq}`,
    source_channel: 'web',
  }));
  chatStore.mergeFromServer(botId, formatted, revision || Date.now());
}
