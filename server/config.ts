// All settings come from environment variables (see .env.example).

export interface Config {
  mqttHost: string;
  mqttPort: number;
  mqttUsername?: string;
  mqttPassword?: string;
  baseTopic: string;
  databaseUrl: string;
  httpPort: number;
  timezone: string;
  /** Mains voltage used to estimate power from current when a unit reports only amps. */
  mainsVoltage: number;
  /** Days to keep raw MQTT messages (0 = keep forever). */
  rawRetentionDays: number;
  /** Days to keep attribute history (0 = keep forever). */
  readingsRetentionDays: number;
  /** Seconds between heartbeats / energy flushes. */
  tickSeconds: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

export function loadConfig(env = process.env): Config {
  const mqttHost = env.STREDA_HOST;
  if (!mqttHost) throw new Error('STREDA_HOST is not set (the IP address of the Streda box)');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  return {
    mqttHost,
    mqttPort: num('STREDA_MQTT_PORT', 1883),
    mqttUsername: env.STREDA_MQTT_USERNAME || undefined,
    mqttPassword: env.STREDA_MQTT_PASSWORD || undefined,
    baseTopic: (env.STREDA_BASE_TOPIC || 'zigbee2mqtt').replace(/\/+$/, ''),
    databaseUrl,
    httpPort: num('HTTP_PORT', 8080),
    timezone: env.TZ || 'Europe/Amsterdam',
    mainsVoltage: num('MAINS_VOLTAGE', 230),
    rawRetentionDays: num('RAW_RETENTION_DAYS', 7),
    readingsRetentionDays: num('READINGS_RETENTION_DAYS', 0),
    tickSeconds: num('TICK_SECONDS', 30),
  };
}
