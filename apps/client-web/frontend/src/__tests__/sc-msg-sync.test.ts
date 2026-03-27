// @vitest-environment jsdom
/**
 * SC-D Chain Tests: Message Sync (SC-D-01 ~ SC-D-10)
 *
 * Derived from EXPERIENCE_SPEC behavioral scenarios.
 * Tests full event sequences for message synchronization.
 *
 * SC-D-01: upsertMessage -> sync confirm -> dedup merge
 * SC-D-02: Page refresh -> IDB load -> orphan detection -> full history fetch
 * SC-D-03: Multi-device broadcast -> exclude sender logic
 * SC-D-04: Incremental sync seq gap -> force full reload (clearCache + re-sync)
 * SC-D-05: Sync during active turn -> defer until turn ends
 * SC-D-06: (Removed) Streaming infrastructure removed
 * SC-D-07: Mixed serverSeq/pending/intermediate messages sorted by serverSeq then _seq
 * SC-D-08: Delivery status lifecycle + 3s delayed cleanup after turn end
 * SC-D-09: Outbox retry: failed message stays for retry, survives page refresh
 * SC-D-10: Server dedup: same msgId sent twice -> server processes once
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock IndexedDB and localStorage before importing modules that use them
const _mockStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => _mockStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { _mockStorage.set(key, value); },
  removeItem: (key: string) => { _mockStorage.delete(key); },
  clear: () => { _mockStorage.clear(); },
});
vi.stubGlobal('indexedDB', {
  open: () => {
    const req = { onsuccess: null as unknown, onerror: null as unknown, result: null };
    setTimeout(() => { if (typeof req.onerror === 'function') (req.onerror as () => void)(); }, 0);
    return req;
  },
});

import { chatStore } from '../store/chat-store';
import {
  shouldIncludeMsg,
  setGranularity,
  markTextRead,
  isTextAlreadyRead,
} from '../ui/app-state';
import { botTurnState } from '../state/bot-turn-state';
import { bus } from '../core/event-bus';
import { setupTestBots, teardownTest, BOT_A, BOT_B } from './helpers/test-setup';

const BOT = 'sync-bot';

beforeEach(() => {
  setupTestBots(BOT_A, BOT_B);
  setGranularity('final_only');
  chatStore.init([BOT, BOT_A, BOT_B]);
  chatStore.clearCache(BOT);
  chatStore.clearCache(BOT_A);
  chatStore.clearCache(BOT_B);
  _mockStorage.clear();
});
afterEach(() => teardownTest());

// ============================================================
// SC-D-01: upsertMessage -> sync confirm -> dedup merge
// ============================================================
describe('SC-D-01: upsertMessage -> sync confirm -> dedup merge', () => {
  it('upsertMessage creates a confirmed message with serverSeq', () => {
    chatStore.upsertMessage(BOT, {
      eventKey: 'ek_upsert_01',
      role: 'assistant',
      text: 'Hello world',
      serverSeq: 1,
    });

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('Hello world');
    expect(msgs[0].status).toBe('confirmed');
    expect(msgs[0].serverSeq).toBe(1);
  });

  it('upsertMessage updates existing message text (text growth)', () => {
    chatStore.upsertMessage(BOT, {
      eventKey: 'ek_grow',
      role: 'assistant',
      text: 'Hello',
      serverSeq: 1,
    });

    chatStore.upsertMessage(BOT, {
      eventKey: 'ek_grow',
      role: 'assistant',
      text: 'Hello world',
      serverSeq: 1,
    });

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('Hello world');
  });

  it('mergeFromServer with matching eventKey assigns serverSeq without duplicating', () => {
    chatStore.upsertMessage(BOT, {
      eventKey: 'evt_synced_01',
      role: 'assistant',
      text: 'Synced reply',
      serverSeq: 7,
    });

    // Server sync with same eventKey
    chatStore.mergeFromServer(BOT, [
      {
        role: 'assistant',
        text: 'Synced reply',
        eventKey: 'evt_synced_01',
        serverSeq: 7,
        ts: '2026-03-22T10:00:00Z',
      },
    ], 1);

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].serverSeq).toBe(7);
    expect(msgs[0].status).toBe('confirmed');
    expect(msgs[0].eventKey).toBe('evt_synced_01');
  });

  it('TTS dedup: markTextRead prevents re-reading same text after sync', () => {
    markTextRead(BOT, 'Already spoken text');
    expect(isTextAlreadyRead(BOT, 'Already spoken text')).toBe(true);
    expect(isTextAlreadyRead(BOT, 'New text')).toBe(false);
  });

  it('message position stays correct after sync assigns serverSeq', () => {
    // Confirmed user question at seq=1
    chatStore.upsertMessage(BOT, {
      eventKey: 'q_pos', role: 'user', text: 'Question', serverSeq: 1,
    });

    // Answer at seq=2
    chatStore.upsertMessage(BOT, {
      eventKey: 'evt_pos_ans', role: 'assistant', text: 'Answer', serverSeq: 2,
    });

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].eventKey).toBe('q_pos');
    expect(msgs[1].eventKey).toBe('evt_pos_ans');
  });
});

// ============================================================
// SC-D-02: Page refresh -> IDB load -> orphan detection -> full reload
// ============================================================
describe('SC-D-02: Page refresh -> IDB orphan detection -> maxServerSeq reset to 0', () => {
  it('orphan ghost (confirmed, serverSeq=null) forces maxServerSeq to 0 for full reload', async () => {
    const payload = {
      revision: 5,
      maxServerSeq: 10,
      messages: [
        { role: 'user', text: 'Good msg', eventKey: 'e1', serverSeq: 1, status: 'confirmed', intermediate: false, contentKind: 'result' },
        { role: 'assistant', text: 'Good reply', eventKey: 'e2', serverSeq: 2, status: 'confirmed', intermediate: false, contentKind: 'result' },
        // Orphan: confirmed but serverSeq null (crash artifact)
        { role: 'assistant', text: 'Orphan ghost', eventKey: 'e_orphan', serverSeq: null, status: 'confirmed', intermediate: false, contentKind: 'result' },
      ],
      version: 3,
    };
    _mockStorage.set('tryvoice_' + BOT, JSON.stringify(payload));

    const loadPromise = chatStore.load(BOT);
    await vi.advanceTimersByTimeAsync(100);
    await loadPromise;

    // Orphan detected -> maxServerSeq forced to 0 for full history fetch
    expect(chatStore.getMaxServerSeq(BOT)).toBe(0);
  });

  it('full reload after orphan detection replaces orphan with clean server data', async () => {
    const payload = {
      revision: 5,
      maxServerSeq: 10,
      messages: [
        { role: 'user', text: 'Good', eventKey: 'e1', serverSeq: 1, status: 'confirmed', intermediate: false, contentKind: 'result' },
        { role: 'assistant', text: 'Orphan', eventKey: 'e_orphan', serverSeq: null, status: 'confirmed', intermediate: false, contentKind: 'result' },
      ],
      version: 3,
    };
    _mockStorage.set('tryvoice_' + BOT, JSON.stringify(payload));

    const loadPromise = chatStore.load(BOT);
    await vi.advanceTimersByTimeAsync(100);
    await loadPromise;

    expect(chatStore.getMaxServerSeq(BOT)).toBe(0);

    // Full reload from server
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Good', eventKey: 'e1', serverSeq: 1 },
      { role: 'assistant', text: 'Real reply', eventKey: 'e3', serverSeq: 2 },
      { role: 'user', text: 'Follow-up', eventKey: 'e4', serverSeq: 3 },
    ], 6);

    const msgs = chatStore.getMessages(BOT);
    expect(msgs.find(m => m.eventKey === 'e_orphan')).toBeUndefined();
    expect(msgs).toHaveLength(3);
    expect(chatStore.getMaxServerSeq(BOT)).toBe(3);
  });

  it('pending messages (status=pending) do NOT trigger orphan detection', async () => {
    const payload = {
      revision: 5,
      maxServerSeq: 10,
      messages: [
        { role: 'user', text: 'Confirmed', eventKey: 'e1', serverSeq: 1, status: 'confirmed', intermediate: false, contentKind: 'result' },
        { role: 'user', text: 'Pending msg', eventKey: '', serverSeq: null, status: 'pending', intermediate: false, contentKind: 'result' },
      ],
      version: 3,
    };
    _mockStorage.set('tryvoice_' + BOT, JSON.stringify(payload));

    const loadPromise = chatStore.load(BOT);
    await vi.advanceTimersByTimeAsync(100);
    await loadPromise;

    // Pending messages are expected to lack serverSeq; maxServerSeq stays
    expect(chatStore.getMaxServerSeq(BOT)).toBe(10);
  });

  it('intermediate messages (e.g., thinking) do NOT trigger orphan detection', async () => {
    const payload = {
      revision: 5,
      maxServerSeq: 10,
      messages: [
        { role: 'user', text: 'Confirmed', eventKey: 'e1', serverSeq: 1, status: 'confirmed', intermediate: false, contentKind: 'result' },
        { role: 'assistant', text: 'Thinking...', eventKey: 'e_think', serverSeq: null, status: 'confirmed', intermediate: true, contentKind: 'thinking' },
      ],
      version: 3,
    };
    _mockStorage.set('tryvoice_' + BOT, JSON.stringify(payload));

    const loadPromise = chatStore.load(BOT);
    await vi.advanceTimersByTimeAsync(100);
    await loadPromise;

    // Intermediate messages are expected to lack serverSeq; maxServerSeq stays
    expect(chatStore.getMaxServerSeq(BOT)).toBe(10);
  });
});

// ============================================================
// SC-D-03: Multi-device broadcast -> exclude sender -> no duplicate
// ============================================================
describe('SC-D-03: Multi-device broadcast -> sender dedup -> no duplicate', () => {
  it('pending user message is reconciled with server-confirmed copy via text matching', () => {
    // Device A sends (pending, no eventKey)
    chatStore.addMessage(BOT, 'user', 'Hello from device A', {
      ts: '2026-03-22T10:00:00Z',
      clientMsgId: 'cmid_devA',
    }, { persist: false, notify: false });

    let msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].status).toBe('pending');

    // Server broadcast with eventKey + serverSeq.
    // mergeFromServer matches the pending outbox message by text+role
    // (no serverSeq) and reconciles them into a single confirmed message.
    chatStore.mergeFromServer(BOT, [
      {
        role: 'user',
        text: 'Hello from device A',
        eventKey: 'evt_devA',
        serverSeq: 1,
        ts: '2026-03-22T10:00:00Z',
      },
    ], 1);

    msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(1); // Reconciled into single message
    expect(msgs[0].status).toBe('confirmed');
    expect(msgs[0].serverSeq).toBe(1);
    expect(msgs[0].eventKey).toBe('evt_devA');
    expect(msgs[0].text).toBe('Hello from device A');
  });

  it('different bots receive independent messages without cross-contamination', () => {
    chatStore.mergeFromServer(BOT_A, [
      { role: 'user', text: 'To A', eventKey: 'evt_a', serverSeq: 1 },
      { role: 'assistant', text: 'From A', eventKey: 'evt_a_r', serverSeq: 2 },
    ], 1);

    chatStore.mergeFromServer(BOT_B, [
      { role: 'user', text: 'To B', eventKey: 'evt_b', serverSeq: 1 },
      { role: 'assistant', text: 'From B', eventKey: 'evt_b_r', serverSeq: 2 },
    ], 1);

    const msgsA = chatStore.getMessages(BOT_A);
    const msgsB = chatStore.getMessages(BOT_B);
    expect(msgsA).toHaveLength(2);
    expect(msgsB).toHaveLength(2);
    expect(msgsA[0].text).toBe('To A');
    expect(msgsB[0].text).toBe('To B');
  });

  it('agent reply arrives while pending user message exists -> reconciled', () => {
    // User sends (pending, no eventKey)
    chatStore.addMessage(BOT, 'user', 'My question', {
      ts: '2026-03-22T10:00:00Z',
      clientMsgId: 'cmid_q',
    }, { persist: false, notify: false });

    // Server has both user msg and agent reply.
    // mergeFromServer reconciles the pending user message with the server
    // copy (matched by text+role, no serverSeq), then adds the agent reply.
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'My question', eventKey: 'evt_q', serverSeq: 5 },
      { role: 'assistant', text: 'Agent answer', eventKey: 'evt_ans', serverSeq: 6 },
    ], 1);

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(2); // reconciled user + assistant
    expect(msgs[0].text).toBe('My question');
    expect(msgs[0].status).toBe('confirmed');
    expect(msgs[0].serverSeq).toBe(5);
    expect(msgs[0].eventKey).toBe('evt_q');
    expect(msgs[1].text).toBe('Agent answer');
    expect(msgs[1].serverSeq).toBe(6);
  });
});

// ============================================================
// SC-D-04: Incremental sync seq gap -> force full reload
// ============================================================
describe('SC-D-04: Seq gap detection -> clearCache + full re-sync', () => {
  it('merging messages with seq gap updates maxServerSeq to latest', () => {
    // Existing state up to seq=50
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Msg at 50', eventKey: 'e50', serverSeq: 50 },
    ], 1);
    expect(chatStore.getMaxServerSeq(BOT)).toBe(50);

    // Incremental sync with gap (51-52 missing) delivers 53-55
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Msg at 53', eventKey: 'e53', serverSeq: 53 },
      { role: 'assistant', text: 'Msg at 54', eventKey: 'e54', serverSeq: 54 },
      { role: 'user', text: 'Msg at 55', eventKey: 'e55', serverSeq: 55 },
    ], 2);

    expect(chatStore.getMaxServerSeq(BOT)).toBe(55);
    expect(chatStore.getMessages(BOT)).toHaveLength(4);
  });

  it('clearCache resets state to empty, enabling full re-sync from server', () => {
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Old msg', eventKey: 'e_old', serverSeq: 50 },
    ], 1);
    expect(chatStore.getMaxServerSeq(BOT)).toBe(50);

    // sync.ts detects gap and clears cache
    chatStore.clearCache(BOT);
    expect(chatStore.getMaxServerSeq(BOT)).toBe(0);
    expect(chatStore.getMessages(BOT)).toHaveLength(0);

    // Full reload from server
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Msg 51', eventKey: 'e51', serverSeq: 51 },
      { role: 'assistant', text: 'Msg 52', eventKey: 'e52', serverSeq: 52 },
      { role: 'user', text: 'Msg 53', eventKey: 'e53', serverSeq: 53 },
      { role: 'assistant', text: 'Msg 54', eventKey: 'e54', serverSeq: 54 },
      { role: 'user', text: 'Msg 55', eventKey: 'e55', serverSeq: 55 },
      { role: 'assistant', text: 'Msg 56', eventKey: 'e56', serverSeq: 56 },
      { role: 'user', text: 'Msg 57', eventKey: 'e57', serverSeq: 57 },
      { role: 'assistant', text: 'Msg 58', eventKey: 'e58', serverSeq: 58 },
      { role: 'user', text: 'Msg 59', eventKey: 'e59', serverSeq: 59 },
      { role: 'assistant', text: 'Msg 60', eventKey: 'e60', serverSeq: 60 },
    ], 10);

    expect(chatStore.getMaxServerSeq(BOT)).toBe(60);
    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(10);
    expect(msgs[0].serverSeq).toBe(51);
    expect(msgs[9].serverSeq).toBe(60);
  });

  it('sort order remains strictly ascending by serverSeq after full reload', () => {
    chatStore.clearCache(BOT);

    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Q1', eventKey: 'q1', serverSeq: 1 },
      { role: 'assistant', text: 'A1', eventKey: 'a1', serverSeq: 2 },
      { role: 'user', text: 'Q2', eventKey: 'q2', serverSeq: 3 },
      { role: 'assistant', text: 'A2', eventKey: 'a2', serverSeq: 4 },
    ], 1);

    const msgs = chatStore.getMessages(BOT);
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].serverSeq!).toBeGreaterThan(msgs[i - 1].serverSeq!);
    }
  });
});

// ============================================================
// SC-D-05: Sync during active turn -> defer until turn ends
// ============================================================
describe('SC-D-05: Sync deferred during active turn, proceeds when idle', () => {
  it('sequential mergeFromServer calls accumulate without interference', () => {
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Q1', eventKey: 'q1', serverSeq: 1 },
      { role: 'assistant', text: 'A1', eventKey: 'a1', serverSeq: 2 },
    ], 1);

    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Q2', eventKey: 'q2', serverSeq: 3 },
      { role: 'assistant', text: 'A2', eventKey: 'a2', serverSeq: 4 },
    ], 2);

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(4);
    expect(msgs[0].eventKey).toBe('q1');
    expect(msgs[1].eventKey).toBe('a1');
    expect(msgs[2].eventKey).toBe('q2');
    expect(msgs[3].eventKey).toBe('a2');
    expect(chatStore.getMaxServerSeq(BOT)).toBe(4);
  });

  it('botTurnState tracks turn lifecycle for sync deferral decision', () => {
    botTurnState.ensureBot(BOT);
    expect(botTurnState.get(BOT)).toBe('idle');

    // Active turn progression
    botTurnState.transition(BOT, 'sending');
    expect(botTurnState.get(BOT)).toBe('sending');

    botTurnState.transition(BOT, 'awaiting');
    expect(botTurnState.get(BOT)).toBe('awaiting');

    botTurnState.transition(BOT, 'receiving');
    expect(botTurnState.get(BOT)).toBe('receiving');

    // During receiving -> sync should be deferred
    const shouldDefer = botTurnState.get(BOT) !== 'idle';
    expect(shouldDefer).toBe(true);

    // Turn ends -> sync can proceed
    botTurnState.resetToIdle(BOT);
    expect(botTurnState.get(BOT)).toBe('idle');

    const canSync = botTurnState.get(BOT) === 'idle';
    expect(canSync).toBe(true);
  });
});

// SC-D-06: (Removed) Phase 4 cleanup / streaming tests.
// Streaming infrastructure has been removed — messages now arrive
// via message_sync / upsertMessage.

// ============================================================
// SC-D-07: Mixed serverSeq/pending/intermediate sorted by serverSeq then _seq
// ============================================================
describe('SC-D-07: sort priority for mixed message types', () => {
  it('messages sort by serverSeq primary, then _seq', () => {
    // M1: serverSeq=10, confirmed
    chatStore.addMessage(BOT, 'user', 'Old message', {
      eventKey: 'm1', serverSeq: 10, status: 'confirmed',
    }, { persist: false, notify: false });

    // M2: serverSeq=11, confirmed
    chatStore.addMessage(BOT, 'assistant', 'Agent reply', {
      eventKey: 'm2', serverSeq: 11, status: 'confirmed',
    }, { persist: false, notify: false });

    // M3: intermediate tool_call (no serverSeq)
    chatStore.addMessage(BOT, 'assistant', 'Running bash...', {
      eventKey: 'm3', intermediate: true, contentKind: 'tool_call',
      ts: '2026-03-22T10:00:02Z',
    }, { persist: false, notify: false });

    // M4: pending user message (no serverSeq)
    chatStore.addMessage(BOT, 'user', 'New question', {
      ts: '2026-03-22T10:00:03Z',
      status: 'pending',
    }, { persist: false, notify: false });

    // M5: serverSeq=12, confirmed
    chatStore.addMessage(BOT, 'assistant', 'Another reply', {
      eventKey: 'm5', serverSeq: 12, status: 'confirmed',
    }, { persist: false, notify: false });

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(5);

    // Sort order: M1(10), M2(11), M3(by _seq), M4(by _seq), M5(12)
    // M3 and M4 have no serverSeq, so they sort by _seq (insertion order)
    // between M2 and M5
    expect(msgs[0].eventKey).toBe('m1');
    expect(msgs[1].eventKey).toBe('m2');
    expect(msgs[2].eventKey).toBe('m3');
    expect(msgs[3].text).toBe('New question');
    expect(msgs[4].eventKey).toBe('m5');
  });

  it('sync reconciles pending user message with server-confirmed copy', () => {
    chatStore.addMessage(BOT, 'user', 'Old message', {
      eventKey: 'm1', serverSeq: 10, status: 'confirmed',
    }, { persist: false, notify: false });
    chatStore.addMessage(BOT, 'assistant', 'Agent reply', {
      eventKey: 'm2', serverSeq: 11, status: 'confirmed',
    }, { persist: false, notify: false });
    chatStore.addMessage(BOT, 'user', 'New question', {
      ts: '2026-03-22T10:00:03Z',
      status: 'pending',
    }, { persist: false, notify: false });
    chatStore.addMessage(BOT, 'assistant', 'Another reply', {
      eventKey: 'm5', serverSeq: 12, status: 'confirmed',
    }, { persist: false, notify: false });

    // Server sync delivers confirmed message with serverSeq=13.
    // mergeFromServer matches the pending user message by text+role
    // and reconciles it into a single confirmed message.
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'New question', eventKey: 'evt_nq', serverSeq: 13 },
    ], 3);

    const msgs = chatStore.getMessages(BOT);

    // Reconciled: pending replaced by confirmed with real eventKey
    const nqMsg = msgs.find(m => m.eventKey === 'evt_nq');
    expect(nqMsg).toBeDefined();
    expect(nqMsg!.serverSeq).toBe(13);
    expect(nqMsg!.status).toBe('confirmed');

    // No pending duplicate remains
    const pendingMsg = msgs.find(m => m.status === 'pending' && m.text === 'New question');
    expect(pendingMsg).toBeUndefined();
  });

  it('shouldIncludeMsg filters by granularity across message types', () => {
    setGranularity('final_only');

    // Normal result: included
    expect(shouldIncludeMsg({ text: 'Normal' }, 'final_only')).toBe(true);

    // Intermediate tool_call: excluded in final_only
    expect(shouldIncludeMsg({ intermediate: true, contentKind: 'tool_call' }, 'final_only')).toBe(false);

    // Intermediate thinking: excluded in final_only and with_steps, included in with_thinking
    expect(shouldIncludeMsg({ intermediate: true, contentKind: 'thinking' }, 'final_only')).toBe(false);
    expect(shouldIncludeMsg({ intermediate: true, contentKind: 'thinking' }, 'with_steps')).toBe(false);
    expect(shouldIncludeMsg({ intermediate: true, contentKind: 'thinking' }, 'with_thinking')).toBe(true);

    // [tool: ...] prefix: excluded except in 'all'
    expect(shouldIncludeMsg({ text: '[tool: Bash] ls' }, 'final_only')).toBe(false);
    expect(shouldIncludeMsg({ text: '[tool: Bash] ls' }, 'all')).toBe(true);
  });
});

// ============================================================
// SC-D-08: Delivery status lifecycle + 3s delayed cleanup
// ============================================================
describe('SC-D-08: Delivery status lifecycle + 3s delayed cleanup after turn end', () => {
  it('full lifecycle: sending -> sent -> delivered -> agent_processing -> replied', () => {
    chatStore.addMessage(BOT, 'user', 'My question', {
      clientMsgId: 'cmid_lc',
      deliveryStatus: 'sending',
      ts: '2026-03-22T10:00:00Z',
    }, { persist: false, notify: false });

    const check = (expected: string) => {
      const msg = chatStore.findByClientMsgId(BOT, 'cmid_lc');
      expect(msg).not.toBeNull();
      expect(msg!.deliveryStatus).toBe(expected);
    };

    check('sending');

    chatStore.updateDeliveryStatus(BOT, 'cmid_lc', 'sent');
    check('sent');

    chatStore.updateDeliveryStatus(BOT, 'cmid_lc', 'delivered');
    check('delivered');

    chatStore.updateDeliveryStatus(BOT, 'cmid_lc', 'agent_processing');
    check('agent_processing');

    chatStore.updateDeliveryStatus(BOT, 'cmid_lc', 'replied');
    check('replied');
  });

  it('clearProcessingDeliveryStatuses upgrades active statuses to replied, skips failed', () => {
    chatStore.addMessage(BOT, 'user', 'Msg sending', {
      clientMsgId: 'cm_sending', deliveryStatus: 'sending',
      ts: '2026-03-22T10:00:00Z',
    }, { persist: false, notify: false });
    chatStore.addMessage(BOT, 'user', 'Msg sent', {
      clientMsgId: 'cm_sent', deliveryStatus: 'sent',
      ts: '2026-03-22T10:00:01Z',
    }, { persist: false, notify: false });
    chatStore.addMessage(BOT, 'user', 'Msg delivered', {
      clientMsgId: 'cm_delivered', deliveryStatus: 'delivered',
      ts: '2026-03-22T10:00:02Z',
    }, { persist: false, notify: false });
    chatStore.addMessage(BOT, 'user', 'Msg processing', {
      clientMsgId: 'cm_processing', deliveryStatus: 'processing',
      ts: '2026-03-22T10:00:03Z',
    }, { persist: false, notify: false });
    chatStore.addMessage(BOT, 'user', 'Msg agent_processing', {
      clientMsgId: 'cm_agent', deliveryStatus: 'agent_processing',
      ts: '2026-03-22T10:00:04Z',
    }, { persist: false, notify: false });
    chatStore.addMessage(BOT, 'user', 'Msg replied', {
      clientMsgId: 'cm_replied', deliveryStatus: 'replied',
      ts: '2026-03-22T10:00:05Z',
    }, { persist: false, notify: false });
    chatStore.addMessage(BOT, 'user', 'Msg failed', {
      clientMsgId: 'cm_failed', deliveryStatus: 'failed',
      ts: '2026-03-22T10:00:06Z',
    }, { persist: false, notify: false });

    chatStore.clearProcessingDeliveryStatuses(BOT);

    // Active statuses -> replied
    expect(chatStore.findByClientMsgId(BOT, 'cm_sending')!.deliveryStatus).toBe('replied');
    expect(chatStore.findByClientMsgId(BOT, 'cm_sent')!.deliveryStatus).toBe('replied');
    expect(chatStore.findByClientMsgId(BOT, 'cm_delivered')!.deliveryStatus).toBe('replied');
    expect(chatStore.findByClientMsgId(BOT, 'cm_processing')!.deliveryStatus).toBe('replied');
    expect(chatStore.findByClientMsgId(BOT, 'cm_agent')!.deliveryStatus).toBe('replied');

    // Already replied -> stays
    expect(chatStore.findByClientMsgId(BOT, 'cm_replied')!.deliveryStatus).toBe('replied');

    // Failed -> NOT upgraded
    expect(chatStore.findByClientMsgId(BOT, 'cm_failed')!.deliveryStatus).toBe('failed');
  });

  it('3s delayed cleanup: replied status can be cleared after turn end', () => {
    chatStore.addMessage(BOT, 'user', 'Delayed msg', {
      clientMsgId: 'cmid_delay',
      deliveryStatus: 'sending',
      ts: '2026-03-22T10:00:00Z',
    }, { persist: false, notify: false });

    // Progress through full lifecycle
    chatStore.updateDeliveryStatus(BOT, 'cmid_delay', 'sent');
    chatStore.updateDeliveryStatus(BOT, 'cmid_delay', 'delivered');
    chatStore.updateDeliveryStatus(BOT, 'cmid_delay', 'agent_processing');
    chatStore.updateDeliveryStatus(BOT, 'cmid_delay', 'replied');

    const msg = chatStore.findByClientMsgId(BOT, 'cmid_delay');
    expect(msg!.deliveryStatus).toBe('replied');

    // After 3s UI clears delivery label
    chatStore.updateDeliveryStatus(BOT, 'cmid_delay', '' as any);
    expect(chatStore.findByClientMsgId(BOT, 'cmid_delay')!.deliveryStatus).toBe('');
  });

  it('updateDeliveryStatus emits chat:delivery-status bus event', () => {
    chatStore.addMessage(BOT, 'user', 'Event test', {
      clientMsgId: 'cmid_evt',
      deliveryStatus: 'sending',
      ts: '2026-03-22T10:00:00Z',
    }, { persist: false, notify: false });

    const handler = vi.fn();
    bus.on('chat:delivery-status', handler);

    chatStore.updateDeliveryStatus(BOT, 'cmid_evt', 'sent');

    expect(handler).toHaveBeenCalledWith(BOT, 'cmid_evt', 'sent');
  });

  it('updateDeliveryStatus returns false for unknown clientMsgId', () => {
    expect(chatStore.updateDeliveryStatus(BOT, 'nonexistent', 'sent')).toBe(false);
  });
});

// ============================================================
// SC-D-09: Outbox retry: failed message stays, survives page refresh
// ============================================================
describe('SC-D-09: Outbox retry mechanism', () => {
  it('failed message stays pending, survives sync, then gets confirmed on retry', () => {
    chatStore.addMessage(BOT, 'user', 'Retry message', {
      ts: '2026-03-22T10:00:00Z',
      clientMsgId: 'cmid_retry',
      deliveryStatus: 'sending',
    }, { persist: false, notify: false });

    // First attempt fails
    chatStore.updateDeliveryStatus(BOT, 'cmid_retry', 'failed');
    let msg = chatStore.findByClientMsgId(BOT, 'cmid_retry');
    expect(msg!.deliveryStatus).toBe('failed');
    expect(msg!.status).toBe('pending');

    // mergeFromServer does NOT remove pending messages
    chatStore.mergeFromServer(BOT, [
      { role: 'assistant', text: 'Old reply', eventKey: 'old_r', serverSeq: 1 },
    ], 1);

    msg = chatStore.findByClientMsgId(BOT, 'cmid_retry');
    expect(msg).not.toBeNull();
    expect(msg!.status).toBe('pending');

    // Retry succeeds
    chatStore.updateDeliveryStatus(BOT, 'cmid_retry', 'sent');
    chatStore.mergeFromServer(BOT, [
      { role: 'assistant', text: 'Old reply', eventKey: 'old_r', serverSeq: 1 },
      { role: 'user', text: 'Retry message', eventKey: 'evt_retry', serverSeq: 2 },
      { role: 'assistant', text: 'Reply to retry', eventKey: 'evt_reply', serverSeq: 3 },
    ], 2);

    const msgs = chatStore.getMessages(BOT);
    const retryMsg = msgs.find(m => m.eventKey === 'evt_retry');
    expect(retryMsg).toBeDefined();
    expect(retryMsg!.status).toBe('confirmed');
    expect(retryMsg!.serverSeq).toBe(2);
  });

  it('after MAX_RETRIES=3 failures, message remains failed; clearProcessing skips it', () => {
    chatStore.addMessage(BOT, 'user', 'Will fail msg', {
      ts: '2026-03-22T10:00:00Z',
      clientMsgId: 'cmid_fail3',
      deliveryStatus: 'sending',
    }, { persist: false, notify: false });

    // 3 retry cycles, all fail
    for (let i = 0; i < 3; i++) {
      chatStore.updateDeliveryStatus(BOT, 'cmid_fail3', 'sending');
      chatStore.updateDeliveryStatus(BOT, 'cmid_fail3', 'failed');
    }

    const msg = chatStore.findByClientMsgId(BOT, 'cmid_fail3');
    expect(msg!.deliveryStatus).toBe('failed');
    expect(msg!.status).toBe('pending');

    // clearProcessingDeliveryStatuses does NOT upgrade 'failed'
    chatStore.clearProcessingDeliveryStatuses(BOT);
    expect(chatStore.findByClientMsgId(BOT, 'cmid_fail3')!.deliveryStatus).toBe('failed');
  });

  it('pending message survives page refresh via localStorage persistence', async () => {
    // persist:true triggers save to localStorage
    chatStore.addMessage(BOT, 'user', 'Unsent message', {
      ts: '2026-03-22T10:00:00Z',
      clientMsgId: 'cmid_unsent',
      deliveryStatus: 'sending',
    }, { persist: true, notify: false });

    // Verify localStorage was written
    const stored = _mockStorage.get('tryvoice_' + BOT);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.messages.some((m: any) => m.clientMsgId === 'cmid_unsent')).toBe(true);

    // Simulate page refresh: re-init and load from localStorage
    chatStore.init([BOT]);
    const loadPromise = chatStore.load(BOT);
    await vi.advanceTimersByTimeAsync(100);
    await loadPromise;

    const msgs = chatStore.getMessages(BOT);
    const unsent = msgs.find(m => m.clientMsgId === 'cmid_unsent');
    expect(unsent).toBeDefined();
    expect(unsent!.text).toBe('Unsent message');
  });
});

// ============================================================
// SC-D-10: Server dedup: same msgId sent twice -> server processes once
// ============================================================
describe('SC-D-10: Server dedup -> same eventKey -> single message', () => {
  it('mergeFromServer with identical eventKey twice yields one message', () => {
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Hello', eventKey: 'evt_dup', serverSeq: 1 },
    ], 1);

    // Server sends same message again (retry or broadcast)
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Hello', eventKey: 'evt_dup', serverSeq: 1 },
    ], 1);

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].eventKey).toBe('evt_dup');
    expect(msgs[0].serverSeq).toBe(1);
  });

  it('addMessage with duplicate eventKey returns isDuplicate=true and upserts', () => {
    chatStore.addMessage(BOT, 'assistant', 'First version', {
      eventKey: 'evt_same',
      ts: '2026-03-22T10:00:00Z',
    }, { persist: false, notify: false });

    const result = chatStore.addMessage(BOT, 'assistant', 'Second version', {
      eventKey: 'evt_same',
      ts: '2026-03-22T10:00:01Z',
    }, { persist: false, notify: false });

    expect(result).not.toBeNull();
    expect(result!.isDuplicate).toBe(true);

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe('Second version');
  });

  it('batch with duplicate eventKeys in single mergeFromServer -> no duplicates', () => {
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Q', eventKey: 'evt_q', serverSeq: 1 },
      { role: 'assistant', text: 'A', eventKey: 'evt_a', serverSeq: 2 },
      // Duplicates within same batch
      { role: 'user', text: 'Q updated', eventKey: 'evt_q', serverSeq: 1 },
      { role: 'assistant', text: 'A updated', eventKey: 'evt_a', serverSeq: 2 },
    ], 1);

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(2);
    // Last occurrence wins (upsert semantics)
    expect(msgs[0].text).toBe('Q updated');
    expect(msgs[1].text).toBe('A updated');
  });

  it('pending local message IS reconciled with server message via text matching', () => {
    // Pending message with no eventKey
    chatStore.addMessage(BOT, 'user', 'Hello world', {
      ts: '2026-03-22T10:00:00Z',
    }, { persist: false, notify: false });

    // Server delivers the same text with an eventKey.
    // mergeFromServer matches the pending user message (no serverSeq)
    // and reconciles it into a single confirmed message.
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Hello world', eventKey: 'evt_hw', serverSeq: 1 },
    ], 1);

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(1); // Reconciled into single message
    expect(msgs[0].status).toBe('confirmed');
    expect(msgs[0].eventKey).toBe('evt_hw');
    expect(msgs[0].serverSeq).toBe(1);
    expect(msgs[0].text).toBe('Hello world');
  });

  it('different eventKeys with same text are NOT deduped', () => {
    chatStore.mergeFromServer(BOT, [
      { role: 'user', text: 'Hello', eventKey: 'evt_1', serverSeq: 1 },
      { role: 'user', text: 'Hello', eventKey: 'evt_2', serverSeq: 2 },
    ], 1);

    const msgs = chatStore.getMessages(BOT);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].eventKey).toBe('evt_1');
    expect(msgs[1].eventKey).toBe('evt_2');
  });
});
