// Talking to the server: REST for data, a WebSocket for live updates.

import { useEffect, useRef, useState } from 'react';

export interface Device {
  ieeeAddress: string;
  name: string;
  friendlyName: string;
  displayName: string | null;
  room: string | null;
  notes: string | null;
  hidden: boolean;
  category: string;
  model: string | null;
  vendor: string | null;
  description: string | null;
  powerSource: string | null;
  zigbeeType: string | null;
  firstSeen: string;
  lastSeen: string | null;
  removed: boolean;
  availability: string | null;
  state: Record<string, unknown>;
  attributeUpdated: Record<string, string>;
  switches: Array<{ channel: string; on: boolean }>;
  powerW: number | null;
  powerEstimated: boolean;
  battery: number | null;
  alerts: string[];
  /** Separate functions (buttons, buzzer, socket, light); empty when the unit is one single thing. */
  functions: DeviceFunction[];
}

export type FunctionRole = 'light' | 'socket' | 'dimmer' | 'button' | 'buzzer' | 'doorbell_button';

export interface DeviceFunction {
  channel: string;
  role: FunctionRole;
  label: string;
  name: string;
  named: boolean;
  room: string | null;
  notes: string | null;
  hidden: boolean;
  on: boolean | null;
  brightness: number | null;
  powerW: number | null;
  powerEstimated: boolean;
  lastPress: { action: string; name: string | null; ts: string } | null;
}

export interface CollectorStatus {
  host: string;
  mqtt: 'connecting' | 'connected' | 'disconnected';
  lastError: string | null;
  bridgeState: string | null;
  lastMessageAt: string | null;
  listeningSince: string | null;
}

export interface Status {
  collector: CollectorStatus;
  counts: { devices: number; readings: number; button_events: number; raw_messages: number; last_message_at: string | null };
  timezone: string;
}

export interface EnergyRow {
  period: string;
  ieeeAddress: string;
  name: string;
  room: string | null;
  wh: number;
  estimated: boolean;
}

export interface ButtonEvent {
  id: number;
  ts: string;
  ieee_address: string;
  action: string;
  action_name: string | null;
  channel: string | null;
  name: string;
  room: string | null;
}

export interface ButtonAction {
  action: string;
  name: string | null;
  count: number;
}

export interface Session {
  id: number;
  started_at: string;
  last_heartbeat: string;
  ended_at: string | null;
  end_reason: string | null;
}

export interface RawMessage {
  id: number;
  ts: string;
  topic: string;
  payload: string;
  retained: boolean;
}

export interface HistoryPoint {
  ts: string;
  value: number | string | boolean | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `request failed (${res.status})`);
  return body as T;
}

const enc = encodeURIComponent;

export const api = {
  status: () => request<Status>('/api/status'),
  devices: () => request<Device[]>('/api/devices'),
  device: (ieee: string) => request<Device & { definition: unknown }>(`/api/devices/${enc(ieee)}`),
  attributes: (ieee: string) => request<Array<{ attribute: string; kind: string; count: number }>>(`/api/devices/${enc(ieee)}/attributes`),
  history: (ieee: string, attribute: string, from: Date, to: Date) =>
    request<HistoryPoint[]>(`/api/devices/${enc(ieee)}/history?attribute=${enc(attribute)}&from=${from.toISOString()}&to=${to.toISOString()}`),
  saveLabel: (ieee: string, label: { displayName: string; room: string; notes: string; hidden: boolean }) =>
    request<Device>(`/api/devices/${enc(ieee)}/label`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(label),
    }),
  saveFunctionLabel: (ieee: string, channel: string, label: { displayName: string; room: string; notes: string; hidden: boolean }) =>
    request<Device>(`/api/devices/${enc(ieee)}/functions/${enc(channel)}/label`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(label),
    }),
  buttonActions: (ieee: string) => request<ButtonAction[]>(`/api/devices/${enc(ieee)}/actions`),
  saveButtonActions: (ieee: string, names: Record<string, string>) =>
    request<ButtonAction[]>(`/api/devices/${enc(ieee)}/actions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ names }),
    }),
  rooms: () => request<string[]>('/api/rooms'),
  energy: (from: Date, to: Date, interval: 'hour' | 'day' | 'month') =>
    request<EnergyRow[]>(`/api/energy?from=${from.toISOString()}&to=${to.toISOString()}&interval=${interval}`),
  buttons: (opts: { limit?: number; before?: string; ieee?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.before) q.set('before', opts.before);
    if (opts.ieee) q.set('ieee', opts.ieee);
    return request<ButtonEvent[]>(`/api/buttons?${q}`);
  },
  sessions: () => request<Session[]>('/api/sessions'),
  raw: (opts: { limit?: number; topic?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.topic) q.set('topic', opts.topic);
    return request<RawMessage[]>(`/api/raw?${q}`);
  },
};

export type LiveEvent =
  | { type: 'state'; ieeeAddress: string }
  | { type: 'availability'; ieeeAddress: string }
  | { type: 'button'; ieeeAddress: string; action: string; channel: string | null; ts: string }
  | { type: 'devices' }
  | { type: 'status'; status: CollectorStatus };

/** Opens the live WebSocket (reconnecting) and calls `onEvent` for every message. */
export function useLive(onEvent: (event: LiveEvent) => void): boolean {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setOpen(true);
      ws.onmessage = (m) => {
        try {
          handler.current(JSON.parse(m.data));
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        setOpen(false);
        if (!closed) timer = window.setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, []);
  return open;
}

/** Loads data once and again whenever `deps` change. */
export function useData<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    load()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}
