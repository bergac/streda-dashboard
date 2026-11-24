// Understanding the device list that Zigbee2MQTT publishes on <base>/bridge/devices.

import { categoryForModel } from './functions.ts';

export type Category =
  | 'relay'
  | 'dimmer'
  | 'wall_switch'
  | 'doorbell'
  | 'smoke_detector'
  | 'coordinator'
  | 'other';

export interface BridgeDevice {
  ieeeAddress: string;
  friendlyName: string;
  zigbeeType: string | null;
  category: Category;
  model: string | null;
  vendor: string | null;
  description: string | null;
  modelId: string | null;
  manufacturer: string | null;
  powerSource: string | null;
  definition: unknown;
}

interface Expose {
  type?: string;
  name?: string;
  property?: string;
  features?: Expose[];
}

/** Every property name a definition exposes, plus the types of exposes it contains. */
export function exposedProperties(definition: any): { properties: Set<string>; types: Set<string> } {
  const properties = new Set<string>();
  const types = new Set<string>();
  const walk = (list: Expose[] | undefined) => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      if (e.type) types.add(e.type);
      if (e.name) properties.add(e.name);
      if (e.property) properties.add(e.property);
      walk(e.features);
    }
  };
  walk(definition?.exposes);
  return { properties, types };
}

const has = (set: Set<string>, base: string) => [...set].some((p) => p === base || p.startsWith(`${base}_`));

/**
 * Guess what kind of unit this is, from its definition and/or the keys it reports.
 * Used for icons and grouping only; it never changes what is stored.
 */
export function categorize(opts: {
  zigbeeType?: string | null;
  definition?: any;
  stateKeys?: Iterable<string>;
  model?: string | null;
  description?: string | null;
}): Category {
  if (opts.zigbeeType === 'Coordinator') return 'coordinator';
  const { properties, types } = exposedProperties(opts.definition);
  for (const k of opts.stateKeys ?? []) properties.add(k);
  const text = `${opts.model ?? ''} ${opts.description ?? ''}`.toLowerCase();

  if (has(properties, 'smoke')) return 'smoke_detector';
  if (/door ?bell|deurbel|\bbell\b|\bring\b/.test(text) || properties.has('ring')) return 'doorbell';
  if (has(properties, 'brightness')) return 'dimmer';
  if (has(properties, 'state') || types.has('switch') || types.has('light')) return 'relay';
  if (has(properties, 'action')) return 'wall_switch';
  return 'other';
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function parseBridgeDevices(payload: unknown): BridgeDevice[] {
  if (!Array.isArray(payload)) return [];
  const out: BridgeDevice[] = [];
  for (const d of payload) {
    if (!d || typeof d !== 'object') continue;
    const ieee = str((d as any).ieee_address);
    const name = str((d as any).friendly_name) ?? ieee;
    if (!ieee || !name) continue;
    const def = (d as any).definition ?? null;
    const model = str(def?.model);
    const description = str(def?.description);
    out.push({
      ieeeAddress: ieee,
      friendlyName: name,
      zigbeeType: str((d as any).type),
      category:
        categoryForModel(model, str((d as any).model_id)) ??
        categorize({ zigbeeType: (d as any).type, definition: def, model, description }),
      model,
      vendor: str(def?.vendor),
      description,
      modelId: str((d as any).model_id),
      manufacturer: str((d as any).manufacturer),
      powerSource: str((d as any).power_source),
      definition: def,
    });
  }
  return out;
}
