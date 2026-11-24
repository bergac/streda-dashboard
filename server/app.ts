// Wires the pieces together. main.ts uses real Postgres and the real box;
// tests pass in a test database and a fake box.

import type { Database } from './db/db.ts';
import { waitForDatabase } from './db/db.ts';
import { migrate } from './db/migrations.ts';
import { Store } from './db/store.ts';
import { LiveBus } from './live.ts';
import { Collector } from './collector/collector.ts';
import { createListenOnlyClient } from './mqtt/client.ts';
import { createServer } from './http/server.ts';
import type { Config } from './config.ts';

export async function startApp(config: Config, db: Database, staticDir: string) {
  await waitForDatabase(db);
  await migrate(db);
  const store = new Store(db);
  const live = new LiveBus();
  const mqtt = createListenOnlyClient({
    host: config.mqttHost,
    port: config.mqttPort,
    username: config.mqttUsername,
    password: config.mqttPassword,
    subscriptions: [`${config.baseTopic}/#`],
  });
  const collector = new Collector(store, mqtt, live, {
    baseTopic: config.baseTopic,
    host: `${config.mqttHost}:${config.mqttPort}`,
    mainsVoltage: config.mainsVoltage,
    tickSeconds: config.tickSeconds,
    rawRetentionDays: config.rawRetentionDays,
    readingsRetentionDays: config.readingsRetentionDays,
  });
  const server = createServer({
    store,
    live,
    getStatus: () => collector.getStatus(),
    staticDir,
    mainsVoltage: config.mainsVoltage,
    timezone: config.timezone,
  });
  await collector.start();
  const port = await server.listen(config.httpPort);
  console.log(`[http] dashboard on http://localhost:${port}`);

  return {
    port,
    collector,
    store,
    async stop() {
      await server.close();
      await collector.stop();
      await db.close();
    },
  };
}
