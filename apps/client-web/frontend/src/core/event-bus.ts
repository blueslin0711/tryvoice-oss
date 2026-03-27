// Simple typed pub/sub event bus
import { createLogger } from '../logging/logger';

const log = createLogger('core.event-bus');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => void;
export type { Handler };

class EventBus {
  private _handlers: Map<string, Set<Handler>> = new Map();

  on(event: string, handler: Handler): void {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event)!.add(handler);
  }

  off(event: string, handler: Handler): void {
    this._handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch (e) {
        log.error('Error in handler', { event, detail: String(e) });
      }
    }
  }

  once(event: string, handler: Handler): void {
    const wrapper: Handler = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    this.on(event, wrapper);
  }

  removeAll(event?: string): void {
    if (event) {
      this._handlers.delete(event);
    } else {
      this._handlers.clear();
    }
  }
}

export const bus = new EventBus();
