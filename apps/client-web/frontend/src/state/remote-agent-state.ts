// Layer 3: RemoteAgentState — per-bot remote agent status (informational only)
//
// idle ↔ queued ↔ processing ↔ generating ↔ idle
//
// Purely informational: does NOT drive other layers. Used by Projection
// for detailed status text (e.g., "thinking" vs "generating").
// Derived from WS `status` messages + classifyServerStatus().

import { bus } from '../core/event-bus';

export type RemoteAgentStateValue = 'idle' | 'queued' | 'processing' | 'generating';

const _states: Record<string, RemoteAgentStateValue> = {};

export const remoteAgentState = {
  /** Get current remote agent state for a bot */
  get(botId: string): RemoteAgentStateValue {
    return _states[botId] || 'idle';
  },

  /** Update remote agent state — no transition guard (informational) */
  update(botId: string, state: RemoteAgentStateValue): void {
    const prev = _states[botId] || 'idle';
    if (prev === state) return;
    _states[botId] = state;
    bus.emit('agent:state-change', { botId, from: prev, to: state });
  },

  /** Reset to idle */
  resetToIdle(botId: string): void {
    const prev = _states[botId] || 'idle';
    _states[botId] = 'idle';
    if (prev !== 'idle') {
      bus.emit('agent:state-change', { botId, from: prev, to: 'idle' });
    }
  },

  /** Ensure state entry exists */
  ensureBot(botId: string): void {
    if (!(botId in _states)) _states[botId] = 'idle';
  },

  /** Reset all for testing */
  _reset(): void {
    for (const k of Object.keys(_states)) _states[k] = 'idle';
  },
};

// Map server status text → RemoteAgentStateValue
export function classifyToAgentState(rawTxt: string): RemoteAgentStateValue | null {
  const txt = rawTxt.replace(/\s+/g, '');
  if (txt.includes('已排队') || txt.includes('前面还有一条在处理')) return 'queued';
  if (txt.includes('思考中') || txt.includes('处理中') || txt.includes('还在处理') || txt.includes('识别中')) return 'processing';
  if (txt.includes('生成语音') || txt.includes('生成回复') || txt.includes('生成中') || txt.includes('生成')) return 'generating';
  return null;
}
