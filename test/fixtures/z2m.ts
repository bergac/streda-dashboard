// Example Zigbee2MQTT messages, shaped like what a Streda box is expected to
// send. These are made up (the real ones will be captured on the first run),
// but they follow Zigbee2MQTT's documented formats.

export const BASE = 'zigbee2mqtt';

export const IEEE = {
  coordinator: '0x00124b0000000001',
  relay: '0x00e6e80000000a01', // two-channel relay, reports current only
  dimmer: '0x00e6e80000000b02', // dimmer SN2-E, reports power
  wallSwitch: '0x00e6e80000000c03', // battery wall switch ("plakschakelaar")
  smoke: '0x00e6e80000000d04',
  doorbell: '0x00e6e80000000e05',
  socket: '0x00e6e80000000f06', // socket with an energy counter
};

const exposesSwitch = (endpoint?: string) => ({
  type: 'switch',
  endpoint,
  features: [{ type: 'binary', name: 'state', property: endpoint ? `state_${endpoint}` : 'state' }],
});

export const bridgeDevices = [
  { ieee_address: IEEE.coordinator, friendly_name: 'Coordinator', type: 'Coordinator', supported: true, definition: null },
  {
    ieee_address: IEEE.relay,
    friendly_name: 'Woonkamer/Plafond',
    type: 'Router',
    model_id: 'SN2-R2',
    manufacturer: 'Isolectra',
    power_source: 'Mains (single phase)',
    definition: {
      model: 'SN2-R2',
      vendor: 'Isolectra',
      description: 'Streda snap-in relay, 2 channels',
      exposes: [exposesSwitch('l1'), exposesSwitch('l2'), { type: 'numeric', name: 'current', property: 'current' }],
    },
  },
  {
    ieee_address: IEEE.dimmer,
    friendly_name: '0x00e6e80000000b02',
    type: 'Router',
    model_id: 'SN2-E',
    power_source: 'Mains (single phase)',
    definition: {
      model: 'SN2-E',
      vendor: 'Isolectra',
      description: 'Streda snap-in dimmer',
      exposes: [{ type: 'light', features: [{ name: 'state', property: 'state' }, { name: 'brightness', property: 'brightness' }] }, { type: 'numeric', name: 'power', property: 'power' }],
    },
  },
  {
    ieee_address: IEEE.wallSwitch,
    friendly_name: 'Hal schakelaar',
    type: 'EndDevice',
    power_source: 'Battery',
    definition: {
      model: 'SW-2',
      vendor: 'Isolectra',
      description: 'Wireless wall switch',
      exposes: [{ type: 'enum', name: 'action', property: 'action' }, { type: 'numeric', name: 'battery', property: 'battery' }],
    },
  },
  {
    ieee_address: IEEE.smoke,
    friendly_name: 'Rookmelder overloop',
    type: 'EndDevice',
    power_source: 'Battery',
    definition: {
      model: 'SD-1',
      vendor: 'Isolectra',
      description: 'Smoke detector',
      exposes: [{ type: 'binary', name: 'smoke', property: 'smoke' }, { type: 'numeric', name: 'battery', property: 'battery' }],
    },
  },
  {
    ieee_address: IEEE.doorbell,
    friendly_name: 'Voordeur',
    type: 'EndDevice',
    definition: { model: 'DB-1', vendor: 'Isolectra', description: 'Front door bell unit', exposes: [{ type: 'enum', name: 'action', property: 'action' }] },
  },
  {
    ieee_address: IEEE.socket,
    friendly_name: 'Keuken stopcontact',
    type: 'Router',
    definition: {
      model: 'SN2-S',
      vendor: 'Isolectra',
      description: 'Socket snap-in with metering',
      exposes: [exposesSwitch(), { type: 'numeric', name: 'power', property: 'power' }, { type: 'numeric', name: 'energy', property: 'energy' }],
    },
  },
];

// A real SN3-1TB5-03/PW (two buttons, buzzer, socket, light) as the box advertises it: a generic
// definition with light endpoints (brightness_l9 ...) the hardware doesn't have.
const lightExposes = (ch: string) => ({
  type: 'light',
  endpoint: ch,
  features: [
    { type: 'binary', name: 'state', property: `state_${ch}`, endpoint: ch },
    { type: 'numeric', name: 'brightness', property: `brightness_${ch}`, endpoint: ch },
    { type: 'numeric', name: 'color_temp', property: `color_temp_${ch}`, endpoint: ch },
  ],
});
export const IEEE_SN3 = '0x00124b0038f6fe9e';
export const sn3Device = {
  ieee_address: IEEE_SN3,
  friendly_name: IEEE_SN3,
  type: 'Router',
  model_id: 'SN3-1TB5-03/PW',
  power_source: 'Mains (single phase)',
  definition: {
    model: 'SN3-1TB5-03/PW',
    vendor: 'STREDA',
    description: 'Custom device',
    exposes: [
      { type: 'enum', name: 'action', property: 'action' },
      lightExposes('l2'),
      { type: 'switch', endpoint: 'l3', features: [{ type: 'binary', name: 'state', property: 'state_l3', endpoint: 'l3' }] },
      { type: 'numeric', name: 'current', property: 'current_l3', endpoint: 'l3' },
      { type: 'switch', endpoint: 'l7', features: [{ type: 'binary', name: 'state', property: 'state_l7', endpoint: 'l7' }] },
      { type: 'numeric', name: 'current', property: 'current_l7', endpoint: 'l7' },
      lightExposes('l9'),
      lightExposes('l10'),
      lightExposes('l11'),
      lightExposes('l12'),
    ],
  },
};
