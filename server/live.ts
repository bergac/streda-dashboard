// In-process event bus: the collector announces changes, the WebSocket forwards them to browsers.

import { EventEmitter } from 'node:events';

export type LiveEvent =
  | { type: 'state'; ieeeAddress: string; state: Record<string, unknown>; attributeUpdated: Record<string, string>; updatedAt: string }
  | { type: 'availability'; ieeeAddress: string; availability: string; at: string }
  | { type: 'button'; ieeeAddress: string; action: string; channel: string | null; ts: string }
  | { type: 'devices' }
  | { type: 'status'; status: CollectorStatus };

export interface CollectorStatus {
  host: string;
  mqtt: 'connecting' | 'connected' | 'disconnected';
  lastError: string | null;
  bridgeState: string | null;
  lastMessageAt: string | null;
  listeningSince: string | null;
}

export class LiveBus extends EventEmitter {
  publish(event: LiveEvent) {
    this.emit('event', event);
  }
  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}
