// Chat store — Unified message state management
// Ported from chat-store.js (v2: eventKey-primary Map model)

import { bus } from '../core/event-bus';
import { createLogger } from '../logging/logger';
import type { ChatMessage, MessageStatus, DeliveryStatus, BotId } from '../core/types';
import { STORAGE_KEY } from '../core/types';

const log = createLogger('store.chat');

const IDB_NAME = 'voice-chat-history';
const IDB_VERSION = 1;

let _idb: IDBDatabase | null = null;
const _msgMap: Record<string, Map<string, ChatMessage>> = {};
const _revision: Record<string, number> = {};
const _maxServerSeq: Record<string, number> = {};
let _tempIdCounter = 0;
let _insertionSeq = 0;

// Viewport state per bot — tracks pagination cursors and mode
export interface ViewportState {
  mode: 'latest' | 'history';
  oldestLoadedSeq: number | null;
  hasMore: boolean;
  latestMessages: ChatMessage[];
  latestMaxServerSeq: number;
  latestRevision: number;
}

const _viewport: Record<string, ViewportState> = {};

function _ensureViewport(botId: string): ViewportState {
  if (!_viewport[botId]) {
    _viewport[botId] = {
      mode: 'latest',
      oldestLoadedSeq: null,
      hasMore: true,
      latestMessages: [],
      latestMaxServerSeq: 0,
      latestRevision: 0,
    };
  }
  return _viewport[botId];
}

function _genTempId(): string {
  _tempIdCounter += 1;
  return `_tmp_${Date.now()}_${_tempIdCounter}`;
}

function _nextInsertionSeq(): number {
  _insertionSeq += 1;
  return _insertionSeq;
}

/** Keep _insertionSeq ahead of serverSeq so pending messages always sort
 *  after confirmed ones.  Called whenever _maxServerSeq is bumped. */
function _syncInsertionSeq(serverSeq: number): void {
  if (serverSeq > _insertionSeq) _insertionSeq = serverSeq;
}

function _parseMsgTsMs(ts: string): number | null {
  const raw = String(ts || '').trim();
  if (!raw) return null;
  if (/^\d{11,}$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function _normalizeMsgText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').replace(/([。！？!?；;，,])\s*/g, '$1').trim();
}

function _makeMsg(role: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  const t = String(text || '');
  return {
    role: String(role || ''),
    text: t,
    ttsText: String(extra.ttsText ?? (role === 'assistant' ? t : '')),
    ts: String(extra.ts || ''),
    eventKey: String(extra.eventKey || ''),
    intermediate: !!extra.intermediate,
    contentKind: extra.contentKind || 'result',
    status: (extra.status || 'pending') as MessageStatus,
    deliveryStatus: (extra.deliveryStatus || '') as DeliveryStatus,
    clientMsgId: String(extra.clientMsgId || ''),
    _seq: extra._seq || _nextInsertionSeq(),
    _createdAt: extra._createdAt || Date.now(),
    serverSeq: extra.serverSeq ?? null,
    messageId: extra.messageId ?? null,
    sourceChannel: String(extra.sourceChannel || 'web'),
  };
}

function _getSortedMessages(botId: string): ChatMessage[] {
  const map = _msgMap[botId];
  if (!map || map.size === 0) return [];
  const arr = Array.from(map.values());
  arr.sort((a, b) => {
    const aSeq = a.serverSeq;
    const bSeq = b.serverSeq;
    // Primary: sort by serverSeq
    if (aSeq != null && bSeq != null) {
      if (aSeq !== bSeq) return aSeq - bSeq;
      return (a._seq || 0) - (b._seq || 0);
    }
    // Messages without serverSeq (reconnect edge case): use _seq as tiebreaker
    return (a._seq || 0) - (b._seq || 0);
  });
  return arr;
}

function _findKeyByEventKey(botId: string, eventKey: string): string | null {
  if (!eventKey) return null;
  const map = _msgMap[botId];
  if (!map) return null;
  if (map.has(eventKey)) return eventKey;
  for (const [k, m] of map) {
    if (m.eventKey === eventKey) return k;
  }
  return null;
}

function _findKeyByClientMsgId(botId: string, clientMsgId: string): string | null {
  if (!clientMsgId) return null;
  const map = _msgMap[botId];
  if (!map) return null;
  for (const [k, m] of map) {
    if (m.clientMsgId === clientMsgId) return k;
  }
  return null;
}

function _findKeyByTextRole(botId: string, role: string, text: string): string | null {
  const map = _msgMap[botId];
  if (!map) return null;
  const nt = _normalizeMsgText(text);
  if (!nt) return null;
  const entries = Array.from(map.entries());
  for (let i = entries.length - 1; i >= 0; i--) {
    const [k, m] = entries[i];
    if (m.role === role && _normalizeMsgText(m.text) === nt && m.status === 'pending') {
      return k;
    }
  }
  return null;
}

// IDB helpers
function _openIDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (_idb) { resolve(_idb); return; }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('chats')) {
        db.createObjectStore('chats');
      }
    };
    req.onsuccess = (e) => { _idb = (e.target as IDBOpenDBRequest).result; resolve(_idb); };
    req.onerror = () => resolve(null);
  });
}

async function _idbSave(botId: string, payload: unknown): Promise<void> {
  try {
    const db = await _openIDB();
    if (!db) return;
    const tx = db.transaction('chats', 'readwrite');
    tx.objectStore('chats').put(payload, STORAGE_KEY + botId);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_e) { /* silent */ }
}

async function _idbLoad(botId: string): Promise<unknown> {
  try {
    const db = await _openIDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction('chats', 'readonly');
      const req = tx.objectStore('chats').get(STORAGE_KEY + botId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_e) { return null; }
}

function _notify(botId: string): void {
  bus.emit('chat:changed', botId);
}

function _ensureMap(botId: string): void {
  if (!_msgMap[botId]) _msgMap[botId] = new Map();
}

// Public API
export const chatStore = {
  init(botIds: string[]): void {
    botIds.forEach(id => {
      _ensureMap(id);
      if (!_revision[id]) _revision[id] = 0;
      if (!_maxServerSeq[id]) _maxServerSeq[id] = 0;
    });
  },

  getMessages(botId: string): ChatMessage[] {
    return _getSortedMessages(botId);
  },

  getRevision(botId: string): number {
    return _revision[botId] || 0;
  },

  getMaxServerSeq(botId: string): number {
    return _maxServerSeq[botId] || 0;
  },

  addMessage(
    botId: string,
    role: string,
    text: string,
    extra: Partial<ChatMessage> = {},
    opts: { persist?: boolean; notify?: boolean } = {},
  ): { msg: ChatMessage; isDuplicate: boolean; index: number } | null {
    _ensureMap(botId);
    const eventKey = extra.eventKey || '';
    const msg = _makeMsg(role, text, {
      ...extra,
      ts: extra.ts || new Date().toISOString(),
      status: eventKey ? 'confirmed' : (extra.status || 'pending'),
    });
    if (!msg.text.trim()) return null;

    let existingKey = eventKey ? _findKeyByEventKey(botId, eventKey) : null;
    if (!existingKey) {
      existingKey = _findKeyByClientMsgId(botId, extra.clientMsgId || '');
    }
    if (!existingKey && eventKey) {
      existingKey = _findKeyByTextRole(botId, role, text);
    }

    if (existingKey) {
      const existing = _msgMap[botId].get(existingKey)!;
      const merged = _makeMsg(role, text, {
        ttsText: msg.ttsText || existing.ttsText,
        ts: msg.ts || existing.ts,
        eventKey: eventKey || existing.eventKey,
        intermediate: msg.intermediate || existing.intermediate,
        status: eventKey ? 'confirmed' : existing.status,
        deliveryStatus: msg.deliveryStatus || existing.deliveryStatus,
        clientMsgId: msg.clientMsgId || existing.clientMsgId,
        _seq: existing._seq,
      });
      if (existingKey !== (eventKey || existingKey)) {
        _msgMap[botId].delete(existingKey);
        _msgMap[botId].set(eventKey, merged);
      } else {
        _msgMap[botId].set(existingKey, merged);
      }
      if (opts.persist !== false) this.save(botId);
      if (opts.notify !== false) _notify(botId);
      const sorted = _getSortedMessages(botId);
      const idx = sorted.indexOf(merged);
      return { msg: merged, isDuplicate: true, index: idx >= 0 ? idx : sorted.length - 1 };
    }

    const mapKey = eventKey || _genTempId();
    if (!msg.eventKey) msg.eventKey = eventKey;
    _msgMap[botId].set(mapKey, msg);
    log.info('addMsg', { botId, role, textPreview: msg.text?.slice(0, 40), status: msg.status, eventKey: eventKey?.slice(0, 12) });
    if (opts.persist !== false) this.save(botId);
    if (opts.notify !== false) _notify(botId);
    const sorted = _getSortedMessages(botId);
    const idx = sorted.indexOf(msg);
    return { msg, isDuplicate: false, index: idx >= 0 ? idx : sorted.length - 1 };
  },


  clearIntermediate(botId: string): void {
    _ensureMap(botId);
    const map = _msgMap[botId];
    let changed = false;
    for (const [k, m] of map) {
      if (m.intermediate || _normalizeMsgText(m.text).startsWith('\u{1F4AD}')) {
        map.delete(k);
        changed = true;
      }
    }
    if (changed) { this.save(botId); _notify(botId); }
  },

  setRevision(botId: string, rev: number): void {
    _revision[botId] = Number(rev) || 0;
  },

  mergeFromServer(botId: string, serverMsgs: Array<{
    role: string; text: string; ttsText?: string;
    ts?: string; eventKey?: string; serverSeq?: number | null;
    messageId?: string | null; intermediate?: boolean;
    sourceChannel?: string;
  }>, remoteRevision?: number): void {
    _ensureMap(botId);

    // In history mode, accumulate new messages in the cached latest segment
    const vp = _ensureViewport(botId);
    if (vp.mode === 'history') {
      for (const sm of serverMsgs) {
        const ek = String(sm.eventKey || '');
        if (!ek) continue;
        const exists = vp.latestMessages.some(m => m.eventKey === ek);
        if (!exists) {
          vp.latestMessages.push(_makeMsg(sm.role, sm.text, {
            ttsText: sm.ttsText || (sm.role === 'assistant' ? sm.text : ''),
            ts: sm.ts || '',
            eventKey: ek,
            status: 'confirmed',
            serverSeq: sm.serverSeq ?? null,
            messageId: sm.messageId ?? null,
            sourceChannel: sm.sourceChannel || 'web',
          }));
          if (sm.serverSeq && sm.serverSeq > vp.latestMaxServerSeq) {
            vp.latestMaxServerSeq = sm.serverSeq;
          }
        }
      }
      if (remoteRevision !== undefined) {
        vp.latestRevision = Math.max(vp.latestRevision, Number(remoteRevision));
      }
      return;
    }

    if (remoteRevision !== undefined && Number(remoteRevision) > (_revision[botId] || 0)) {
      _revision[botId] = Number(remoteRevision);
    }

    const map = _msgMap[botId];
    const serverKeys = new Set<string>();
    let changed = false;

    for (const sm of serverMsgs) {
      const ek = String(sm.eventKey || '');
      if (ek) serverKeys.add(ek);
    }

    // Phase 1+2+3 consolidated: eventKey-only upsert (ISSUE-09 simplification).
    // Text-based fuzzy matching has been removed — it caused sort order bugs
    // when duplicate server messages with different eventKeys but identical text
    // existed (ISSUE-24). Orphaned pending messages (local messages that missed
    // their WS eventKey assignment) are cleaned up by the 5-minute stale timer
    // in chatStore.load() (ISSUE-08 fix).
    let maxSeq = _maxServerSeq[botId] || 0;
    log.info('mergeFromServer upsert', {
      botId,
      serverMsgCount: serverMsgs.length,
      maxSeq,
      firstSeq: serverMsgs[0]?.serverSeq,
      lastSeq: serverMsgs[serverMsgs.length - 1]?.serverSeq,
    });
    for (const sm of serverMsgs) {
      const ek = String(sm.eventKey || '');
      if (!ek) continue;

      // Reconcile with existing messages: by eventKey first, then by
      // clientMsgId (handles outbox messages stored under temp keys)
      let existingKey: string | null = map.has(ek) ? ek : null;
      if (!existingKey && sm.role === 'user') {
        // Find unconfirmed outbox message matching by text
        const nt = _normalizeMsgText(sm.text);
        if (nt) {
          for (const [k, m] of map) {
            if (m.role === 'user' && !m.serverSeq && _normalizeMsgText(m.text) === nt) {
              existingKey = k;
              break;
            }
          }
        }
      }
      const existing = existingKey ? map.get(existingKey) : undefined;

      // Track whether this upsert changes anything visible
      if (!existing) {
        changed = true;
      } else if (existing.status !== 'confirmed'
          || _normalizeMsgText(existing.text) !== _normalizeMsgText(sm.text)) {
        changed = true;
      }

      const msg = _makeMsg(sm.role, sm.text, {
        ttsText: sm.ttsText || (sm.role === 'assistant' ? sm.text : ''),
        ts: sm.ts || existing?.ts || '',
        eventKey: ek,
        intermediate: false,
        status: 'confirmed',
        // Preserve client-side tracking fields from existing message
        clientMsgId: existing?.clientMsgId || '',
        deliveryStatus: existing?.deliveryStatus || '',
        // Use serverSeq as _seq for server-confirmed messages to ensure
        // stable sort order.
        _seq: sm.serverSeq ?? existing?._seq,
        serverSeq: sm.serverSeq ?? existing?.serverSeq ?? null,
        messageId: sm.messageId ?? existing?.messageId ?? null,
        sourceChannel: sm.sourceChannel || existing?.sourceChannel || 'web',
      });
      // Re-key if we matched an outbox message under a temp key
      if (existingKey && existingKey !== ek) {
        map.delete(existingKey);
      }
      map.set(ek, msg);
      if (sm.serverSeq && sm.serverSeq > maxSeq) maxSeq = sm.serverSeq;
    }
    _maxServerSeq[botId] = maxSeq;
    _syncInsertionSeq(maxSeq);

    this.save(botId);
    if (changed) _notify(botId);
  },

  /** Upsert a single message from the message_sync WS event. */
  upsertMessage(botId: string, msg: {
    eventKey: string;
    role: string;
    text: string;
    serverSeq?: number;
    timestamp?: string;
    clientMsgId?: string;
    sourceChannel?: string;
    intermediate?: boolean;
    contentKind?: string;
  }): void {
    _ensureMap(botId);
    const map = _msgMap[botId];

    // Reconcile optimistic outbox message with JSONL-sourced message_sync:
    // 1. Match by eventKey (already confirmed or re-synced messages)
    // 2. Match by clientMsgId (web-originated user messages carry this through)
    // 3. No match → new message (e.g. typed directly in tmux terminal)
    let existingKey: string | null = map.has(msg.eventKey) ? msg.eventKey : null;
    if (!existingKey && msg.clientMsgId) {
      existingKey = _findKeyByClientMsgId(botId, msg.clientMsgId);
    }
    const existing = existingKey ? map.get(existingKey) : undefined;

    if (existing) {
      // Text growth detection for TTS: compute delta
      const oldText = existing.text || '';
      const newText = msg.text || '';
      if (newText.length > oldText.length && newText.startsWith(oldText)) {
        existing.ttsText = newText.slice(oldText.length); // delta for TTS
      } else if (newText !== oldText) {
        existing.ttsText = ''; // text replaced, no delta
      }
      existing.text = newText;
      existing.eventKey = msg.eventKey;
      if (msg.serverSeq != null) {
        existing.serverSeq = msg.serverSeq;
        existing._seq = msg.serverSeq;
      }
      existing.status = 'confirmed';
      if (msg.sourceChannel) existing.sourceChannel = msg.sourceChannel;
      if (msg.intermediate != null) existing.intermediate = msg.intermediate;
      if (msg.contentKind) existing.contentKind = msg.contentKind as ChatMessage['contentKind'];
      // Re-key if the map key changed (was temp, now real eventKey)
      if (existingKey !== msg.eventKey) {
        map.delete(existingKey!);
        map.set(msg.eventKey, existing);
      }
    } else {
      // New message
      map.set(msg.eventKey, _makeMsg(msg.role, msg.text || '', {
        eventKey: msg.eventKey,
        ttsText: msg.text || '', // full text for first TTS
        _seq: msg.serverSeq ?? undefined,
        serverSeq: msg.serverSeq ?? undefined,
        status: 'confirmed',
        ts: msg.timestamp || '',
        sourceChannel: msg.sourceChannel || 'web',
        intermediate: !!msg.intermediate,
        contentKind: (msg.contentKind || 'result') as ChatMessage['contentKind'],
      }));
    }

    const maxSeq = _maxServerSeq[botId] || 0;
    if (msg.serverSeq != null && msg.serverSeq > maxSeq) {
      _maxServerSeq[botId] = msg.serverSeq;
      _syncInsertionSeq(msg.serverSeq);
    }

    this.save(botId);
    _notify(botId);
  },

  updateDeliveryStatus(botId: string, clientMsgId: string, deliveryStatus: DeliveryStatus): boolean {
    if (!clientMsgId || !_msgMap[botId]) return false;

    // INV-MSG-05: delivery status must not regress.
    // Ordinal defines the progression; 'failed' is terminal and can always be set.
    const _statusOrd: Record<string, number> = {
      '': -1, sending: 0, sent: 1, delivered: 2,
      processing: 3, agent_processing: 3, replied: 4, failed: 5,
    };

    for (const msg of _msgMap[botId].values()) {
      if (msg.clientMsgId === clientMsgId) {
        const curOrd = _statusOrd[msg.deliveryStatus] ?? -1;
        const newOrd = _statusOrd[deliveryStatus] ?? -1;
        // Skip regression unless the new status is 'failed' (terminal override)
        // or '' (UI label clear after timeout)
        if (newOrd < curOrd && deliveryStatus !== 'failed' && deliveryStatus !== '') return false;

        msg.deliveryStatus = deliveryStatus;
        // Emit lightweight event for targeted DOM update instead of full re-render
        bus.emit('chat:delivery-status', botId, clientMsgId, deliveryStatus);
        return true;
      }
    }
    return false;
  },

  /** Clear stale 'processing' delivery statuses for a bot (called when turn ends). */
  clearProcessingDeliveryStatuses(botId: string): void {
    if (!_msgMap[botId]) return;
    let changed = false;
    for (const msg of _msgMap[botId].values()) {
      if (msg.deliveryStatus === 'processing' || msg.deliveryStatus === 'agent_processing' || msg.deliveryStatus === 'sending' || msg.deliveryStatus === 'sent' || msg.deliveryStatus === 'delivered') {
        msg.deliveryStatus = 'replied';
        changed = true;
        if (msg.clientMsgId) {
          bus.emit('chat:delivery-status', botId, msg.clientMsgId, 'replied');
        }
      }
    }
    if (changed) this.save(botId);
  },

  hasConfirmedMessage(botId: string, eventKey: string): boolean {
    const map = _msgMap[botId];
    if (!map || !eventKey) return false;
    const msg = map.get(eventKey);
    return !!msg && msg.status === 'confirmed';
  },

  findByClientMsgId(botId: string, clientMsgId: string): ChatMessage | null {
    if (!clientMsgId || !_msgMap[botId]) return null;
    for (const msg of _msgMap[botId].values()) {
      if (msg.clientMsgId === clientMsgId) return msg;
    }
    return null;
  },

  prependMessages(botId: string, messages: Array<{
    role: string; text: string; ttsText?: string;
    ts?: string; eventKey?: string; serverSeq?: number | null;
    messageId?: string | null; sourceChannel?: string;
  }>): void {
    _ensureMap(botId);
    const map = _msgMap[botId];
    for (const sm of messages) {
      const ek = String(sm.eventKey || '');
      if (!ek || map.has(ek)) continue;
      const msg = _makeMsg(sm.role, sm.text, {
        ttsText: sm.ttsText || (sm.role === 'assistant' ? sm.text : ''),
        ts: sm.ts || '',
        eventKey: ek,
        status: 'confirmed',
        serverSeq: sm.serverSeq ?? null,
        messageId: sm.messageId ?? null,
        sourceChannel: sm.sourceChannel || 'web',
      });
      map.set(ek, msg);
    }
    this.save(botId);
    _notify(botId);
  },

  getViewport(botId: string): ViewportState {
    return _ensureViewport(botId);
  },

  setViewportCursor(botId: string, oldestSeq: number | null, hasMore: boolean): void {
    const vp = _ensureViewport(botId);
    vp.oldestLoadedSeq = oldestSeq;
    vp.hasMore = hasMore;
  },

  switchToHistoryView(botId: string, messages: Array<{
    role: string; text: string; ttsText?: string;
    ts?: string; eventKey?: string; serverSeq?: number | null;
    messageId?: string | null; sourceChannel?: string;
  }>): void {
    _ensureMap(botId);
    const vp = _ensureViewport(botId);
    // Cache current latest state
    vp.latestMessages = _getSortedMessages(botId).map(m => ({ ...m }));
    vp.latestMaxServerSeq = _maxServerSeq[botId] || 0;
    vp.latestRevision = _revision[botId] || 0;
    vp.mode = 'history';
    // Replace messages with history page
    const map = _msgMap[botId];
    map.clear();
    for (const sm of messages) {
      const ek = String(sm.eventKey || '');
      if (!ek) continue;
      const msg = _makeMsg(sm.role, sm.text, {
        ttsText: sm.ttsText || (sm.role === 'assistant' ? sm.text : ''),
        ts: sm.ts || '',
        eventKey: ek,
        status: 'confirmed',
        serverSeq: sm.serverSeq ?? null,
        messageId: sm.messageId ?? null,
        sourceChannel: sm.sourceChannel || 'web',
      });
      map.set(ek, msg);
    }
    _notify(botId);
  },

  returnToLatest(botId: string): void {
    _ensureMap(botId);
    const vp = _ensureViewport(botId);
    if (vp.mode !== 'history') return;
    // Restore cached latest messages
    const map = _msgMap[botId];
    map.clear();
    for (const m of vp.latestMessages) {
      const key = m.eventKey || _genTempId();
      map.set(key, { ...m });
    }
    _maxServerSeq[botId] = vp.latestMaxServerSeq;
    _syncInsertionSeq(vp.latestMaxServerSeq);
    _revision[botId] = vp.latestRevision;
    vp.mode = 'latest';
    vp.latestMessages = [];
    this.save(botId);
    _notify(botId);
  },

  save(botId: string): void {
    const msgs = _getSortedMessages(botId).map(m => ({
      role: m.role,
      text: m.text,
      ttsText: m.ttsText || '',
      ts: m.ts || '',
      eventKey: m.eventKey || '',
      intermediate: !!m.intermediate,
      contentKind: m.contentKind || 'result',
      status: m.status || 'confirmed',
      deliveryStatus: m.deliveryStatus || '',
      clientMsgId: m.clientMsgId || '',
      serverSeq: m.serverSeq ?? null,
      messageId: m.messageId ?? null,
      sourceChannel: m.sourceChannel || 'web',
    }));
    const payload = {
      revision: _revision[botId] || 0,
      maxServerSeq: _maxServerSeq[botId] || 0,
      messages: msgs,
      version: 3,
    };
    _idbSave(botId, payload);
    try { localStorage.setItem(STORAGE_KEY + botId, JSON.stringify(payload)); } catch (_e) { /* silent */ }
  },

  async load(botId: string): Promise<void> {
    _ensureMap(botId);
    let payload: { revision?: number; maxServerSeq?: number; messages?: unknown[]; version?: number } | null = null;
    try {
      const d = await _idbLoad(botId) as unknown;
      if (d) payload = Array.isArray(d) ? { revision: 0, messages: d } : d as NonNullable<typeof payload>;
    } catch (_e) { /* silent */ }
    if (!payload) {
      try {
        const s = localStorage.getItem(STORAGE_KEY + botId);
        if (s) {
          const p = JSON.parse(s);
          payload = Array.isArray(p) ? { revision: 0, messages: p } : p;
        }
      } catch (_e) { /* silent */ }
    }
    if (payload) {
      _revision[botId] = Number(payload.revision || 0);
      _maxServerSeq[botId] = Number(payload.maxServerSeq || 0);
      const map = _msgMap[botId];
      map.clear();
      const msgs = (payload.messages || []) as Array<Record<string, unknown>>;
      for (const m of msgs) {
        const msg = _makeMsg(m.role as string, m.text as string, {
          ttsText: (m.ttsText || '') as string,
          ts: (m.ts || '') as string,
          eventKey: (m.eventKey || '') as string,
          intermediate: !!m.intermediate,
          contentKind: ((m.contentKind || 'result') as string) as ChatMessage['contentKind'],
          status: (m.status || (m.eventKey ? 'confirmed' : 'pending')) as MessageStatus,
          deliveryStatus: (m.deliveryStatus || '') as DeliveryStatus,
          clientMsgId: (m.clientMsgId || '') as string,
          serverSeq: (m.serverSeq as number) ?? null,
          messageId: (m.messageId as string) ?? null,
          sourceChannel: (m.sourceChannel as string) || 'web',
        });
        const key = msg.eventKey || _genTempId();
        map.set(key, msg);
      }
      // Detect and purge orphans (confirmed messages with no serverSeq).
      // These are ghost messages from previous WS sessions that were saved
      // to IDB but never matched by mergeFromServer.  Delete them outright
      // and force a full fetch so the server re-supplies the authoritative
      // copies with proper serverSeq.
      let hasOrphans = false;
      for (const [key, msg] of Array.from(map.entries())) {
        if (msg.serverSeq == null && !msg.intermediate
            && msg.status !== 'pending' && msg.status !== 'streaming') {
          log.warn('Orphan purged on load', { botId, key, text: msg.text?.slice(0, 40) });
          map.delete(key);
          hasOrphans = true;
        }
      }
      if (hasOrphans) {
        _maxServerSeq[botId] = 0;
      }
      // Clean up stale pending messages (ISSUE-08).
      // Pending messages older than 5 minutes with no active outbox entry
      // are permanent orphans — mark them as failed so the user sees the
      // failure indicator and can retry manually.
      const STALE_PENDING_THRESHOLD_MS = 5 * 60 * 1000;
      const now = Date.now();
      for (const msg of map.values()) {
        if (msg.status !== 'pending') continue;
        const tsMs = _parseMsgTsMs(msg.ts);
        if (tsMs === null) {
          // No timestamp — treat as stale if message has no serverSeq
          // (it was never confirmed and we can't determine age)
          if (msg.serverSeq == null) {
            log.warn('Stale pending (no ts) marked failed', { botId, text: msg.text?.slice(0, 40) });
            msg.status = 'failed' as MessageStatus;
          }
          continue;
        }
        if (now - tsMs > STALE_PENDING_THRESHOLD_MS) {
          log.warn('Stale pending marked failed', { botId, ageMs: now - tsMs, text: msg.text?.slice(0, 40) });
          msg.status = 'failed' as MessageStatus;
        }
      }
      _notify(botId);
    }
  },

  async loadAll(botIds: string[]): Promise<void> {
    await Promise.all(botIds.map(id => this.load(id)));
  },

  clearCache(botId: string): void {
    _ensureMap(botId);
    _msgMap[botId].clear();
    _revision[botId] = 0;
    _maxServerSeq[botId] = 0;
    _idbSave(botId, { revision: 0, maxServerSeq: 0, messages: [], version: 3 });
    try { localStorage.removeItem(STORAGE_KEY + botId); } catch (_e) { /* silent */ }
    _notify(botId);
  },
};
