// Client outbox — Reliable message delivery queue
// Ported from client-outbox.js

import { bus } from '../core/event-bus';
import { createLogger } from '../logging/logger';
import * as ws from './ws-client';
import type { OutboxEntry } from '../core/types';

const log = createLogger('network.outbox');

const IDB_NAME = 'voice-chat-outbox';
const IDB_VERSION = 2;
const STORE_NAME = 'outbox';
const MAX_RETRIES = 3;

let _idb: IDBDatabase | null = null;
let _draining = false;

function _normalizeMsgId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'bigint') return value.toString();
  return '';
}

function _msgIdDeleteCandidates(msgId: string): IDBValidKey[] {
  const id = _normalizeMsgId(msgId);
  if (!id) return [''];
  const keys: IDBValidKey[] = [id];
  if (/^-?\d+$/.test(id)) {
    const n = Number(id);
    if (Number.isSafeInteger(n)) keys.push(n);
  }
  return keys;
}

function _normalizeOutboxEntry(raw: unknown, fallbackKey?: IDBValidKey): OutboxEntry | null {
  const src = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  const msgId = _normalizeMsgId(src.msgId) || _normalizeMsgId(src.id) || _normalizeMsgId(fallbackKey);
  if (!msgId) return null;

  const type = src.type === 'audio' ? 'audio' : 'text';
  const statusRaw = typeof src.status === 'string' ? src.status : '';
  const status: OutboxEntry['status'] = (
    statusRaw === 'sent' || statusRaw === 'acked' || statusRaw === 'failed' || statusRaw === 'queued'
  ) ? statusRaw : 'queued';

  const retryCountRaw = Number(src.retryCount);
  const createdAtRaw = Number(src.createdAt);

  return {
    msgId,
    type,
    botId: typeof src.botId === 'string' ? src.botId : '',
    text: typeof src.text === 'string' ? src.text : '',
    audioB64: typeof src.audioB64 === 'string' ? src.audioB64 : (typeof src.data === 'string' ? src.data : ''),
    trimEndWord: typeof src.trimEndWord === 'string' ? src.trimEndWord : '',
    status,
    retryCount: Number.isFinite(retryCountRaw) && retryCountRaw >= 0 ? Math.trunc(retryCountRaw) : 0,
    createdAt: Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.trunc(createdAtRaw) : Date.now(),
  };
}

function _entryNeedsRewrite(raw: Record<string, unknown>, normalized: OutboxEntry, key: IDBValidKey): boolean {
  return (
    _normalizeMsgId(key) !== normalized.msgId ||
    _normalizeMsgId(raw.msgId) !== normalized.msgId ||
    (raw.type === 'audio' ? 'audio' : 'text') !== normalized.type ||
    (typeof raw.botId === 'string' ? raw.botId : '') !== normalized.botId ||
    (typeof raw.text === 'string' ? raw.text : '') !== normalized.text ||
    (typeof raw.audioB64 === 'string' ? raw.audioB64 : (typeof raw.data === 'string' ? raw.data : '')) !== normalized.audioB64 ||
    (typeof raw.trimEndWord === 'string' ? raw.trimEndWord : '') !== normalized.trimEndWord ||
    (typeof raw.status === 'string' ? raw.status : 'queued') !== normalized.status ||
    Math.trunc(Number(raw.retryCount) || 0) !== normalized.retryCount ||
    Math.trunc(Number(raw.createdAt) || 0) !== normalized.createdAt
  );
}

function _dedupeEntries(entries: OutboxEntry[]): OutboxEntry[] {
  const byMsgId = new Map<string, OutboxEntry>();
  for (const entry of entries) {
    const prev = byMsgId.get(entry.msgId);
    if (!prev || (entry.createdAt || 0) < (prev.createdAt || 0)) {
      byMsgId.set(entry.msgId, entry);
    }
  }
  return Array.from(byMsgId.values());
}

function _openIDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (_idb) { resolve(_idb); return; }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        const store = (e.target as IDBOpenDBRequest).transaction?.objectStore(STORE_NAME);
        const keyPath = store?.keyPath;
        if (keyPath !== 'msgId') {
          db.deleteObjectStore(STORE_NAME);
          db.createObjectStore(STORE_NAME, { keyPath: 'msgId' });
        }
      } else {
        db.createObjectStore(STORE_NAME, { keyPath: 'msgId' });
      }
    };
    req.onsuccess = (e) => { _idb = (e.target as IDBOpenDBRequest).result; resolve(_idb); };
    req.onerror = () => resolve(null);
  });
}

async function _idbPut(entry: OutboxEntry): Promise<void> {
  try {
    const db = await _openIDB();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entry);
  } catch (_e) { /* silent */ }
}

async function _idbDelete(msgId: string): Promise<void> {
  try {
    const db = await _openIDB();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const key of _msgIdDeleteCandidates(msgId)) {
      store.delete(key);
    }
  } catch (_e) { /* silent */ }
}

async function _idbGetAll(): Promise<OutboxEntry[]> {
  try {
    const db = await _openIDB();
    if (!db) return [];
    return new Promise((resolve) => {
      let done = false;
      const finish = (rows: OutboxEntry[]) => {
        if (done) return;
        done = true;
        resolve(_dedupeEntries(rows));
      };

      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const rows: OutboxEntry[] = [];
      const req = store.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;

        const rawValue = cursor.value;
        const rawObj = (rawValue && typeof rawValue === 'object')
          ? (rawValue as Record<string, unknown>)
          : {};
        const normalized = _normalizeOutboxEntry(rawObj, cursor.primaryKey);
        if (!normalized) {
          cursor.delete();
          cursor.continue();
          return;
        }

        if (_entryNeedsRewrite(rawObj, normalized, cursor.primaryKey)) {
          if (_normalizeMsgId(cursor.primaryKey) !== normalized.msgId) {
            store.put(normalized);
            cursor.delete();
          } else {
            cursor.update(normalized);
          }
        }

        rows.push(normalized);
        cursor.continue();
      };

      req.onerror = () => finish([]);
      tx.oncomplete = () => finish(rows);
      tx.onerror = () => finish(rows);
      tx.onabort = () => finish(rows);
    });
  } catch (_e) { return []; }
}

function _trySend(entry: OutboxEntry): boolean {
  if (!ws.isConnected()) return false;
  if (!entry.msgId) return false;
  let payload: Record<string, unknown>;
  if (entry.type === 'audio') {
    payload = { type: 'audio', data: entry.audioB64, botId: entry.botId, msgId: entry.msgId };
    if (entry.trimEndWord) payload.trimEndWord = entry.trimEndWord;
  } else {
    payload = { type: 'text', text: entry.text, botId: entry.botId, msgId: entry.msgId };
  }
  const sent = ws.send(payload);
  if (sent) {
    ws.trackAck(entry.msgId, entry.botId);
    entry.status = 'sent';
    _idbPut(entry);
    bus.emit('outbox:status', entry.msgId, 'sent', entry);
  }
  return sent;
}

export const outbox = {
  init(): void {
    _openIDB();
  },

  async enqueue(entry: {
    type: 'text' | 'audio';
    botId: string;
    text?: string;
    audioB64?: string;
    trimEndWord?: string;
  }, msgId?: string): Promise<string> {
    if (!msgId) msgId = ws.nextMsgId();
    const outboxEntry: OutboxEntry = {
      msgId,
      type: entry.type || 'text',
      botId: entry.botId || '',
      text: entry.text || '',
      audioB64: entry.audioB64 || '',
      trimEndWord: entry.trimEndWord || '',
      status: 'queued',
      retryCount: 0,
      createdAt: Date.now(),
    };
    await _idbPut(outboxEntry);
    bus.emit('outbox:status', msgId, 'queued', outboxEntry);
    _trySend(outboxEntry);
    return msgId;
  },

  async drain(): Promise<void> {
    if (_draining) return;
    _draining = true;
    try {
      const entries = await _idbGetAll();
      entries.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      for (const entry of entries) {
        if (entry.status === 'acked' || entry.status === 'failed') {
          await _idbDelete(entry.msgId);
          continue;
        }
        if (entry.retryCount >= MAX_RETRIES) {
          entry.status = 'failed';
          await _idbDelete(entry.msgId);
          bus.emit('outbox:status', entry.msgId, 'failed', entry);
          continue;
        }
        if (!_trySend(entry)) {
          break;
        }
      }
    } finally {
      _draining = false;
    }
  },

  async onAck(msgId: string, botId = ''): Promise<void> {
    await _idbDelete(msgId);
    bus.emit('outbox:status', msgId, 'acked', { msgId, botId });
  },

  async onAckTimeout(msgId: string, _botId: string): Promise<void> {
    const entries = await _idbGetAll();
    const entry = entries.find(e => e.msgId === msgId);
    if (!entry) return;
    entry.retryCount += 1;
    if (entry.retryCount >= MAX_RETRIES) {
      entry.status = 'failed';
      await _idbPut(entry);
      bus.emit('outbox:status', msgId, 'failed', entry);
      log.warn('Message failed after max retries', { msgId, maxRetries: MAX_RETRIES });
      return;
    }
    entry.status = 'queued';
    await _idbPut(entry);
    log.info('Retrying message', { msgId, retryCount: entry.retryCount });
    if (ws.isConnected()) {
      _trySend(entry);
    }
  },

  async getPendingCount(): Promise<number> {
    const entries = await _idbGetAll();
    return entries.filter(e => e.status !== 'acked').length;
  },
};
