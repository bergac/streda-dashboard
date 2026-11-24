// All database reads and writes.

import type { Queryable } from './db.ts';
import type { BridgeDevice } from '../collector/devices.ts';
import type { ReadingRow } from '../collector/state.ts';
import type { EnergyBucket } from '../collector/energy.ts';

export interface DeviceRow {
  ieee_address: string;
  friendly_name: string;
  zigbee_type: string | null;
  category: string;
  model: string | null;
  vendor: string | null;
  description: string | null;
  model_id: string | null;
  manufacturer: string | null;
  power_source: string | null;
  first_seen: string;
  last_seen: string | null;
  removed_at: string | null;
  display_name: string | null;
  room: string | null;
  notes: string | null;
  hidden: boolean | null;
  state: Record<string, unknown> | null;
  attribute_updated: Record<string, string> | null;
  availability: string | null;
  availability_at: string | null;
  state_updated_at: string | null;
}

export interface FunctionLabelRow {
  ieee_address: string;
  channel: string;
  display_name: string | null;
  room: string | null;
  notes: string | null;
  hidden: boolean;
}

export interface PressRow {
  ieee_address: string;
  channel: string;
  action: string;
  ts: string;
  action_name: string | null;
}

export class Store {
  constructor(private readonly db: Queryable) {}

  // ---- collector: devices & state -------------------------------------------------

  async upsertDevices(devices: BridgeDevice[], at: Date): Promise<void> {
    const present = devices.map((d) => d.ieeeAddress);
    // Names can move between units (rename); free them first so the unique index holds.
    await this.db.query(
      `UPDATE devices SET friendly_name = friendly_name || ' (old ' || ieee_address || ')'
        WHERE removed_at IS NULL AND NOT (ieee_address = ANY($1::text[]))
          AND friendly_name = ANY($2::text[])`,
      [present, devices.map((d) => d.friendlyName)],
    );
    for (const d of devices) {
      await this.db.query(
        `UPDATE devices SET friendly_name = ieee_address
          WHERE friendly_name = $1 AND ieee_address <> $2 AND removed_at IS NULL`,
        [d.friendlyName, d.ieeeAddress],
      );
      await this.db.query(
        `INSERT INTO devices (ieee_address, friendly_name, zigbee_type, category, model, vendor, description,
                              model_id, manufacturer, power_source, definition, first_seen, removed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,NULL)
         ON CONFLICT (ieee_address) DO UPDATE SET
           friendly_name = EXCLUDED.friendly_name, zigbee_type = EXCLUDED.zigbee_type,
           category = EXCLUDED.category, model = EXCLUDED.model, vendor = EXCLUDED.vendor,
           description = EXCLUDED.description, model_id = EXCLUDED.model_id,
           manufacturer = EXCLUDED.manufacturer, power_source = EXCLUDED.power_source,
           definition = EXCLUDED.definition, removed_at = NULL`,
        [
          d.ieeeAddress, d.friendlyName, d.zigbeeType, d.category, d.model, d.vendor, d.description,
          d.modelId, d.manufacturer, d.powerSource, JSON.stringify(d.definition ?? null), at.toISOString(),
        ],
      );
    }
    await this.db.query(
      `UPDATE devices SET removed_at = $2 WHERE removed_at IS NULL AND NOT (ieee_address = ANY($1::text[]))`,
      [present, at.toISOString()],
    );
  }

  /** Creates a placeholder for a unit we hear from before it is in the device list. */
  async ensureDevice(ieee: string, friendlyName: string, category: string, at: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO devices (ieee_address, friendly_name, category, first_seen) VALUES ($1,$2,$3,$4)
       ON CONFLICT (ieee_address) DO NOTHING`,
      [ieee, friendlyName, category, at.toISOString()],
    );
  }

  async setCategory(ieee: string, category: string): Promise<void> {
    await this.db.query(`UPDATE devices SET category = $2 WHERE ieee_address = $1 AND category = 'other'`, [ieee, category]);
  }

  async loadStates(): Promise<Array<{ ieee_address: string; friendly_name: string; removed_at: string | null; state: Record<string, unknown>; attribute_updated: Record<string, string> }>> {
    const { rows } = await this.db.query(
      `SELECT d.ieee_address, d.friendly_name, d.removed_at,
              COALESCE(s.state, '{}'::jsonb) AS state, COALESCE(s.attribute_updated, '{}'::jsonb) AS attribute_updated
         FROM devices d LEFT JOIN device_state s USING (ieee_address)`,
    );
    return rows;
  }

  async saveState(
    ieee: string,
    state: Record<string, unknown>,
    attributeUpdated: Record<string, string>,
    readings: ReadingRow[],
    at: Date,
  ): Promise<void> {
    const ts = at.toISOString();
    await this.db.query(
      `INSERT INTO device_state (ieee_address, state, attribute_updated, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)
       ON CONFLICT (ieee_address) DO UPDATE SET state = EXCLUDED.state,
         attribute_updated = EXCLUDED.attribute_updated, updated_at = EXCLUDED.updated_at`,
      [ieee, JSON.stringify(state), JSON.stringify(attributeUpdated), ts],
    );
    await this.db.query(`UPDATE devices SET last_seen = $2 WHERE ieee_address = $1`, [ieee, ts]);
    if (readings.length) {
      await this.db.query(
        `INSERT INTO readings (ts, ieee_address, attribute, value_num, value_text, value_bool)
         SELECT $1::timestamptz, $2::text, r.attribute, r.value_num, r.value_text, r.value_bool
           FROM jsonb_to_recordset($3::jsonb) AS r(attribute text, value_num double precision, value_text text, value_bool boolean)`,
        [ts, ieee, JSON.stringify(readings.map((r) => ({ attribute: r.attribute, value_num: r.valueNum, value_text: r.valueText, value_bool: r.valueBool })))],
      );
    }
  }

  async saveAvailability(ieee: string, availability: string, at: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO device_state (ieee_address, availability, availability_at) VALUES ($1,$2,$3)
       ON CONFLICT (ieee_address) DO UPDATE SET availability = EXCLUDED.availability, availability_at = EXCLUDED.availability_at`,
      [ieee, availability, at.toISOString()],
    );
  }

  async addButtonEvent(ieee: string, action: string, channel: string | null, payload: unknown, at: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO button_events (ts, ieee_address, action, channel, payload) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [at.toISOString(), ieee, action, channel, JSON.stringify(payload)],
    );
  }

  async addRawMessage(topic: string, payload: string, retained: boolean, at: Date): Promise<void> {
    await this.db.query(`INSERT INTO raw_messages (ts, topic, payload, retained) VALUES ($1,$2,$3,$4)`, [
      at.toISOString(), topic, payload, retained,
    ]);
  }

  async addEnergy(buckets: EnergyBucket[]): Promise<void> {
    if (!buckets.length) return;
    await this.db.query(
      `INSERT INTO energy_hourly (ieee_address, channel, hour, wh, estimated)
       SELECT b.ieee_address, b.channel, b.hour, b.wh, b.estimated
         FROM jsonb_to_recordset($1::jsonb) AS b(ieee_address text, channel text, hour timestamptz, wh double precision, estimated boolean)
         WHERE EXISTS (SELECT 1 FROM devices d WHERE d.ieee_address = b.ieee_address)
       ON CONFLICT (ieee_address, channel, hour) DO UPDATE SET
         wh = energy_hourly.wh + EXCLUDED.wh,
         estimated = energy_hourly.estimated OR EXCLUDED.estimated`,
      [JSON.stringify(buckets.map((b) => ({ ieee_address: b.ieeeAddress, channel: b.channel, hour: b.hour.toISOString(), wh: b.wh, estimated: b.estimated })))],
    );
  }

  // ---- collector: listening sessions ---------------------------------------------

  /** Closes sessions left open by a crash or a hard stop, at their last heartbeat. */
  async closeStaleSessions(): Promise<void> {
    await this.db.query(
      `UPDATE collector_sessions SET ended_at = last_heartbeat, end_reason = 'app stopped unexpectedly'
        WHERE ended_at IS NULL`,
    );
  }

  async startSession(at: Date): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO collector_sessions (started_at, last_heartbeat) VALUES ($1, $1) RETURNING id`,
      [at.toISOString()],
    );
    return Number(rows[0].id);
  }

  async heartbeat(id: number, at: Date): Promise<void> {
    await this.db.query(`UPDATE collector_sessions SET last_heartbeat = $2 WHERE id = $1`, [id, at.toISOString()]);
  }

  async endSession(id: number, at: Date, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE collector_sessions SET ended_at = $2, last_heartbeat = $2, end_reason = $3 WHERE id = $1 AND ended_at IS NULL`,
      [id, at.toISOString(), reason],
    );
  }

  async cleanup(rawDays: number, readingsDays: number): Promise<void> {
    if (rawDays > 0) await this.db.query(`DELETE FROM raw_messages WHERE ts < now() - make_interval(days => $1::int)`, [rawDays]);
    if (readingsDays > 0) await this.db.query(`DELETE FROM readings WHERE ts < now() - make_interval(days => $1::int)`, [readingsDays]);
  }

  // ---- dashboard reads -----------------------------------------------------------

  async listDevices(): Promise<DeviceRow[]> {
    const { rows } = await this.db.query<DeviceRow>(
      `SELECT d.ieee_address, d.friendly_name, d.zigbee_type, d.category, d.model, d.vendor, d.description,
              d.model_id, d.manufacturer, d.power_source, d.first_seen, d.last_seen, d.removed_at,
              l.display_name, l.room, l.notes, l.hidden,
              s.state, s.attribute_updated, s.availability, s.availability_at, s.updated_at AS state_updated_at
         FROM devices d
         LEFT JOIN device_labels l USING (ieee_address)
         LEFT JOIN device_state s USING (ieee_address)
        ORDER BY lower(COALESCE(l.room, '~')), lower(COALESCE(l.display_name, d.friendly_name))`,
    );
    return rows;
  }

  async getDevice(ieee: string): Promise<(DeviceRow & { definition: unknown }) | null> {
    const { rows } = await this.db.query(
      `SELECT d.*, l.display_name, l.room, l.notes, l.hidden,
              s.state, s.attribute_updated, s.availability, s.availability_at, s.updated_at AS state_updated_at
         FROM devices d
         LEFT JOIN device_labels l USING (ieee_address)
         LEFT JOIN device_state s USING (ieee_address)
        WHERE d.ieee_address = $1`,
      [ieee],
    );
    return rows[0] ?? null;
  }

  async saveLabel(ieee: string, label: { displayName: string | null; room: string | null; notes: string | null; hidden: boolean }): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO device_labels (ieee_address, display_name, room, notes, hidden, updated_at)
       SELECT ieee_address, $2::text, $3::text, $4::text, $5::boolean, now() FROM devices WHERE ieee_address = $1
       ON CONFLICT (ieee_address) DO UPDATE SET display_name = EXCLUDED.display_name, room = EXCLUDED.room,
         notes = EXCLUDED.notes, hidden = EXCLUDED.hidden, updated_at = now()
       RETURNING ieee_address`,
      [ieee, label.displayName, label.room, label.notes, label.hidden],
    );
    return rows.length > 0;
  }

  async functionLabels(ieee?: string): Promise<FunctionLabelRow[]> {
    const { rows } = await this.db.query<FunctionLabelRow>(
      `SELECT ieee_address, channel, display_name, room, notes, hidden FROM function_labels
        WHERE ($1::text IS NULL OR ieee_address = $1)`,
      [ieee ?? null],
    );
    return rows;
  }

  async saveFunctionLabel(
    ieee: string,
    channel: string,
    label: { displayName: string | null; room: string | null; notes: string | null; hidden: boolean },
  ): Promise<boolean> {
    const { rows } = await this.db.query(
      `INSERT INTO function_labels (ieee_address, channel, display_name, room, notes, hidden, updated_at)
       SELECT ieee_address, $2::text, $3::text, $4::text, $5::text, $6::boolean, now() FROM devices WHERE ieee_address = $1
       ON CONFLICT (ieee_address, channel) DO UPDATE SET display_name = EXCLUDED.display_name, room = EXCLUDED.room,
         notes = EXCLUDED.notes, hidden = EXCLUDED.hidden, updated_at = now()
       RETURNING ieee_address`,
      [ieee, channel, label.displayName, label.room, label.notes, label.hidden],
    );
    return rows.length > 0;
  }

  /** The latest press per unit and channel, with the name you gave that action (if any). */
  async lastPresses(ieee?: string): Promise<PressRow[]> {
    const { rows } = await this.db.query<PressRow>(
      `SELECT DISTINCT ON (b.ieee_address, b.channel) b.ieee_address, b.channel, b.action, b.ts, n.name AS action_name
         FROM button_events b
         LEFT JOIN button_action_names n ON n.ieee_address = b.ieee_address AND n.action = b.action
        WHERE b.channel IS NOT NULL AND ($1::text IS NULL OR b.ieee_address = $1)
        ORDER BY b.ieee_address, b.channel, b.ts DESC`,
      [ieee ?? null],
    );
    return rows;
  }

  /** Every action this unit has been seen sending, with the name you gave it (if any). */
  async buttonActions(ieee: string): Promise<Array<{ action: string; name: string | null; count: number }>> {
    const { rows } = await this.db.query<{ action: string; name: string | null; count: string }>(
      `SELECT b.action, n.name, count(*) AS count
         FROM button_events b
         LEFT JOIN button_action_names n ON n.ieee_address = b.ieee_address AND n.action = b.action
        WHERE b.ieee_address = $1
        GROUP BY b.action, n.name
       UNION
       SELECT n.action, n.name, 0 FROM button_action_names n WHERE n.ieee_address = $1
        ORDER BY action`,
      [ieee],
    );
    const seen = new Map<string, { action: string; name: string | null; count: number }>();
    for (const r of rows) {
      const prev = seen.get(r.action);
      seen.set(r.action, { action: r.action, name: r.name, count: Math.max(Number(r.count), prev?.count ?? 0) });
    }
    return [...seen.values()];
  }

  /** Replaces the action names of a unit. An empty name removes it. */
  async saveButtonActionNames(ieee: string, names: Record<string, string | null>): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT 1 FROM devices WHERE ieee_address = $1`, [ieee]);
    if (rows.length === 0) return false;
    for (const [action, name] of Object.entries(names)) {
      if (name) {
        await this.db.query(
          `INSERT INTO button_action_names (ieee_address, action, name) VALUES ($1,$2,$3)
           ON CONFLICT (ieee_address, action) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
          [ieee, action, name],
        );
      } else {
        await this.db.query(`DELETE FROM button_action_names WHERE ieee_address = $1 AND action = $2`, [ieee, action]);
      }
    }
    return true;
  }

  async rooms(): Promise<string[]> {
    const { rows } = await this.db.query<{ room: string }>(
      `SELECT DISTINCT room FROM device_labels WHERE room IS NOT NULL AND room <> '' ORDER BY room`,
    );
    return rows.map((r) => r.room);
  }

  async attributes(ieee: string): Promise<Array<{ attribute: string; kind: string; count: number }>> {
    const { rows } = await this.db.query(
      `SELECT attribute,
              CASE WHEN bool_or(value_num IS NOT NULL) THEN 'number'
                   WHEN bool_or(value_bool IS NOT NULL) THEN 'boolean' ELSE 'text' END AS kind,
              count(*) AS count
         FROM readings WHERE ieee_address = $1 GROUP BY attribute ORDER BY attribute`,
      [ieee],
    );
    return rows;
  }

  /** History of one attribute, plus the value just before the range so a chart can start correctly. */
  async history(ieee: string, attribute: string, from: Date, to: Date, limit = 5000) {
    const { rows } = await this.db.query(
      `(SELECT ts, value_num, value_text, value_bool FROM readings
          WHERE ieee_address = $1 AND attribute = $2 AND ts < $3 ORDER BY ts DESC LIMIT 1)
       UNION ALL
       (SELECT ts, value_num, value_text, value_bool FROM readings
          WHERE ieee_address = $1 AND attribute = $2 AND ts >= $3 AND ts <= $4 ORDER BY ts LIMIT $5)
       ORDER BY ts`,
      [ieee, attribute, from.toISOString(), to.toISOString(), limit],
    );
    return rows.map((r: any) => ({ ts: r.ts, value: r.value_num ?? r.value_bool ?? r.value_text }));
  }

  async energy(opts: { from: Date; to: Date; interval: 'hour' | 'day' | 'month'; timezone: string }) {
    const { rows } = await this.db.query(
      `SELECT to_char(date_trunc($3::text, e.hour AT TIME ZONE $4::text), 'YYYY-MM-DD"T"HH24:MI:SS') AS period,
              e.ieee_address, COALESCE(l.display_name, d.friendly_name) AS name, l.room,
              sum(e.wh) AS wh, bool_or(e.estimated) AS estimated
         FROM energy_hourly e
         JOIN devices d USING (ieee_address)
         LEFT JOIN device_labels l USING (ieee_address)
        WHERE e.hour >= $1 AND e.hour < $2
        GROUP BY 1, 2, 3, 4
        ORDER BY 1, 3`,
      [opts.from.toISOString(), opts.to.toISOString(), opts.interval, opts.timezone],
    );
    // `period` is local wall-clock time (as text), e.g. "2026-11-24T00:00:00".
    return rows.map((r: any) => ({
      period: String(r.period),
      ieeeAddress: r.ieee_address,
      name: r.name,
      room: r.room,
      wh: Number(r.wh),
      estimated: r.estimated,
    }));
  }

  async buttonEvents(opts: { limit: number; before?: Date; ieee?: string }) {
    const { rows } = await this.db.query(
      `SELECT b.id, b.ts, b.ieee_address, b.action, b.channel, n.name AS action_name, COALESCE(l.display_name, d.friendly_name) AS name, l.room
         FROM button_events b JOIN devices d USING (ieee_address) LEFT JOIN device_labels l USING (ieee_address)
         LEFT JOIN button_action_names n ON n.ieee_address = b.ieee_address AND n.action = b.action
        WHERE ($2::timestamptz IS NULL OR b.ts < $2) AND ($3::text IS NULL OR b.ieee_address = $3)
        ORDER BY b.ts DESC LIMIT $1`,
      [opts.limit, opts.before?.toISOString() ?? null, opts.ieee ?? null],
    );
    return rows;
  }

  async sessions(limit = 50) {
    const { rows } = await this.db.query(
      `SELECT id, started_at, last_heartbeat, ended_at, end_reason FROM collector_sessions ORDER BY started_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async rawMessages(opts: { limit: number; topic?: string }) {
    const { rows } = await this.db.query(
      `SELECT id, ts, topic, payload, retained FROM raw_messages
        WHERE ($2::text IS NULL OR topic ILIKE '%' || $2 || '%')
        ORDER BY id DESC LIMIT $1`,
      [opts.limit, opts.topic ?? null],
    );
    return rows;
  }

  async counts() {
    const { rows } = await this.db.query(
      `SELECT (SELECT count(*) FROM devices WHERE removed_at IS NULL) AS devices,
              (SELECT count(*) FROM readings) AS readings,
              (SELECT count(*) FROM button_events) AS button_events,
              (SELECT count(*) FROM raw_messages) AS raw_messages,
              (SELECT max(ts) FROM raw_messages) AS last_message_at`,
    );
    return rows[0];
  }
}
