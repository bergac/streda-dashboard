// A minimal, LISTEN-ONLY MQTT 3.1.1 client.
//
// It can connect, subscribe (QoS 0) and receive messages. It deliberately has
// no publish function: this app can never switch a light or change a setting
// on the Streda box, because the code to send a PUBLISH packet does not exist.
//
// Packets this client sends: CONNECT, SUBSCRIBE, PINGREQ, DISCONNECT.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

export interface MqttOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  clientId?: string;
  keepaliveSeconds?: number;
  /** Topic filters to subscribe to, e.g. ["zigbee2mqtt/#"]. */
  subscriptions: string[];
  /** Largest packet accepted, in bytes. The device list can be a few hundred KB. */
  maxPacketBytes?: number;
}

export interface MqttMessage {
  topic: string;
  payload: Buffer;
  retain: boolean;
}

export interface ListenOnlyMqttClient extends EventEmitter {
  start(): void;
  stop(): Promise<void>;
  readonly connected: boolean;
}

const CONNACK_ERRORS: Record<number, string> = {
  1: 'unacceptable protocol version',
  2: 'client identifier rejected',
  3: 'server unavailable',
  4: 'bad username or password',
  5: 'not authorized',
};

function encodeString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

function encodeRemainingLength(length: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    bytes.push(byte);
  } while (length > 0);
  return Buffer.from(bytes);
}

function packet(firstByte: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([firstByte]), encodeRemainingLength(body.length), body]);
}

export function buildConnect(opts: { clientId: string; keepalive: number; username?: string; password?: string }): Buffer {
  let flags = 0x02; // clean session
  if (opts.username !== undefined) flags |= 0x80;
  if (opts.password !== undefined) flags |= 0x40;
  const keepalive = Buffer.alloc(2);
  keepalive.writeUInt16BE(opts.keepalive, 0);
  const parts = [encodeString('MQTT'), Buffer.from([0x04, flags]), keepalive, encodeString(opts.clientId)];
  if (opts.username !== undefined) parts.push(encodeString(opts.username));
  if (opts.password !== undefined) parts.push(encodeString(opts.password));
  return packet(0x10, Buffer.concat(parts));
}

export function buildSubscribe(packetId: number, filters: string[]): Buffer {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId, 0);
  const parts: Buffer[] = [id];
  for (const filter of filters) parts.push(encodeString(filter), Buffer.from([0x00])); // QoS 0
  return packet(0x82, Buffer.concat(parts));
}

const PINGREQ = Buffer.from([0xc0, 0x00]);
const DISCONNECT = Buffer.from([0xe0, 0x00]);

/** Splits a byte stream into complete MQTT packets. */
export class PacketReader {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly maxPacketBytes: number) {}

  push(chunk: Buffer): Array<{ type: number; flags: number; body: Buffer }> {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const packets: Array<{ type: number; flags: number; body: Buffer }> = [];
    for (;;) {
      if (this.buffer.length < 2) break;
      let multiplier = 1;
      let length = 0;
      let index = 1;
      let complete = false;
      while (index < this.buffer.length && index <= 4) {
        const byte = this.buffer[index];
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        index++;
        if ((byte & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        if (index > 4) throw new Error('malformed remaining length');
        break;
      }
      if (length > this.maxPacketBytes) throw new Error(`packet of ${length} bytes exceeds limit`);
      if (this.buffer.length < index + length) break;
      const first = this.buffer[0];
      packets.push({ type: first >> 4, flags: first & 0x0f, body: this.buffer.subarray(index, index + length) });
      this.buffer = this.buffer.subarray(index + length);
    }
    return packets;
  }
}

export function parsePublish(flags: number, body: Buffer): MqttMessage {
  const topicLength = body.readUInt16BE(0);
  const topic = body.subarray(2, 2 + topicLength).toString('utf8');
  const qos = (flags >> 1) & 0x03;
  const payloadStart = 2 + topicLength + (qos > 0 ? 2 : 0);
  return { topic, payload: Buffer.from(body.subarray(payloadStart)), retain: (flags & 0x01) === 1 };
}

export function createListenOnlyClient(options: MqttOptions): ListenOnlyMqttClient {
  const emitter = new EventEmitter() as ListenOnlyMqttClient;
  const keepalive = options.keepaliveSeconds ?? 60;
  const clientId = options.clientId ?? `streda-dashboard-${randomBytes(4).toString('hex')}`;
  const maxPacketBytes = options.maxPacketBytes ?? 16 * 1024 * 1024;

  let socket: net.Socket | null = null;
  let stopped = true;
  let isConnected = false;
  let reconnectDelay = 1000;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let lastPacketAt = 0;

  Object.defineProperty(emitter, 'connected', { get: () => isConnected });

  function clearTimers() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  }

  function connect() {
    const reader = new PacketReader(maxPacketBytes);
    const sock = net.createConnection({ host: options.host, port: options.port });
    socket = sock;
    sock.setNoDelay(true);
    sock.setTimeout(15_000); // only until CONNACK
    let closedReason = 'connection closed';

    sock.on('connect', () => {
      sock.write(buildConnect({ clientId, keepalive, username: options.username, password: options.password }));
    });

    sock.on('timeout', () => {
      closedReason = 'timed out waiting for the broker';
      sock.destroy();
    });

    sock.on('data', (chunk: Buffer) => {
      lastPacketAt = Date.now();
      let packets;
      try {
        packets = reader.push(chunk);
      } catch (err) {
        closedReason = `protocol error: ${(err as Error).message}`;
        sock.destroy();
        return;
      }
      for (const p of packets) {
        switch (p.type) {
          case 2: {
            // CONNACK
            const code = p.body[1];
            if (code !== 0) {
              closedReason = `broker refused connection: ${CONNACK_ERRORS[code] ?? `code ${code}`}`;
              sock.destroy();
              return;
            }
            sock.setTimeout(0);
            sock.write(buildSubscribe(1, options.subscriptions));
            break;
          }
          case 9: {
            // SUBACK
            const failed = [...p.body.subarray(2)].some((c) => c === 0x80);
            if (failed) {
              closedReason = 'broker refused the subscription';
              sock.destroy();
              return;
            }
            isConnected = true;
            reconnectDelay = 1000;
            clearTimers();
            pingTimer = setInterval(() => {
              if (Date.now() - lastPacketAt > keepalive * 1500) {
                closedReason = 'broker stopped responding';
                sock.destroy();
                return;
              }
              sock.write(PINGREQ);
            }, (keepalive * 1000) / 2);
            emitter.emit('connected');
            break;
          }
          case 3: {
            // PUBLISH (incoming). We subscribed with QoS 0, so no acknowledgement is needed.
            try {
              emitter.emit('message', parsePublish(p.flags, p.body));
            } catch (err) {
              emitter.emit('error', err);
            }
            break;
          }
          case 13: // PINGRESP
            break;
          default:
            break;
        }
      }
    });

    sock.on('error', (err) => {
      closedReason = err.message;
    });

    sock.on('close', () => {
      clearTimers();
      const wasConnected = isConnected;
      isConnected = false;
      if (socket === sock) socket = null;
      emitter.emit('disconnected', { reason: closedReason, wasConnected });
      scheduleReconnect();
    });
  }

  emitter.start = () => {
    if (!stopped) return;
    stopped = false;
    connect();
  };

  emitter.stop = () =>
    new Promise<void>((resolve) => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearTimers();
      const sock = socket;
      if (!sock) return resolve();
      sock.once('close', () => resolve());
      if (isConnected) sock.end(DISCONNECT);
      else sock.destroy();
      setTimeout(() => sock.destroy(), 1000).unref();
    });

  return emitter;
}
