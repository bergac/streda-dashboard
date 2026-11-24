// The collector: listens to the Streda box and stores what it hears.

import type { ListenOnlyMqttClient, MqttMessage } from '../mqtt/client.ts';
import type { Store } from '../db/store.ts';
import type { CollectorStatus, LiveBus } from '../live.ts';
import { categorize, parseBridgeDevices } from './devices.ts';
import { diffState, extractButtonPress, parseAvailability } from './state.ts';
import { EnergyTracker } from './energy.ts';

export interface CollectorOptions {
  baseTopic: string;
  host: string;
  mainsVoltage: number;
  tickSeconds: number;
  rawRetentionDays: number;
  readingsRetentionDays: number;
  now?: () => number;
}

interface Cached {
  friendlyName: string;
  active: boolean;
  state: Record<string, unknown>;
  attributeUpdated: Record<string, string>;
}

const MAX_PENDING = 500;
const MAX_RAW_PAYLOAD = 1_000_000;

export class Collector {
  private readonly now: () => number;
  private readonly energy: EnergyTracker;
  private cache = new Map<string, Cached>(); // by IEEE address
  private byName = new Map<string, string>(); // friendly name -> IEEE (active units)
  private haveDeviceList = false;
  private pending: Array<{ msg: MqttMessage; at: number }> = [];
  private queue: Promise<void> = Promise.resolve();
  private sessionId: number | null = null;
  private lastTick = 0;
  private lastCleanup = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private status: CollectorStatus;

  constructor(
    private readonly store: Store,
    private readonly mqtt: ListenOnlyMqttClient,
    private readonly live: LiveBus,
    private readonly opts: CollectorOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.energy = new EnergyTracker(opts.mainsVoltage);
    this.status = { host: opts.host, mqtt: 'connecting', lastError: null, bridgeState: null, lastMessageAt: null, listeningSince: null };
  }

  getStatus(): CollectorStatus {
    return { ...this.status };
  }

  /** Waits until every message received so far has been stored (used by tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  async start(): Promise<void> {
    await this.store.closeStaleSessions();
    for (const row of await this.store.loadStates()) {
      const active = row.removed_at === null;
      this.cache.set(row.ieee_address, {
        friendlyName: row.friendly_name,
        active,
        state: row.state ?? {},
        attributeUpdated: row.attribute_updated ?? {},
      });
      if (active) this.byName.set(row.friendly_name, row.ieee_address);
      this.energy.seed(row.ieee_address, row.state ?? {});
    }

    this.mqtt.on('connected', () => this.enqueue(() => this.onConnected()));
    this.mqtt.on('disconnected', (info: { reason: string }) => this.enqueue(() => this.onDisconnected(info.reason)));
    this.mqtt.on('message', (msg: MqttMessage) => {
      const at = this.now();
      this.enqueue(() => this.onMessage(msg, at));
    });
    this.mqtt.on('error', (err: Error) => console.error('[collector] message error:', err.message));
    this.mqtt.start();

    this.lastTick = this.now();
    this.tickTimer = setInterval(() => this.enqueue(() => this.onTick()), this.opts.tickSeconds * 1000);
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    await this.mqtt.stop();
    await this.enqueue(() => this.endListening(this.now(), 'app stopped'));
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(job).catch((err) => console.error('[collector]', err));
    return this.queue;
  }

  private setStatus(patch: Partial<CollectorStatus>) {
    this.status = { ...this.status, ...patch };
    this.live.publish({ type: 'status', status: this.getStatus() });
  }

  // ---- listening sessions ---------------------------------------------------------

  private async beginListening(at: number) {
    if (this.sessionId !== null) return;
    this.sessionId = await this.store.startSession(new Date(at));
    this.energy.resume(at);
    this.setStatus({ listeningSince: new Date(at).toISOString() });
  }

  private async endListening(at: number, reason: string) {
    if (this.sessionId === null) return;
    this.energy.pause(at);
    await this.store.addEnergy(this.energy.drain());
    await this.store.endSession(this.sessionId, new Date(at), reason);
    this.sessionId = null;
    this.setStatus({ listeningSince: null });
  }

  private async onConnected() {
    console.log(`[collector] listening to ${this.opts.host}`);
    this.setStatus({ mqtt: 'connected', lastError: null });
    await this.beginListening(this.now());
  }

  private async onDisconnected(reason: string) {
    console.log(`[collector] disconnected: ${reason}`);
    this.setStatus({ mqtt: this.mqtt.connected ? 'connected' : 'disconnected', lastError: reason });
    await this.endListening(this.now(), `connection lost: ${reason}`);
  }

  private async onTick() {
    const now = this.now();
    const expected = this.opts.tickSeconds * 1000;
    if (now - this.lastTick > expected * 3) {
      // The process was frozen (laptop asleep, Docker paused). Don't count that time.
      await this.endListening(this.lastTick, 'computer asleep or app paused');
      if (this.mqtt.connected) await this.beginListening(now);
    } else if (this.sessionId !== null) {
      this.energy.accrueAll(now);
      await this.store.addEnergy(this.energy.drain());
      await this.store.heartbeat(this.sessionId, new Date(now));
    }
    this.lastTick = now;
    if (now - this.lastCleanup > 3_600_000) {
      this.lastCleanup = now;
      await this.store.cleanup(this.opts.rawRetentionDays, this.opts.readingsRetentionDays);
    }
  }

  // ---- messages -----------------------------------------------------------------------

  private async onMessage(msg: MqttMessage, at: number) {
    const date = new Date(at);
    const text = msg.payload.toString('utf8');
    this.setStatusQuiet({ lastMessageAt: date.toISOString() });
    await this.store.addRawMessage(msg.topic, text.length > MAX_RAW_PAYLOAD ? text.slice(0, MAX_RAW_PAYLOAD) : text, msg.retain, date);
    await this.handle(msg, text, date);
  }

  private async handle(msg: MqttMessage, text: string, date: Date) {
    const prefix = `${this.opts.baseTopic}/`;
    if (!msg.topic.startsWith(prefix)) return;
    const rest = msg.topic.slice(prefix.length);

    if (rest === 'bridge/devices') return this.onDeviceList(text, date);
    if (rest === 'bridge/state') {
      this.setStatus({ bridgeState: parseAvailability(text) });
      return;
    }
    if (rest.startsWith('bridge/')) return;

    const resolved = this.resolve(rest);
    if (!resolved) {
      if (!this.haveDeviceList && this.pending.length < MAX_PENDING) this.pending.push({ msg, at: date.getTime() });
      return;
    }
    const { ieee, suffix } = resolved;
    if (suffix === '') return this.onState(ieee, text, msg.retain, date);
    if (suffix === '/availability') {
      const availability = parseAvailability(text);
      if (!availability) return;
      await this.store.saveAvailability(ieee, availability, date);
      this.live.publish({ type: 'availability', ieeeAddress: ieee, availability, at: date.toISOString() });
    }
    // Other sub-topics (/set, /get, …) are commands from other apps: stored raw only.
  }

  /** lastMessageAt changes on every message; don't broadcast it each time. */
  private setStatusQuiet(patch: Partial<CollectorStatus>) {
    this.status = { ...this.status, ...patch };
  }

  /** Friendly names may contain slashes, so match the longest known name. */
  private resolve(rest: string): { ieee: string; suffix: string } | null {
    let best: { ieee: string; suffix: string } | null = null;
    let bestLength = -1;
    for (const [name, ieee] of this.byName) {
      if ((rest === name || rest.startsWith(`${name}/`)) && name.length > bestLength) {
        best = { ieee, suffix: rest.slice(name.length) };
        bestLength = name.length;
      }
    }
    if (best) return best;
    // Units without a friendly name use their IEEE address as the topic.
    const m = rest.match(/^(0x[0-9a-f]{16})(\/.*)?$/i);
    if (m && this.cache.has(m[1])) return { ieee: m[1], suffix: m[2] ?? '' };
    return null;
  }

  private async onDeviceList(text: string, date: Date) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const devices = parseBridgeDevices(parsed);
    if (!devices.length) return;
    await this.store.upsertDevices(devices, date);
    const present = new Set(devices.map((d) => d.ieeeAddress));
    this.byName.clear();
    for (const [ieee, c] of this.cache) c.active = present.has(ieee);
    for (const d of devices) {
      const c = this.cache.get(d.ieeeAddress);
      if (c) c.friendlyName = d.friendlyName;
      else this.cache.set(d.ieeeAddress, { friendlyName: d.friendlyName, active: true, state: {}, attributeUpdated: {} });
      this.byName.set(d.friendlyName, d.ieeeAddress);
    }
    this.haveDeviceList = true;
    this.live.publish({ type: 'devices' });
    const waiting = this.pending;
    this.pending = [];
    for (const p of waiting) await this.handle(p.msg, p.msg.payload.toString('utf8'), new Date(p.at));
  }

  private async onState(ieee: string, text: string, retained: boolean, date: Date) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const incoming = payload as Record<string, unknown>;
    const cached = this.cache.get(ieee)!;
    const { merged, changed, reported } = diffState(cached.state, incoming);
    const iso = date.toISOString();
    const attributeUpdated = { ...cached.attributeUpdated };
    for (const key of reported) {
      // A retained message is old news replayed by the broker; keep earlier timestamps.
      if (!retained || !attributeUpdated[key]) attributeUpdated[key] = iso;
    }
    cached.state = merged;
    cached.attributeUpdated = attributeUpdated;

    await this.store.saveState(ieee, merged, attributeUpdated, changed, date);

    const press = retained ? null : extractButtonPress(incoming);
    if (press) {
      await this.store.addButtonEvent(ieee, press.action, press.channel, incoming, date);
      this.live.publish({ type: 'button', ieeeAddress: ieee, action: press.action, channel: press.channel, ts: iso });
    }

    const guessed = categorize({ stateKeys: Object.keys(merged) });
    if (guessed !== 'other') await this.store.setCategory(ieee, guessed);

    this.energy.update(ieee, merged, date.getTime(), this.sessionId !== null);
    this.live.publish({ type: 'state', ieeeAddress: ieee, state: merged, attributeUpdated, updatedAt: iso });
  }
}
