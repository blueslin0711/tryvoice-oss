// Voice history store — IndexedDB-backed storage for all voice recordings
// Keeps the last MAX_ENTRIES recordings (including cancelled ones) for replay / retranscribe / resend.

import { createLogger } from '../logging/logger';

const log = createLogger('store.voice-history');

const IDB_NAME = 'voice-history';
const IDB_VERSION = 1;
const STORE_NAME = 'entries';
const MAX_ENTRIES = 10;

export interface VoiceHistoryEntry {
  id?: number;              // IDB autoIncrement
  botId: string;
  audioB64: string;         // base64 webm/opus
  transcript: string;       // STT result, '' if not yet transcribed
  status: 'recorded' | 'transcribed' | 'sent';
  cancelled: boolean;       // true = recording was cancelled by user
  createdAt: number;        // Date.now()
}

let _idb: IDBDatabase | null = null;

function _openIDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (_idb) { resolve(_idb); return; }
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = (e) => { _idb = (e.target as IDBOpenDBRequest).result; resolve(_idb); };
      req.onerror = () => { log.warn('Failed to open voice-history IDB'); resolve(null); };
    } catch (_e) { resolve(null); }
  });
}

async function _pruneOld(maxCount = MAX_ENTRIES): Promise<void> {
  const db = await _openIDB();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const total = countReq.result;
      if (total <= maxCount) { resolve(); return; }
      const toDelete = total - maxCount;
      const cursorReq = store.openCursor(); // ascending by id
      let deleted = 0;
      cursorReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor && deleted < toDelete) {
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => resolve();
    };
    countReq.onerror = () => resolve();
  });
}

export const voiceHistoryStore = {
  async saveRecording(entry: Omit<VoiceHistoryEntry, 'id'>): Promise<number> {
    const db = await _openIDB();
    if (!db) return -1;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).add(entry);
      req.onsuccess = () => {
        const id = req.result as number;
        _pruneOld().catch(() => {});
        resolve(id);
      };
      req.onerror = () => { log.warn('Failed to save voice history entry'); resolve(-1); };
    });
  },

  async getAll(): Promise<VoiceHistoryEntry[]> {
    const db = await _openIDB();
    if (!db) return [];
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const entries = (req.result || []) as VoiceHistoryEntry[];
        entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(entries);
      };
      req.onerror = () => resolve([]);
    });
  },

  async getEntry(id: number): Promise<VoiceHistoryEntry | null> {
    const db = await _openIDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve((req.result as VoiceHistoryEntry) || null);
      req.onerror = () => resolve(null);
    });
  },

  async updateTranscript(id: number, transcript: string): Promise<void> {
    const db = await _openIDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const entry = getReq.result as VoiceHistoryEntry | undefined;
        if (!entry) { resolve(); return; }
        entry.transcript = transcript;
        if (entry.status === 'recorded') entry.status = 'transcribed';
        store.put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      };
      getReq.onerror = () => resolve();
    });
  },

  async updateStatus(id: number, status: VoiceHistoryEntry['status']): Promise<void> {
    const db = await _openIDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const entry = getReq.result as VoiceHistoryEntry | undefined;
        if (!entry) { resolve(); return; }
        entry.status = status;
        store.put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      };
      getReq.onerror = () => resolve();
    });
  },

  async deleteEntry(id: number): Promise<void> {
    const db = await _openIDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },

  async clearAll(): Promise<void> {
    const db = await _openIDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },
};
