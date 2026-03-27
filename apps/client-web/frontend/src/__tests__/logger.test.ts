import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('createLogger returns object with debug/info/warn/error methods', async () => {
    const { createLogger } = await import('../logging/logger');
    const log = createLogger('test.component');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('info() adds entry to buffer with correct shape', async () => {
    const { createLogger, getBuffer } = await import('../logging/logger');
    const log = createLogger('ws.client');
    log.info('Connected', { attempt: 1 });
    const entries = getBuffer();
    expect(entries.length).toBe(1);
    const entry = entries[0];
    expect(entry.level).toBe('info');
    expect(entry.source).toBe('client');
    expect(entry.component).toBe('ws.client');
    expect(entry.message).toBe('Connected');
    expect(entry.data).toEqual({ attempt: 1 });
    expect(entry.ts).toBeTruthy();
  });

  it('respects log level filtering', async () => {
    const { createLogger, getBuffer, setLogLevel } = await import('../logging/logger');
    setLogLevel('warn');
    const log = createLogger('test');
    log.debug('skip');
    log.info('skip');
    log.warn('keep');
    log.error('keep');
    const entries = getBuffer();
    expect(entries.length).toBe(2);
    expect(entries[0].level).toBe('warn');
    expect(entries[1].level).toBe('error');
  });

  it('ring buffer evicts oldest when full', async () => {
    const { createLogger, getBuffer, _setBufferCapacity } = await import('../logging/logger');
    _setBufferCapacity(3);
    const log = createLogger('test');
    log.info('a');
    log.info('b');
    log.info('c');
    log.info('d');
    const entries = getBuffer();
    expect(entries.length).toBe(3);
    expect(entries[0].message).toBe('b');
    expect(entries[2].message).toBe('d');
  });

  it('flush() returns entries and clears buffer', async () => {
    const { createLogger, flush, getBuffer } = await import('../logging/logger');
    const log = createLogger('test');
    log.info('msg1');
    log.info('msg2');
    const flushed = flush();
    expect(flushed.length).toBe(2);
    expect(getBuffer().length).toBe(0);
  });

  it('setContext attaches session_id and turn_id to new entries', async () => {
    const { createLogger, getBuffer, setContext } = await import('../logging/logger');
    setContext({ session_id: 's_abc', turn_id: 't_123' });
    const log = createLogger('ui.mic-state');
    log.info('Transition');
    const entry = getBuffer()[0];
    expect(entry.session_id).toBe('s_abc');
    expect(entry.turn_id).toBe('t_123');
  });
});
