/**
 * 10.5 BOT_IDS and types tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BOT_IDS, setRuntimeBotIds, getRuntimeBotIds, SYNC_KEYS } from '../core/types';

beforeEach(() => {
  setRuntimeBotIds([]);
});

describe('BOT_IDS', () => {
  it('starts empty (populated by server)', () => {
    expect(BOT_IDS).toEqual([]);
  });

  it('setRuntimeBotIds replaces BOT_IDS', () => {
    setRuntimeBotIds(['a', 'b']);
    expect(BOT_IDS).toEqual(['a', 'b']);
    expect(getRuntimeBotIds()).toEqual(['a', 'b']);
  });

  it('setRuntimeBotIds deduplicates', () => {
    setRuntimeBotIds(['x', 'x', 'y']);
    expect(BOT_IDS).toEqual(['x', 'y']);
  });

  it('setRuntimeBotIds allows empty array', () => {
    setRuntimeBotIds([]);
    expect(BOT_IDS).toEqual([]);
  });

  it('setRuntimeBotIds trims and filters blank', () => {
    setRuntimeBotIds([' hello ', '', '  ']);
    expect(BOT_IDS).toEqual(['hello']);
  });

  it('getRuntimeBotIds returns a copy', () => {
    setRuntimeBotIds(['main']);
    const ids = getRuntimeBotIds();
    ids.push('extra');
    expect(BOT_IDS).not.toContain('extra');
  });
});

describe('SYNC_KEYS', () => {
  it('contains expected keys', () => {
    expect(SYNC_KEYS).toContain('voices');
    expect(SYNC_KEYS).toContain('theme');
    expect(SYNC_KEYS).toContain('inputMode');
  });
});
