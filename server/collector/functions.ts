// A physical unit can contain several separate functions: two wall buttons, a buzzer, a socket, a light.
// This module works out which functions a unit has, so the dashboard can show each one on its own.
//
// Zigbee endpoint N shows up on the box as channel "lN" (state_l7, current_l3, singledown_l4 ...).
// Which endpoint does what, per model, comes from the zigbee-herdsman-converters definitions for Streda
// (src/devices/streda.ts). The box's own device list only says "Custom device" and advertises light
// endpoints (brightness_l9 ...) that don't exist, so it can't be trusted for this.

import type { Category } from './devices.ts';
import { extractButtonPress } from './state.ts';

export type FunctionRole = 'light' | 'socket' | 'dimmer' | 'button' | 'buzzer' | 'doorbell_button';
type EndpointRole = FunctionRole | 'led';

export interface FunctionSpec {
  /** "l3", "l4" ... */
  channel: string;
  role: FunctionRole;
  /** 1-based position among the functions of the same role ("Button 2"). */
  index: number;
  /** How many functions of this role the unit has. */
  of: number;
}

const SN3: Record<number, EndpointRole> = { 2: 'led', 3: 'socket', 4: 'button', 5: 'button', 6: 'buzzer', 7: 'light' };

/** Endpoint number -> role, per model (and its aliases). */
const MODEL_ROLES: Record<string, Record<number, EndpointRole>> = {
  'BN0-S-03/PW': { 3: 'button' },
  'BN0-T-03/PW': { 3: 'button', 4: 'button' },
  'BN1-1-03/PW': { 2: 'led' },
  'BN3-110-03/PW': { 2: 'led' },
  'DF3-11R-03/PW': { 2: 'led', 4: 'led' },
  'BN1-C-03/PW': { 2: 'led', 3: 'socket', 4: 'led' },
  'HN1-CW-4-03/PW': { 2: 'led', 3: 'socket', 4: 'led' },
  'SN2-E-03/PW': { 2: 'led', 3: 'dimmer', 4: 'led' },
  'SN3-1TB5-03/PW': SN3,
  'HNB-W-1TB5-03/PW': SN3,
  'SN3-1TB5K-03/PW': { ...SN3, 8: 'doorbell_button' },
  'HNB-W-1TB5K-03/PW': { ...SN3, 8: 'doorbell_button' },
};

function rolesFor(model: string | null | undefined, modelId: string | null | undefined) {
  return (model && MODEL_ROLES[model]) || (modelId && MODEL_ROLES[modelId]) || null;
}

function withCounts(list: Array<{ channel: string; role: FunctionRole }>): FunctionSpec[] {
  const total = new Map<FunctionRole, number>();
  for (const f of list) total.set(f.role, (total.get(f.role) ?? 0) + 1);
  const seen = new Map<FunctionRole, number>();
  return list.map((f) => {
    const index = (seen.get(f.role) ?? 0) + 1;
    seen.set(f.role, index);
    return { ...f, index, of: total.get(f.role)! };
  });
}

const channelNumber = (c: string) => Number(c.replace(/\D/g, ''));

/**
 * Unit category for a model we know the layout of, or null for any other model.
 * Indicator LEDs are not functions, so they never make a unit a "dimmer".
 */
export function categoryForModel(model: string | null | undefined, modelId: string | null | undefined): Category | null {
  const roles = rolesFor(model, modelId);
  if (!roles) return null;
  const set = new Set(Object.values(roles));
  if (set.has('dimmer')) return 'dimmer';
  if (set.has('light') || set.has('socket')) return 'relay';
  if (set.has('button')) return 'wall_switch';
  if (set.has('doorbell_button')) return 'doorbell';
  return 'relay'; // outlets that only list their indicator LEDs
}

/**
 * The separate functions of a unit, or an empty list when the unit is a single thing and should
 * be shown as one block.
 *
 *  - Known models: from the endpoint table above, whatever the unit has reported so far.
 *  - Other models: from what the unit actually reported (state_lN, brightness_lN, button channels).
 *    A unit is only split when it has buttons next to something else; several load channels
 *    without buttons stay together.
 */
export function splitFunctions(opts: {
  model?: string | null;
  modelId?: string | null;
  state: Record<string, unknown>;
  /** Channels that button presses were recorded on. */
  pressChannels?: string[];
}): FunctionSpec[] {
  const roles = rolesFor(opts.model, opts.modelId);
  if (roles) {
    const list = Object.entries(roles)
      .filter(([, role]) => role !== 'led')
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([endpoint, role]) => ({ channel: `l${endpoint}`, role: role as FunctionRole }));
    return list.length > 1 ? withCounts(list) : [];
  }

  const dimmers = new Set<string>();
  const lights = new Set<string>();
  const buttons = new Set<string>(opts.pressChannels ?? []);
  for (const key of Object.keys(opts.state)) {
    const m = key.match(/^(state|brightness)_(l\d+)$/);
    if (m) (m[1] === 'brightness' ? dimmers : lights).add(m[2]);
  }
  const action = opts.state.action;
  if (typeof action === 'string') {
    const press = extractButtonPress({ action });
    if (press?.channel && /^l\d+$/.test(press.channel)) buttons.add(press.channel);
  }
  for (const c of [...buttons]) if (!/^l\d+$/.test(c)) buttons.delete(c);

  if (buttons.size === 0) return [];
  const list: Array<{ channel: string; role: FunctionRole }> = [];
  for (const c of [...new Set([...dimmers, ...lights])]) {
    if (!buttons.has(c)) list.push({ channel: c, role: dimmers.has(c) ? 'dimmer' : 'light' });
  }
  for (const c of buttons) list.push({ channel: c, role: 'button' });
  if (list.length < 2) return [];
  return withCounts(list.sort((a, b) => channelNumber(a.channel) - channelNumber(b.channel)));
}
