// Energy bookkeeping.
//
// Units report power (W), or only current (A), or a cumulative energy counter
// (kWh). For each unit and channel:
//  - with an energy counter, the increase between two reports is used;
//  - otherwise power is integrated over time: a value holds until the next
//    report (units usually report on change). Power estimated from current uses
//    the mains voltage and is marked "estimated".
// Time in which the app was not listening (laptop asleep, app stopped, box
// unreachable) is never counted: the tracker is paused then.

const HOUR_MS = 3_600_000;

export interface EnergyBucket {
  ieeeAddress: string;
  channel: string;
  hour: Date;
  wh: number;
  estimated: boolean;
}

interface Track {
  watts: number | null;
  estimated: boolean;
  since: number | null; // null = paused
  counterKwh: number | null;
}

/** Channels a state object contains: "" for single-channel keys, "l1"/"l2"… for suffixed ones. */
export function energyChannels(state: Record<string, unknown>): string[] {
  const channels = new Set<string>();
  for (const key of Object.keys(state)) {
    const m = key.match(/^(power|current|energy)(?:_(.+))?$/);
    if (m) channels.add(m[2] ?? '');
  }
  return [...channels];
}

export function powerFor(
  state: Record<string, unknown>,
  channel: string,
  mainsVoltage: number,
): { watts: number; estimated: boolean } | null {
  const sfx = channel ? `_${channel}` : '';
  const power = state[`power${sfx}`];
  if (typeof power === 'number' && Number.isFinite(power)) return { watts: Math.max(0, power), estimated: false };
  const onOff = state[`state${sfx}`] ?? (channel ? undefined : state.state);
  const current = state[`current${sfx}`];
  if (typeof current === 'number' && Number.isFinite(current)) {
    if (onOff === 'OFF') return { watts: 0, estimated: true };
    const v = state[`voltage${sfx}`] ?? state.voltage;
    const volts = typeof v === 'number' && v > 50 ? v : mainsVoltage;
    return { watts: Math.max(0, current * volts), estimated: true };
  }
  if (onOff === 'OFF') return { watts: 0, estimated: false };
  return null;
}

export class EnergyTracker {
  private tracks = new Map<string, Track>();
  private pending = new Map<string, EnergyBucket>();

  constructor(private readonly mainsVoltage: number) {}

  private key(ieee: string, channel: string) {
    return `${ieee}\u0000${channel}`;
  }

  private add(ieee: string, channel: string, hourMs: number, wh: number, estimated: boolean) {
    if (wh <= 0) return;
    const k = `${ieee}\u0000${channel}\u0000${hourMs}`;
    const b = this.pending.get(k);
    if (b) {
      b.wh += wh;
      b.estimated = b.estimated || estimated;
    } else {
      this.pending.set(k, { ieeeAddress: ieee, channel, hour: new Date(hourMs), wh, estimated });
    }
  }

  private accrue(ieee: string, channel: string, t: Track, until: number) {
    if (t.since === null || t.watts === null || until <= t.since) {
      if (t.since !== null && until > t.since) t.since = until;
      return;
    }
    let start = t.since;
    while (start < until) {
      const hourStart = Math.floor(start / HOUR_MS) * HOUR_MS;
      const end = Math.min(until, hourStart + HOUR_MS);
      this.add(ieee, channel, hourStart, (t.watts * (end - start)) / HOUR_MS, t.estimated);
      start = end;
    }
    t.since = until;
  }

  /** Restore remembered values at startup. Paused until the first listening session starts. */
  seed(ieee: string, state: Record<string, unknown>) {
    for (const channel of energyChannels(state)) {
      const p = powerFor(state, channel, this.mainsVoltage);
      const counter = state[channel ? `energy_${channel}` : 'energy'];
      this.tracks.set(this.key(ieee, channel), {
        watts: p?.watts ?? null,
        estimated: p?.estimated ?? true,
        since: null,
        counterKwh: typeof counter === 'number' ? counter : null,
      });
    }
  }

  /** Call with the merged state after every state message. `listening` is false while paused. */
  update(ieee: string, state: Record<string, unknown>, at: number, listening = true) {
    for (const channel of energyChannels(state)) {
      const k = this.key(ieee, channel);
      let t = this.tracks.get(k);
      if (!t) {
        t = { watts: null, estimated: true, since: listening ? at : null, counterKwh: null };
        this.tracks.set(k, t);
      }
      const counter = state[channel ? `energy_${channel}` : 'energy'];
      if (typeof counter === 'number' && Number.isFinite(counter)) {
        // Counter mode: the unit measures energy itself, so gaps don't matter.
        if (t.counterKwh !== null) {
          const delta = counter - t.counterKwh;
          if (delta > 0 && delta < 1000) this.add(ieee, channel, Math.floor(at / HOUR_MS) * HOUR_MS, delta * 1000, false);
        }
        t.counterKwh = counter;
        t.watts = null; // don't also integrate power
        t.since = listening ? at : null;
        continue;
      }
      this.accrue(ieee, channel, t, at);
      const p = powerFor(state, channel, this.mainsVoltage);
      t.watts = p?.watts ?? null;
      t.estimated = p?.estimated ?? true;
      if (listening && t.since === null) t.since = at;
    }
  }

  /** Count energy up to `at` for every unit (called on each tick). */
  accrueAll(at: number) {
    for (const [k, t] of this.tracks) {
      const [ieee, channel] = k.split('\u0000');
      this.accrue(ieee, channel, t, at);
    }
  }

  /** Stop counting: we're no longer sure what's happening. Energy up to `at` is kept. */
  pause(at: number) {
    this.accrueAll(at);
    for (const t of this.tracks.values()) t.since = null;
  }

  /** Start counting again from `at`, assuming the last known values still hold. */
  resume(at: number) {
    for (const t of this.tracks.values()) t.since = at;
  }

  /** Current power per unit (for the "total power now" figure). */
  currentWatts(): Map<string, { watts: number; estimated: boolean }> {
    const out = new Map<string, { watts: number; estimated: boolean }>();
    for (const [k, t] of this.tracks) {
      if (t.watts === null) continue;
      const ieee = k.split('\u0000')[0];
      const prev = out.get(ieee);
      out.set(ieee, { watts: (prev?.watts ?? 0) + t.watts, estimated: (prev?.estimated ?? false) || t.estimated });
    }
    return out;
  }

  drain(): EnergyBucket[] {
    const out = [...this.pending.values()];
    this.pending.clear();
    return out;
  }
}
