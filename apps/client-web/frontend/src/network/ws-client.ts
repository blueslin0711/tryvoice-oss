// WebSocket connection management, ack tracking, reconnection
// Ported from ws-handler.js — same protocol

import { bus } from '../core/event-bus';
import { createLogger, initLogTransport, flush as flushLogs } from '../logging/logger';
import type { LogEntry } from '../logging/logger';
import { getWsUrl } from '../platform/native-bootstrap';
import { getClientId, getDeviceType } from './client-identity';

const log = createLogger('ws.client');

// Allow 3 missed pings (10s interval) + network jitter before closing
const WATCHDOG_TIMEOUT_MS = 45000;
const ACK_TIMEOUT_MS = 15000;
const MAX_RECONNECT_DELAY_MS = 10000;

let _ws: WebSocket | null = null;
let _reconnectDelay = 1000;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let _msgIdCounter = 0;
const _pendingAcks: Record<string, { botId: string; ts: number; timeout: ReturnType<typeof setTimeout> }> = {};

function _resetWatchdog(): void {
  _clearWatchdog();
  _watchdogTimer = setTimeout(() => {
    log.warn('Ping timeout, reconnecting');
    try { if (_ws) _ws.close(); } catch (_e) { /* ignore */ }
  }, WATCHDOG_TIMEOUT_MS);
}

function _clearWatchdog(): void {
  if (_watchdogTimer) {
    clearTimeout(_watchdogTimer);
    _watchdogTimer = null;
  }
}

export function connect(): void {
  _ws = new WebSocket(getWsUrl({ client_id: getClientId(), device_type: getDeviceType() }));

  _ws.onopen = () => {
    _reconnectDelay = 1000;
    bus.emit('ws:open');
    // Initialize log transport to send via this WebSocket
    initLogTransport((entries: LogEntry[]) => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ type: 'log:batch', entries }));
      }
    });
    // Flush any logs buffered before connection
    const pending = flushLogs();
    if (pending.length && _ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ type: 'log:batch', entries: pending }));
    }
  };

  _ws.onerror = (e) => {
    log.error('WebSocket error', { detail: String(e) });
  };

  _ws.onclose = (e) => {
    log.info('WebSocket closed', { code: e.code, reason: e.reason });
    _clearWatchdog();
    bus.emit('ws:close', e.code, e.reason);
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, _reconnectDelay);
    _reconnectDelay = Math.min(MAX_RECONNECT_DELAY_MS, delay * 2);
    _reconnectTimer = setTimeout(connect, delay);
  };

  _ws.onmessage = (e) => {
    const data = JSON.parse(e.data);

    // Any message from server proves the connection is alive
    _resetWatchdog();

    if (data.type === 'ping') {
      return;
    }

    if (data.type === 'ack') {
      const ackId = data.msgId as string;
      const botId = (data.botId || '') as string;
      if (ackId && _pendingAcks[ackId]) {
        clearTimeout(_pendingAcks[ackId].timeout);
        delete _pendingAcks[ackId];
        log.debug('Ack received', { msgId: ackId });
      }
      bus.emit('ws:ack', ackId, botId);
      return;
    }

    bus.emit('ws:message', data);
  };
}

export function send(obj: Record<string, unknown>): boolean {
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

export function isConnected(): boolean {
  return !!(_ws && _ws.readyState === WebSocket.OPEN);
}

export function nextMsgId(): string {
  return Date.now().toString(36) + '-' + (++_msgIdCounter);
}

export function trackAck(msgId: string, botId: string): void {
  _pendingAcks[msgId] = {
    botId,
    ts: Date.now(),
    timeout: setTimeout(() => {
      log.warn('Ack timeout', { msgId });
      if (_pendingAcks[msgId]) {
        delete _pendingAcks[msgId];
        bus.emit('ws:ack-timeout', msgId, botId);
      }
    }, ACK_TIMEOUT_MS),
  };
}

export function destroy(): void {
  _clearWatchdog();
  if (_reconnectTimer) clearTimeout(_reconnectTimer);
  for (const id of Object.keys(_pendingAcks)) {
    clearTimeout(_pendingAcks[id].timeout);
    delete _pendingAcks[id];
  }
  if (_ws) {
    try { _ws.close(); } catch (_e) { /* ignore */ }
    _ws = null;
  }
}
