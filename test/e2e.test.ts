// End-to-end: fake Streda box -> collector -> Postgres -> HTTP API / WebSocket.

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { FakeBroker } from '../tools/fake-broker.ts';
import { createTestDatabase, TEST_PG } from './psql-db.ts';
import { migrate } from '../server/db/migrations.ts';
import { Store } from '../server/db/store.ts';
import { LiveBus } from '../server/live.ts';
import { Collector } from '../server/collector/collector.ts';
import { createListenOnlyClient } from '../server/mqtt/client.ts';
import { createServer } from '../server/http/server.ts';
import { BASE, IEEE, bridgeDevices } from './fixtures/z2m.ts';

const H = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

test('collector, database and API work together', async (t) => {
  const db = createTestDatabase(TEST_PG, 'streda_e2e');
  t.after(() => db.drop());
  await migrate(db);
  await migrate(db); // running twice is harmless
  const store = new Store(db);

  const broker = new FakeBroker();
  const port = await broker.listen();
  t.after(() => broker.close());

  // A state message retained before the device list: must be held and applied afterwards.
  broker.publish(`${BASE}/Woonkamer/Plafond`, { state_l1: 'ON', state_l2: 'OFF', current_l1: 0.26 }, true);
  broker.publish(`${BASE}/bridge/state`, { state: 'online' }, true);
  broker.publish(`${BASE}/bridge/devices`, bridgeDevices, true);
  broker.publish(`${BASE}/Hal schakelaar/availability`, { state: 'online' }, true);

  let clock = Date.UTC(2026, 10, 24, 10, 0, 0);
  const now = () => clock;
  const live = new LiveBus();
  const makeCollector = () =>
    new Collector(store, createListenOnlyClient({ host: '127.0.0.1', port, subscriptions: [`${BASE}/#`] }), live, {
      baseTopic: BASE, host: `127.0.0.1:${port}`, mainsVoltage: 230, tickSeconds: 3600,
      rawRetentionDays: 7, readingsRetentionDays: 0, now,
    });
  let collector = makeCollector();
  t.after(() => collector.stop());
  const tick = () => (collector as any).enqueue(() => (collector as any).onTick());

  const server = createServer({
    store, live, getStatus: () => collector.getStatus(), staticDir: '/nonexistent', mainsVoltage: 230, timezone: 'Europe/Amsterdam',
  });
  const httpPort = await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`http://127.0.0.1:${httpPort}${path}`, init);
    return { status: res.status, body: await res.json() as any };
  };

  const wsEvents: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/ws`);
  ws.on('message', (d: any) => wsEvents.push(JSON.parse(String(d))));
  t.after(() => ws.close());

  await collector.start();
  await until(() => collector.getStatus().mqtt === 'connected', 'connection');
  await until(async () => (await store.listDevices()).length === bridgeDevices.length, 'device list');
  await until(async () => (await store.getDevice(IEEE.relay))?.state?.state_l1 === 'ON', 'buffered relay state');

  // Live messages.
  broker.publish(`${BASE}/0x00e6e80000000b02`, { state: 'ON', brightness: 200, power: 40, linkquality: 100 });
  broker.publish(`${BASE}/Keuken stopcontact`, { state: 'ON', power: 100, energy: 1.0 });
  broker.publish(`${BASE}/Hal schakelaar`, { action: '1_single', battery: 80 });
  broker.publish(`${BASE}/Hal schakelaar`, { action: '' });
  broker.publish(`${BASE}/Rookmelder overloop`, { smoke: false, battery: 9 });
  broker.publish(`${BASE}/Woonkamer/Plafond/set`, { state_l1: 'OFF' }); // someone else's command: ignored
  broker.publish(`${BASE}/SomeGroup`, { state: 'ON' }); // a group, not a unit: ignored
  await until(async () => (await store.buttonEvents({ limit: 10 })).length === 1, 'button event');
  await until(async () => (await store.getDevice(IEEE.smoke))?.state?.battery === 9, 'smoke state');
  await collector.idle();

  // One hour passes while listening.
  clock += H;
  broker.publish(`${BASE}/Keuken stopcontact`, { state: 'ON', power: 100, energy: 1.2 });
  await until(async () => (await store.getDevice(IEEE.socket))?.state?.energy === 1.2, 'counter update');
  await tick();

  // ---- API checks ----
  const devices = (await api('/api/devices')).body;
  const relay = devices.find((d: any) => d.ieeeAddress === IEEE.relay);
  assert.equal(relay.name, 'Woonkamer/Plafond');
  assert.deepEqual(relay.switches, [{ channel: 'l1', on: true }, { channel: 'l2', on: false }]);
  assert.equal(Math.round(relay.powerW * 10) / 10, 59.8);
  assert.equal(relay.powerEstimated, true);
  assert.equal(relay.state.state_l1, 'ON', '/set command must not change the stored state');
  const smoke = devices.find((d: any) => d.ieeeAddress === IEEE.smoke);
  assert.deepEqual(smoke.alerts, ['Battery low']);
  assert.equal(devices.find((d: any) => d.ieeeAddress === IEEE.wallSwitch).availability, 'online');
  assert.equal(devices.some((d: any) => d.friendlyName === 'SomeGroup'), false);

  const label = await api(`/api/devices/${encodeURIComponent(IEEE.dimmer)}/label`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: '  Eettafel lamp ', room: 'Woonkamer', notes: 'boven de tafel' }),
  });
  assert.equal(label.status, 200);
  assert.equal(label.body.name, 'Eettafel lamp');
  assert.equal(label.body.room, 'Woonkamer');
  assert.deepEqual((await api('/api/rooms')).body, ['Woonkamer']);
  assert.equal((await api('/api/devices/0xdoesnotexist/label', { method: 'PUT', body: '{}' })).status, 404);
  assert.equal((await api(`/api/devices/${IEEE.dimmer}/label`, { method: 'PUT', body: JSON.stringify({ room: 5 }) })).status, 400);

  const history = (await api(`/api/devices/${IEEE.relay}/history?attribute=state_l1&from=2026-11-24T00:00:00Z&to=2026-11-25T00:00:00Z`)).body;
  assert.deepEqual(history.map((h: any) => h.value), ['ON']);
  const attrs = (await api(`/api/devices/${IEEE.dimmer}/attributes`)).body.map((a: any) => a.attribute);
  assert.deepEqual(attrs, ['brightness', 'power', 'state'], 'linkquality is not kept in history');

  const energy = (await api('/api/energy?from=2026-11-24T00:00:00Z&to=2026-11-25T00:00:00Z&interval=day')).body;
  const wh = Object.fromEntries(energy.map((e: any) => [e.ieeeAddress, Math.round(e.wh * 10) / 10]));
  assert.equal(wh[IEEE.relay], 59.8); // 0.26 A × 230 V for 1 h
  assert.equal(wh[IEEE.dimmer], 40); // 40 W for 1 h
  assert.equal(wh[IEEE.socket], 200); // counter went 1.0 -> 1.2 kWh
  assert.equal(energy.find((e: any) => e.ieeeAddress === IEEE.relay).estimated, true);
  assert.equal(energy[0].period, '2026-11-24T00:00:00');
  assert.equal(energy.find((e: any) => e.ieeeAddress === IEEE.dimmer).name, 'Eettafel lamp');

  const buttons = (await api('/api/buttons')).body;
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].action, '1_single');
  assert.equal(buttons[0].channel, '1');

  const status = (await api('/api/status')).body;
  assert.equal(status.collector.mqtt, 'connected');
  assert.equal(status.collector.bridgeState, 'online');
  assert.ok(status.counts.raw_messages >= 10);
  const raw = (await api('/api/raw?topic=set')).body;
  assert.equal(raw.length, 1);
  assert.equal((await api('/api/nope')).status, 404);
  assert.equal((await api('/')).status, 404); // no dashboard build in this test

  assert.ok(wsEvents.some((e) => e.type === 'state' && e.ieeeAddress === IEEE.dimmer));
  assert.ok(wsEvents.some((e) => e.type === 'button' && e.action === '1_single'));

  // ---- the laptop sleeps for 4 hours: no energy is counted for that time ----
  clock += 4 * H;
  await tick();
  let sessions = await store.sessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].end_reason, 'computer asleep or app paused');
  assert.equal(sessions[0].ended_at, null);
  clock += H / 2;
  await tick();
  const afterSleep = (await api('/api/energy?from=2026-11-24T00:00:00Z&to=2026-11-25T00:00:00Z&interval=day')).body;
  const dimmerWh = afterSleep.find((e: any) => e.ieeeAddress === IEEE.dimmer).wh;
  assert.equal(Math.round(dimmerWh), 60, '1 h + 0.5 h at 40 W, sleep excluded');

  // ---- the box drops the connection ----
  broker.dropClients();
  await until(async () => (await store.sessions())[0].ended_at !== null, 'session closed on disconnect');
  assert.match((await store.sessions())[0].end_reason, /connection lost/);
  await until(() => collector.getStatus().mqtt === 'connected', 'reconnect', 10000);

  // ---- restart: state is remembered ----
  await collector.stop();
  collector = makeCollector();
  await collector.start();
  const remembered = (await api('/api/devices')).body.find((d: any) => d.ieeeAddress === IEEE.relay);
  assert.equal(remembered.state.state_l1, 'ON');
  assert.equal(remembered.state.current_l1, 0.26);
  await until(() => collector.getStatus().mqtt === 'connected', 'connection after restart');
  await collector.stop();

  // ---- listen-only: the app never sent a PUBLISH packet (type 3) ----
  assert.ok(broker.receivedTypes.includes(1) && broker.receivedTypes.includes(8));
  assert.equal(broker.receivedTypes.includes(3), false);
  // Only CONNECT (1), SUBSCRIBE (8), PINGREQ (12) and DISCONNECT (14) were ever sent.
  for (const type of broker.receivedTypes) assert.ok([1, 8, 12, 14].includes(type), `unexpected packet type ${type}`);
});
