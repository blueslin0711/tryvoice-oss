// Structured frontend logger with ring buffer for buffered transport.

export interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: 'client';
  component: string;
  message: string;
  session_id?: string;
  turn_id?: string;
  data?: Record<string, unknown>;
  error?: string | null;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let _level: Level = 'info';
let _capacity = 500;
let _buffer: LogEntry[] = [];
let _context: { session_id?: string; turn_id?: string } = {};

export function setLogLevel(level: Level): void {
  _level = level;
}

export function setContext(ctx: { session_id?: string; turn_id?: string }): void {
  _context = { ..._context, ...ctx };
}

export function getBuffer(): LogEntry[] {
  return [..._buffer];
}

export function _setBufferCapacity(n: number): void {
  _capacity = n;
}

export function flush(): LogEntry[] {
  const entries = _buffer;
  _buffer = [];
  return entries;
}

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_THRESHOLD = 100;

let _sendFn: ((entries: LogEntry[]) => void) | null = null;
let _flushTimer: ReturnType<typeof setInterval> | null = null;

export function initLogTransport(sendFn: (entries: LogEntry[]) => void): void {
  _sendFn = sendFn;
  if (_flushTimer) clearInterval(_flushTimer);
  _flushTimer = setInterval(_autoFlush, FLUSH_INTERVAL_MS);
}

function _autoFlush(): void {
  if (_buffer.length === 0 || !_sendFn) return;
  const entries = flush();
  _sendFn(entries);
}

function _write(
  level: Level,
  component: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (LEVELS[level] < LEVELS[_level]) return;
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    source: 'client',
    component,
    message,
    ...(_context.session_id ? { session_id: _context.session_id } : {}),
    ...(_context.turn_id ? { turn_id: _context.turn_id } : {}),
    ...(data ? { data } : {}),
  };
  _buffer.push(entry);
  if (_buffer.length > _capacity) {
    _buffer = _buffer.slice(_buffer.length - _capacity);
  }
  if (_buffer.length >= FLUSH_THRESHOLD && _sendFn) _autoFlush();
}

export function createLogger(component: string): Logger {
  return {
    debug: (msg, data) => _write('debug', component, msg, data),
    info: (msg, data) => _write('info', component, msg, data),
    warn: (msg, data) => _write('warn', component, msg, data),
    error: (msg, data) => _write('error', component, msg, data),
  };
}
