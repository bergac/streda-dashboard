// Pretends to be a Streda box, so you can try the dashboard without one:
//
//   npm run fake-box                      # listens on port 1884
//   STREDA_HOST=host.docker.internal STREDA_MQTT_PORT=1884 docker compose up
//
// It sends made-up units and switches lights on and off at random.

import { FakeBroker } from './fake-broker.ts';
import { BASE, bridgeDevices } from '../test/fixtures/z2m.ts';

const port = Number(process.env.FAKE_BOX_PORT ?? 1884);
const host = process.env.FAKE_BOX_HOST ?? '0.0.0.0';
const broker = new FakeBroker();

const state = {
  relay: { state_l1: 'ON', state_l2: 'OFF', current_l1: 0.26, current_l2: 0 },
  dimmer: { state: 'ON', brightness: 180, power: 38 },
  socket: { state: 'ON', power: 120, energy: 12.5 },
};

function publishAll() {
  broker.publish(`${BASE}/Woonkamer/Plafond`, { ...state.relay, linkquality: 140 });
  broker.publish(`${BASE}/0x00e6e80000000b02`, { ...state.dimmer, linkquality: 120 });
  broker.publish(`${BASE}/Keuken stopcontact`, { ...state.socket, linkquality: 110 });
}

await broker.listen(port, host);
broker.publish(`${BASE}/bridge/state`, { state: 'online' }, true);
broker.publish(`${BASE}/bridge/devices`, bridgeDevices, true);
for (const name of ['Hal schakelaar', 'Rookmelder overloop', 'Voordeur', 'Woonkamer/Plafond', 'Keuken stopcontact']) {
  broker.publish(`${BASE}/${name}/availability`, { state: 'online' }, true);
}
broker.publish(`${BASE}/Rookmelder overloop`, { smoke: false, battery: 87, battery_low: false, temperature: 20.5 }, true);
broker.publish(`${BASE}/Hal schakelaar`, { battery: 64 }, true);
console.log(`[fake-box] pretending to be a Streda box on ${host}:${port}`);

setInterval(() => {
  const r = Math.random();
  if (r < 0.3) {
    const on = state.relay.state_l2 === 'OFF';
    state.relay.state_l2 = on ? 'ON' : 'OFF';
    state.relay.current_l2 = on ? 0.18 : 0;
    broker.publish(`${BASE}/Hal schakelaar`, { action: on ? '2_single' : '2_double', battery: 64 });
    broker.publish(`${BASE}/Hal schakelaar`, { action: '' });
  } else if (r < 0.55) {
    state.dimmer.brightness = Math.round(60 + Math.random() * 194);
    state.dimmer.power = Math.round((state.dimmer.brightness / 254) * 45 * 10) / 10;
  } else if (r < 0.75) {
    state.socket.power = Math.round(80 + Math.random() * 1500);
  } else if (r < 0.8) {
    broker.publish(`${BASE}/Voordeur`, { action: 'ring' });
  }
  state.socket.energy = Math.round((state.socket.energy + state.socket.power / 1000 / 360) * 1000) / 1000;
  state.relay.current_l1 = Math.round((0.24 + Math.random() * 0.04) * 100) / 100;
  publishAll();
}, 10_000);
publishAll();

process.on('SIGINT', async () => {
  await broker.close();
  process.exit(0);
});
