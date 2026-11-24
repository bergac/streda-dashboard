import type { Queryable } from './db.ts';

// Each migration runs once, in order. Never edit a migration that has shipped;
// add a new one instead.
export const migrations: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE devices (
  ieee_address   text PRIMARY KEY,
  friendly_name  text NOT NULL,
  zigbee_type    text,               -- Coordinator / Router / EndDevice
  category       text NOT NULL DEFAULT 'other',
  model          text,
  vendor         text,
  description    text,
  model_id       text,
  manufacturer   text,
  power_source   text,
  definition     jsonb,
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz,
  removed_at     timestamptz         -- set when the unit disappears from the box's device list
);
CREATE UNIQUE INDEX devices_friendly_name_active ON devices (friendly_name) WHERE removed_at IS NULL;

-- Readable names you give to units. Only ever written by the dashboard.
CREATE TABLE device_labels (
  ieee_address  text PRIMARY KEY REFERENCES devices ON DELETE CASCADE,
  display_name  text,
  room          text,
  notes         text,
  hidden        boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Last known state per unit. This is the "memory" that survives restarts.
CREATE TABLE device_state (
  ieee_address       text PRIMARY KEY REFERENCES devices ON DELETE CASCADE,
  state              jsonb NOT NULL DEFAULT '{}'::jsonb,
  attribute_updated  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- attribute -> ISO time of last report
  availability       text,
  availability_at    timestamptz,
  updated_at         timestamptz
);

-- History of every changed attribute.
CREATE TABLE readings (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL,
  ieee_address  text NOT NULL REFERENCES devices ON DELETE CASCADE,
  attribute     text NOT NULL,
  value_num     double precision,
  value_text    text,
  value_bool    boolean
);
CREATE INDEX readings_device_attr_ts ON readings (ieee_address, attribute, ts DESC);
CREATE INDEX readings_ts ON readings (ts);

CREATE TABLE button_events (
  id            bigserial PRIMARY KEY,
  ts            timestamptz NOT NULL,
  ieee_address  text NOT NULL REFERENCES devices ON DELETE CASCADE,
  action        text NOT NULL,
  channel       text,
  payload       jsonb
);
CREATE INDEX button_events_ts ON button_events (ts DESC);
CREATE INDEX button_events_device_ts ON button_events (ieee_address, ts DESC);

-- Energy per unit, channel and hour, in watt-hours.
CREATE TABLE energy_hourly (
  ieee_address  text NOT NULL REFERENCES devices ON DELETE CASCADE,
  channel       text NOT NULL DEFAULT '',
  hour          timestamptz NOT NULL,
  wh            double precision NOT NULL DEFAULT 0,
  estimated     boolean NOT NULL DEFAULT true,
  PRIMARY KEY (ieee_address, channel, hour)
);
CREATE INDEX energy_hourly_hour ON energy_hourly (hour);

-- Raw messages from the box, kept for a limited time (RAW_RETENTION_DAYS).
CREATE TABLE raw_messages (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL,
  topic     text NOT NULL,
  payload   text NOT NULL,
  retained  boolean NOT NULL DEFAULT false
);
CREATE INDEX raw_messages_ts ON raw_messages (ts DESC);

-- Periods in which the app was connected and listening. Gaps between them
-- (laptop asleep, app stopped, box offline) are not counted as energy use.
CREATE TABLE collector_sessions (
  id              bigserial PRIMARY KEY,
  started_at      timestamptz NOT NULL,
  last_heartbeat  timestamptz NOT NULL,
  ended_at        timestamptz,
  end_reason      text
);
CREATE INDEX collector_sessions_started ON collector_sessions (started_at DESC);
`,
  },
  {
    version: 2,
    name: 'button action names',
    sql: `
-- Names you give to the separate actions (e.g. singleup_l3) of a wireless switch. Only written by the dashboard.
CREATE TABLE button_action_names (
  ieee_address  text NOT NULL REFERENCES devices ON DELETE CASCADE,
  action        text NOT NULL,
  name          text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ieee_address, action)
);
`,
  },
  {
    version: 3,
    name: 'function labels',
    sql: `
-- A unit can hold several functions (two buttons, a buzzer, a socket, a light). Each can get its own
-- name and room; what is empty falls back to the unit's own label. Only written by the dashboard.
CREATE TABLE function_labels (
  ieee_address  text NOT NULL REFERENCES devices ON DELETE CASCADE,
  channel       text NOT NULL,          -- "l4" etc.
  display_name  text,
  room          text,
  notes         text,
  hidden        boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ieee_address, channel)
);
-- An earlier build briefly used a "multi" category; it is gone.
UPDATE devices SET category = 'other' WHERE category = 'multi';
`,
  },
];

export async function migrate(db: Queryable): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    console.log(`[db] applying migration ${m.version}: ${m.name}`);
    // One multi-statement query without parameters runs as a single implicit
    // transaction in Postgres: either the whole migration applies, or none of it.
    await db.query(`${m.sql}\nINSERT INTO schema_migrations (version, name) VALUES (${m.version}, '${m.name.replace(/'/g, "''")}');`);
  }
}
