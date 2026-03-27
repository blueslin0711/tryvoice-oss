// Sync manager — History sync scheduling and network requests
// Ported from sync-manager.js

import { createLogger } from '../logging/logger';
import { chatStore } from '../store/chat-store';
import type { HistoryResponse, ServerHistoryMessage } from '../core/types';
import { getClientId, getDeviceType } from './client-identity';

function _clientHeaders(): Record<string, string> {
  return { 'X-Client-Id': getClientId(), 'X-Device-Type': getDeviceType() };
}

const log = createLogger('network.sync');

const INITIAL_LOAD_LIMIT = 100;
const SCROLL_LOAD_LIMIT = 100;

const _inFlight: Record<string, boolean> = {};
const _timers: Record<string, ReturnType<typeof setTimeout>> = {};
const _targets: Record<string, number> = {};

type MappedMsg = {
  role: string; text: string; ttsText: string;
  ts: string; eventKey: string; serverSeq: number | null;
  messageId: string | null; intermediate?: boolean;
  sourceChannel: string; contentKind?: string;
};

function _mapServerMsg(m: ServerHistoryMessage): MappedMsg {
  const msg: MappedMsg = {
    role: m.role,
    text: m.text,
    ttsText: m.role === 'assistant' ? m.text : '',
    ts: m.ts || '',
    eventKey: m.eventKey || '',
    serverSeq: m.serverSeq ?? null,
    messageId: m.messageId ?? null,
    sourceChannel: m.sourceChannel || 'web',
  };
  // Carry contentKind/intermediate from server so history-loaded messages
  // respect granularity filtering (e.g. thinking blocks).
  if (m.contentKind) {
    msg.contentKind = m.contentKind;
    msg.intermediate = m.contentKind !== 'result';
  }
  return msg;
}

async function _doSync(botId: string): Promise<void> {
  if (_inFlight[botId]) return;
  _inFlight[botId] = true;
  try {
    const cursor = chatStore.getMaxServerSeq(botId);

    if (cursor > 0) {
      const resp = await fetch(`/history/${botId}?afterSeq=${encodeURIComponent(cursor)}`, {
        headers: _clientHeaders(),
      });
      if (!resp.ok) return;
      const data: HistoryResponse = await resp.json();
      const syncMeta = data.sync || {};
      const remoteRevision = Number(syncMeta.historyRevision || 0);
      const responseMaxSeq = Number(syncMeta.maxServerSeq || 0);
      const serverMsgs = (data.messages || []).map(_mapServerMsg);

      if (serverMsgs.length === 0 && responseMaxSeq > 0 && cursor > responseMaxSeq) {
        log.warn('Stale cursor, resetting', { botId, cursor, serverMax: responseMaxSeq });
        chatStore.clearCache(botId);
      } else if (serverMsgs.length === 0 && remoteRevision > chatStore.getRevision(botId) + 3) {
        // Backend keeps reporting changes (revision growing) but no new
        // messages are returned — likely a server_seq gap.  Force a full
        // reload to resync.
        log.warn('Revision drift, forcing full reload', { botId, cursor, revision: remoteRevision, localRev: chatStore.getRevision(botId) });
        chatStore.clearCache(botId);
      } else if (serverMsgs.length > 0) {
        chatStore.mergeFromServer(botId, serverMsgs, remoteRevision);
        _targets[botId] = 0;
        return;
      } else {
        chatStore.setRevision(botId, remoteRevision);
        _targets[botId] = 0;
        return;
      }
    }

    // Initial load: fetch latest 100 messages
    // Release _inFlight before calling _initialLoadBot (it manages its own lock)
    _inFlight[botId] = false;
    await _initialLoadBot(botId);
    _targets[botId] = 0;
  } catch (e) {
    log.error('Sync error', { botId, detail: String(e) });
  } finally {
    _inFlight[botId] = false;
    if ((_targets[botId] || 0) > chatStore.getRevision(botId)) {
      _schedule(botId, 120, _targets[botId]);
    }
  }
}

function _schedule(botId: string, delayMs: number, minRevision: number): void {
  _targets[botId] = Math.max(_targets[botId] || 0, Number(minRevision || 0));
  if (_timers[botId]) clearTimeout(_timers[botId]);
  _timers[botId] = setTimeout(() => {
    delete _timers[botId];
    _doSync(botId);
  }, Math.max(0, delayMs || 0));
}

type FullSyncSummary = {
  botId: string;
  fetched: number;
  pages: number;
  maxServerSeq: number;
};

async function _initialLoadBot(botId: string): Promise<FullSyncSummary> {
  if (_inFlight[botId]) {
    return { botId, fetched: 0, pages: 0, maxServerSeq: chatStore.getMaxServerSeq(botId) };
  }
  _inFlight[botId] = true;
  try {
    const resp = await fetch(`/history/${botId}?limit=${INITIAL_LOAD_LIMIT}`, {
      headers: _clientHeaders(),
    });
    if (!resp.ok) return { botId, fetched: 0, pages: 0, maxServerSeq: 0 };
    const data: HistoryResponse = await resp.json();
    const syncMeta = data.sync || {};
    const remoteRevision = Number(syncMeta.historyRevision || 0);
    const serverMsgs = (data.messages || []).map(_mapServerMsg);
    chatStore.mergeFromServer(botId, serverMsgs, remoteRevision);

    const hasMore = data.hasMore ?? true;
    const minSeq = data.minServerSeq ?? (serverMsgs.length > 0 ? serverMsgs[0].serverSeq : null);
    chatStore.setViewportCursor(botId, minSeq, hasMore);

    return {
      botId,
      fetched: serverMsgs.length,
      pages: 1,
      maxServerSeq: Number(syncMeta.maxServerSeq || chatStore.getMaxServerSeq(botId)),
    };
  } catch (_e) {
    return { botId, fetched: 0, pages: 0, maxServerSeq: chatStore.getMaxServerSeq(botId) };
  } finally {
    _inFlight[botId] = false;
  }
}

export const syncManager = {
  schedule(botId: string, delayMs?: number, minRevision?: number): void {
    _schedule(botId, delayMs || 0, minRevision || 0);
  },

  syncNow(botId: string): Promise<void> {
    return _doSync(botId);
  },

  scheduleAll(botIds: string[], delayMs?: number): void {
    botIds.forEach(id => _schedule(id, delayMs || 0, 0));
  },

  async initSync(botIds: string[]): Promise<void> {
    await chatStore.loadAll(botIds);
    await Promise.all(botIds.map(id => _doSync(id)));
  },

  async fullSyncAll(botIds: string[]): Promise<FullSyncSummary[]> {
    const out: FullSyncSummary[] = [];
    for (const id of botIds) {
      // sequential to reduce DB/WS pressure on mobile devices
      // and keep gateway fetch pattern stable.
      // eslint-disable-next-line no-await-in-loop
      const r = await _initialLoadBot(id);
      out.push(r);
    }
    return out;
  },

  async loadOlderMessages(botId: string): Promise<{ loaded: number; hasMore: boolean }> {
    const vp = chatStore.getViewport(botId);
    if (!vp.hasMore || !vp.oldestLoadedSeq) return { loaded: 0, hasMore: false };
    try {
      const resp = await fetch(
        `/history/${botId}?beforeSeq=${encodeURIComponent(vp.oldestLoadedSeq)}&limit=${SCROLL_LOAD_LIMIT}`,
        { headers: _clientHeaders() },
      );
      if (!resp.ok) return { loaded: 0, hasMore: vp.hasMore };
      const data: HistoryResponse = await resp.json();
      const msgs = (data.messages || []).map(_mapServerMsg);
      if (msgs.length > 0) {
        chatStore.prependMessages(botId, msgs);
        const newMinSeq = data.minServerSeq ?? msgs[0].serverSeq;
        chatStore.setViewportCursor(botId, newMinSeq, data.hasMore ?? false);
      }
      return { loaded: msgs.length, hasMore: data.hasMore ?? false };
    } catch (_e) {
      return { loaded: 0, hasMore: vp.hasMore };
    }
  },

  async loadAroundMessage(botId: string, serverSeq: number): Promise<boolean> {
    try {
      const resp = await fetch(
        `/history/${botId}?aroundSeq=${encodeURIComponent(serverSeq)}&limit=${SCROLL_LOAD_LIMIT}`,
        { headers: _clientHeaders() },
      );
      if (!resp.ok) return false;
      const data: HistoryResponse = await resp.json();
      const msgs = (data.messages || []).map(_mapServerMsg);
      if (msgs.length === 0) return false;
      chatStore.switchToHistoryView(botId, msgs);
      const minSeq = data.minServerSeq ?? msgs[0].serverSeq;
      chatStore.setViewportCursor(botId, minSeq, data.hasMore ?? false);
      return true;
    } catch (_e) {
      return false;
    }
  },
};
