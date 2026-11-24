// Turning state messages (<base>/<unit>) into stored values.

export type Scalar = string | number | boolean | null;

/** Attributes kept in the current state but not written to the history table. */
export const NOT_IN_HISTORY = new Set(['linkquality', 'last_seen', 'elapsed', 'update', 'update_available', 'action']);

export interface ReadingRow {
  attribute: string;
  valueNum: number | null;
  valueText: string | null;
  valueBool: boolean | null;
}

export function isScalar(v: unknown): v is Scalar {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

export function toReading(attribute: string, value: Scalar): ReadingRow {
  return {
    attribute,
    valueNum: typeof value === 'number' && Number.isFinite(value) ? value : null,
    valueText: typeof value === 'string' ? value : null,
    valueBool: typeof value === 'boolean' ? value : null,
  };
}

/**
 * Compares an incoming state message with the previous state.
 * Returns the merged state and the history rows for attributes that changed.
 */
export function diffState(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
): { merged: Record<string, unknown>; changed: ReadingRow[]; reported: string[] } {
  const merged: Record<string, unknown> = { ...previous };
  const changed: ReadingRow[] = [];
  const reported: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'action' && (value === '' || value === null)) continue; // Z2M clears "action" after a press
    reported.push(key);
    const before = previous[key];
    merged[key] = value;
    if (NOT_IN_HISTORY.has(key) || !isScalar(value)) continue;
    if (before !== value) changed.push(toReading(key, value));
  }
  return { merged, changed, reported };
}

/** Finds a button press in a state message, if there is one. */
export function extractButtonPress(payload: Record<string, unknown>): { action: string; channel: string | null } | null {
  const action = payload.action;
  if (typeof action !== 'string' || action === '') return null;
  const explicit = payload.channel ?? payload.action_endpoint ?? payload.endpoint ?? payload.button;
  if (explicit !== undefined && explicit !== null && explicit !== '') return { action, channel: String(explicit) };
  // Common Zigbee2MQTT patterns: "1_single", "single_l1", "left_press", "button_2_hold"
  let m = action.match(/^button_(\d+)_(.+)$/) ?? action.match(/^(\d+|l\d+|left|right|top|bottom|up|down)_(.+)$/i);
  if (m) return { action, channel: m[1] };
  m = action.match(/^(.+?)_(l\d+|\d+|left|right)$/i);
  if (m) return { action, channel: m[2] };
  return { action, channel: null };
}

/** The availability topic carries either {"state":"online"} or the bare word. */
export function parseAvailability(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === 'online' || trimmed === 'offline') return trimmed;
  try {
    const v = JSON.parse(trimmed);
    if (typeof v?.state === 'string') return v.state;
  } catch {
    /* not JSON */
  }
  return null;
}
