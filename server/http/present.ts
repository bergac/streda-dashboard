// Shapes database rows into what the dashboard shows.

import type { DeviceRow, FunctionLabelRow, PressRow } from '../db/store.ts';
import { splitFunctions, type FunctionRole } from '../collector/functions.ts';
import { energyChannels, powerFor } from '../collector/energy.ts';

export interface DeviceView {
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
  /** Separate functions of this unit (buttons, buzzer, socket, light); empty when the unit is one single thing. */
  functions: FunctionView[];
}

export interface FunctionView {
  channel: string;
  role: FunctionRole;
  /** "Button 2", "Socket" ... */
  label: string;
  /** Name you gave it, or "<unit> · <label>". */
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

const ROLE_LABEL: Record<FunctionRole, string> = {
  light: 'Light',
  socket: 'Socket',
  dimmer: 'Dimmer',
  button: 'Button',
  buzzer: 'Buzzer',
  doorbell_button: 'Doorbell button',
};

export interface DeviceExtras {
  functionLabels?: FunctionLabelRow[];
  presses?: PressRow[];
}

/** The functions of one unit, in the shape the dashboard shows. */
export function functionsFor(row: DeviceRow, state: Record<string, unknown>, mainsVoltage: number, extras: DeviceExtras = {}): FunctionView[] {
  const presses = (extras.presses ?? []).filter((p) => p.ieee_address === row.ieee_address);
  const specs = splitFunctions({ model: row.model, modelId: row.model_id, state, pressChannels: presses.map((p) => p.channel) });
  const unitName = row.display_name || row.friendly_name;
  return specs.map((f) => {
    const label = ROLE_LABEL[f.role] + (f.of > 1 ? ` ${f.index}` : '');
    const own = (extras.functionLabels ?? []).find((l) => l.ieee_address === row.ieee_address && l.channel === f.channel);
    const sw = switchesOf(state).find((s) => s.channel === f.channel);
    const p = energyChannels(state).includes(f.channel) ? powerFor(state, f.channel, mainsVoltage) : null;
    const press = presses.find((x) => x.channel === f.channel);
    const brightness = state[`brightness_${f.channel}`];
    return {
      channel: f.channel,
      role: f.role,
      label,
      name: own?.display_name || `${unitName} · ${label}`,
      named: !!own?.display_name,
      room: own?.room || row.room,
      notes: own?.notes ?? null,
      hidden: (own?.hidden ?? false) || (row.hidden ?? false),
      on: sw ? sw.on : null,
      brightness: f.role === 'dimmer' && typeof brightness === 'number' ? brightness : null,
      powerW: p?.watts ?? null,
      powerEstimated: p?.estimated ?? false,
      lastPress: press ? { action: press.action, name: press.action_name, ts: String(press.ts) } : null,
    };
  });
}

export function switchesOf(state: Record<string, unknown>): Array<{ channel: string; on: boolean }> {
  const out: Array<{ channel: string; on: boolean }> = [];
  for (const [key, value] of Object.entries(state)) {
    const m = key.match(/^state(?:_(.+))?$/);
    if (m && (value === 'ON' || value === 'OFF')) out.push({ channel: m[1] ?? '', on: value === 'ON' });
  }
  // Dimmers report state "OFF" even while lit, so for them brightness decides: on = brightness > 0.
  for (const [key, value] of Object.entries(state)) {
    const m = key.match(/^brightness(?:_(.+))?$/);
    if (!m || typeof value !== 'number') continue;
    const channel = m[1] ?? '';
    const on = value > 0;
    const existing = out.find((s) => s.channel === channel);
    if (existing) existing.on = on;
    else out.push({ channel, on });
  }
  return out.sort((a, b) => a.channel.localeCompare(b.channel, undefined, { numeric: true }));
}

export function alertsOf(state: Record<string, unknown>, availability: string | null): string[] {
  const alerts: string[] = [];
  if (state.smoke === true) alerts.push('Smoke detected');
  for (const key of ['fault', 'trouble', 'tamper', 'test']) {
    if (state[key] === true) alerts.push(key === 'test' ? 'Test button pressed' : `Fault reported (${key})`);
  }
  const battery = state.battery;
  if (state.battery_low === true || (typeof battery === 'number' && battery < 15)) alerts.push('Battery low');
  if (availability === 'offline') alerts.push('Offline');
  return alerts;
}

export function presentDevice(row: DeviceRow, mainsVoltage: number, extras: DeviceExtras = {}): DeviceView {
  const state = (row.state ?? {}) as Record<string, unknown>;
  let powerW: number | null = null;
  let powerEstimated = false;
  for (const channel of energyChannels(state)) {
    const p = powerFor(state, channel, mainsVoltage);
    if (!p) continue;
    powerW = (powerW ?? 0) + p.watts;
    powerEstimated ||= p.estimated;
  }
  return {
    ieeeAddress: row.ieee_address,
    name: row.display_name || row.friendly_name,
    friendlyName: row.friendly_name,
    displayName: row.display_name,
    room: row.room,
    notes: row.notes,
    hidden: row.hidden ?? false,
    category: row.category,
    model: row.model,
    vendor: row.vendor,
    description: row.description,
    powerSource: row.power_source,
    zigbeeType: row.zigbee_type,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    removed: row.removed_at !== null,
    availability: row.availability,
    state,
    attributeUpdated: (row.attribute_updated ?? {}) as Record<string, string>,
    switches: switchesOf(state),
    powerW,
    powerEstimated,
    battery: typeof state.battery === 'number' ? state.battery : null,
    alerts: alertsOf(state, row.availability),
    functions: functionsFor(row, state, mainsVoltage, extras),
  };
}
