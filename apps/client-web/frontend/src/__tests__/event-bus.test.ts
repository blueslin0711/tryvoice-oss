/**
 * 10.1 EventBus tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bus } from '../core/event-bus';

beforeEach(() => {
  bus.removeAll();
});

describe('EventBus', () => {
  it('on + emit calls handler', () => {
    const fn = vi.fn();
    bus.on('test', fn);
    bus.emit('test', 42);
    expect(fn).toHaveBeenCalledWith(42);
  });

  it('off removes handler', () => {
    const fn = vi.fn();
    bus.on('test', fn);
    bus.off('test', fn);
    bus.emit('test');
    expect(fn).not.toHaveBeenCalled();
  });

  it('once fires only once', () => {
    const fn = vi.fn();
    bus.once('test', fn);
    bus.emit('test', 'a');
    bus.emit('test', 'b');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('handler exception does not break other handlers', () => {
    const err = vi.fn(() => { throw new Error('boom'); });
    const ok = vi.fn();
    bus.on('test', err);
    bus.on('test', ok);
    bus.emit('test');
    expect(ok).toHaveBeenCalled();
  });

  it('removeAll(event) clears only that event', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    bus.on('a', fn1);
    bus.on('b', fn2);
    bus.removeAll('a');
    bus.emit('a');
    bus.emit('b');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalled();
  });

  it('removeAll() clears all events', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    bus.on('a', fn1);
    bus.on('b', fn2);
    bus.removeAll();
    bus.emit('a');
    bus.emit('b');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });

  it('emit with multiple args', () => {
    const fn = vi.fn();
    bus.on('test', fn);
    bus.emit('test', 1, 'two', { three: 3 });
    expect(fn).toHaveBeenCalledWith(1, 'two', { three: 3 });
  });

  it('emit non-existent event does nothing', () => {
    expect(() => bus.emit('nonexistent')).not.toThrow();
  });
});
