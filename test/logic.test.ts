import test from 'node:test';
import assert from 'node:assert/strict';
import { categorize, parseBridgeDevices } from '../server/collector/devices.ts';
import { diffState, extractButtonPress, parseAvailability } from '../server/collector/state.ts';
import { EnergyTracker, energyChannels, powerFor } from '../server/collector/energy.ts';
import { PacketReader, buildConnect, buildSubscribe, parsePublish } from '../server/mqtt/client.ts';
import { alertsOf, switchesOf } from '../server/http/present.ts';
import { splitFunctions } from '../server/collector/functions.ts';
import { bridgeDevices, IEEE, sn3Device } from './fixtures/z2m.ts';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);

test('device list: categories are recognised', () => {
  const devices = parseBridgeDevices(bridgeDevices);
  const byIeee = Object.fromEntries(devices.map((d) => [d.ieeeAddress, d.category]));
  assert.equal(byIeee[IEEE.coordinator], 'coordinator');
  assert.equal(byIeee[IEEE.relay], 'relay');
  assert.equal(byIeee[IEEE.dimmer], 'dimmer');
  assert.equal(byIeee[IEEE.wallSwitch], 'wall_switch');
  assert.equal(byIeee[IEEE.smoke], 'smoke_detector');
  assert.equal(byIeee[IEEE.doorbell], 'doorbell');
  assert.equal(byIeee[IEEE.socket], 'relay');
  assert.equal(categorize({ stateKeys: ['state_l1', 'current'] }), 'relay');
  assert.equal(categorize({ stateKeys: ['linkquality'] }), 'other');
});

test('device list: junk is ignored', () => {
  assert.deepEqual(parseBridgeDevices({ not: 'a list' }), []);
  assert.equal(parseBridgeDevices([null, 5, { friendly_name: 'no address' }]).length, 0);
});

test('state: only changed scalar values become history rows', () => {
  const first = diffState({}, { state: 'ON', linkquality: 120, update: { state: 'idle' } });
  assert.deepEqual(first.changed.map((r) => r.attribute), ['state']);
  assert.deepEqual(first.merged, { state: 'ON', linkquality: 120, update: { state: 'idle' } });
  const second = diffState(first.merged, { state: 'ON', current: 0.26, linkquality: 90 });
  assert.deepEqual(second.changed.map((r) => [r.attribute, r.valueNum]), [['current', 0.26]]);
  assert.equal(second.merged.linkquality, 90);
  const cleared = diffState(second.merged, { action: '' });
  assert.deepEqual(cleared.reported, []);
});

test('button presses and channels', () => {
  assert.deepEqual(extractButtonPress({ action: 'single', channel: 2 }), { action: 'single', channel: '2' });
  assert.deepEqual(extractButtonPress({ action: '1_single' }), { action: '1_single', channel: '1' });
  assert.deepEqual(extractButtonPress({ action: 'single_l2' }), { action: 'single_l2', channel: 'l2' });
  assert.deepEqual(extractButtonPress({ action: 'press' }), { action: 'press', channel: null });
  assert.equal(extractButtonPress({ action: '' }), null);
  assert.equal(extractButtonPress({ state: 'ON' }), null);
});

test('availability: JSON and plain forms', () => {
  assert.equal(parseAvailability('{"state":"online"}'), 'online');
  assert.equal(parseAvailability('offline'), 'offline');
  assert.equal(parseAvailability('???'), null);
});

test('power: measured, estimated from current, off', () => {
  assert.deepEqual(powerFor({ power: 40 }, '', 230), { watts: 40, estimated: false });
  assert.deepEqual(powerFor({ current: 0.5, state: 'ON' }, '', 230), { watts: 115, estimated: true });
  assert.deepEqual(powerFor({ current: 0.5, state: 'OFF' }, '', 230), { watts: 0, estimated: true });
  assert.deepEqual(powerFor({ current_l1: 1, voltage: 225 }, 'l1', 230), { watts: 225, estimated: true });
  assert.equal(powerFor({ brightness: 100 }, '', 230), null);
  assert.deepEqual(energyChannels({ power: 1, current_l1: 2, state_l2: 'ON' }).sort(), ['', 'l1']);
});

test('energy: power is integrated and split across hours', () => {
  const e = new EnergyTracker(230);
  e.update('a', { power: 100 }, T0 + 0.5 * H); // 10:30, 100 W
  e.update('a', { power: 0 }, T0 + 2 * H); // 12:00, off
  e.accrueAll(T0 + 3 * H);
  const buckets = e.drain().sort((x, y) => +x.hour - +y.hour);
  assert.deepEqual(buckets.map((b) => [b.hour.getUTCHours(), Math.round(b.wh)]), [[10, 50], [11, 100]]);
  assert.equal(buckets[0].estimated, false);
});

test('energy: paused time is not counted, resume continues with last value', () => {
  const e = new EnergyTracker(230);
  e.update('a', { power: 60 }, T0);
  e.pause(T0 + 0.25 * H); // 15 min counted
  e.accrueAll(T0 + 5 * H); // asleep: nothing
  e.resume(T0 + 5 * H);
  e.accrueAll(T0 + 5.5 * H); // 30 min counted
  const total = e.drain().reduce((s, b) => s + b.wh, 0);
  assert.equal(Math.round(total), 45);
});

test('energy: a unit with an energy counter uses counter increases, even across gaps', () => {
  const e = new EnergyTracker(230);
  e.update('s', { energy: 10.0, power: 500 }, T0);
  e.pause(T0 + H);
  e.update('s', { energy: 10.75, power: 500 }, T0 + 4 * H, false);
  e.accrueAll(T0 + 5 * H);
  const buckets = e.drain();
  assert.equal(buckets.length, 1);
  assert.equal(Math.round(buckets[0].wh), 750);
  assert.equal(buckets[0].estimated, false);
});

test('energy: estimated from current is flagged', () => {
  const e = new EnergyTracker(230);
  e.update('r', { state_l1: 'ON', current_l1: 0.1 }, T0);
  e.accrueAll(T0 + H);
  const [b] = e.drain();
  assert.equal(Math.round(b.wh), 23);
  assert.equal(b.estimated, true);
});

test('energy: seeded values wait for resume', () => {
  const e = new EnergyTracker(230);
  e.seed('a', { power: 100 });
  e.accrueAll(T0 + H);
  assert.equal(e.drain().length, 0);
  e.resume(T0 + H);
  e.accrueAll(T0 + 2 * H);
  assert.equal(Math.round(e.drain()[0].wh), 100);
});

test('mqtt: packets split across chunks are reassembled', () => {
  const topic = Buffer.from('zigbee2mqtt/Hal');
  const payload = Buffer.from('x'.repeat(300)); // needs a 2-byte remaining length
  const head = Buffer.alloc(2);
  head.writeUInt16BE(topic.length);
  const body = Buffer.concat([head, topic, payload]);
  const len = body.length;
  const pkt = Buffer.concat([Buffer.from([0x31, (len % 128) | 0x80, Math.floor(len / 128)]), body]);
  const reader = new PacketReader(1 << 20);
  assert.equal(reader.push(pkt.subarray(0, 2)).length, 0);
  assert.equal(reader.push(pkt.subarray(2, 50)).length, 0);
  const [p] = reader.push(Buffer.concat([pkt.subarray(50), Buffer.from([0xd0, 0x00])]).subarray(0, pkt.length - 50));
  const msg = parsePublish(p.flags, p.body);
  assert.equal(msg.topic, 'zigbee2mqtt/Hal');
  assert.equal(msg.payload.length, 300);
  assert.equal(msg.retain, true);
});

test('mqtt: CONNECT and SUBSCRIBE are encoded correctly', () => {
  const c = buildConnect({ clientId: 'abc', keepalive: 60 });
  assert.deepEqual([...c], [0x10, 15, 0, 4, 77, 81, 84, 84, 4, 2, 0, 60, 0, 3, 97, 98, 99]);
  const s = buildSubscribe(1, ['a/#']);
  assert.deepEqual([...s], [0x82, 8, 0, 1, 0, 3, 97, 47, 35, 0]);
});

test('dashboard: switches and alerts', () => {
  assert.deepEqual(switchesOf({ state_l2: 'OFF', state_l1: 'ON', current: 1 }), [
    { channel: 'l1', on: true },
    { channel: 'l2', on: false },
  ]);
  assert.deepEqual(alertsOf({ smoke: true, battery: 9 }, 'offline'), ['Smoke detected', 'Battery low', 'Offline']);
});

test('a unit with buttons, a buzzer, a socket and a light is split into functions, and is not a dimmer', () => {
  const [d] = parseBridgeDevices([sn3Device]);
  assert.equal(d.category, 'relay'); // the advertised brightness_l* are indicator LEDs, not a dimmer
  const fns = splitFunctions({ model: d.model, modelId: d.modelId, state: {} });
  assert.deepEqual(
    fns.map((f) => [f.channel, f.role, f.index, f.of]),
    [['l3', 'socket', 1, 1], ['l4', 'button', 1, 2], ['l5', 'button', 2, 2], ['l6', 'buzzer', 1, 1], ['l7', 'light', 1, 1]],
  );
});

test('functions: model aliases, single-function units and outlets stay one block', () => {
  assert.equal(splitFunctions({ model: null, modelId: 'HNB-W-1TB5-03/PW', state: {} }).length, 5);
  assert.equal(splitFunctions({ model: 'SN3-1TB5K-03/PW', state: {} }).at(-1)?.role, 'doorbell_button');
  assert.equal(splitFunctions({ model: 'BN0-T-03/PW', state: {} }).length, 2);
  assert.equal(splitFunctions({ model: 'BN0-S-03/PW', state: {} }).length, 0);
  assert.equal(splitFunctions({ model: 'SN2-E-03/PW', state: {} }).length, 0);
  assert.equal(splitFunctions({ model: 'BN1-1-03/PW', state: {} }).length, 0);
  assert.equal(parseBridgeDevices([{ ...sn3Device, definition: { ...sn3Device.definition, model: 'SN2-E-03/PW' }, model_id: 'SN2-E-03/PW' }])[0].category, 'dimmer');
  assert.equal(parseBridgeDevices([{ ...sn3Device, definition: { ...sn3Device.definition, model: 'BN1-1-03/PW' }, model_id: 'BN1-1-03/PW' }])[0].category, 'relay');
  assert.equal(parseBridgeDevices([{ ...sn3Device, definition: { ...sn3Device.definition, model: 'BN0-T-03/PW' }, model_id: 'BN0-T-03/PW' }])[0].category, 'wall_switch');
});

test('functions: unknown models are split only when buttons sit next to something else', () => {
  const unknown = { model: 'X-1' };
  assert.equal(splitFunctions({ ...unknown, state: { state_l1: 'ON', state_l2: 'OFF' } }).length, 0); // two relays stay together
  assert.equal(splitFunctions({ ...unknown, state: { action: 'press' } }).length, 0);
  const fns = splitFunctions({ ...unknown, state: { state_l7: 'OFF', action: 'singledown_l4' }, pressChannels: ['l5'] });
  assert.deepEqual(fns.map((f) => [f.channel, f.role]), [['l4', 'button'], ['l5', 'button'], ['l7', 'light']]);
  const dim = splitFunctions({ ...unknown, state: { state_l3: 'ON', brightness_l3: 100, action: 'singleup_l4' } });
  assert.deepEqual(dim.map((f) => f.role), ['dimmer', 'button']);
});
