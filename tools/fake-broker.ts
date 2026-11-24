// A tiny MQTT broker that pretends to be the Streda box. Used by the tests and
// by `npm run fake-box`, so the dashboard can be tried without the real box.
// It records every packet type a client sends, so tests can prove the
// dashboard never publishes anything.

import net from 'node:net';
import { PacketReader } from '../server/mqtt/client.ts';

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

function publishPacket(topic: string, payload: string | Buffer, retain: boolean): Buffer {
  const t = Buffer.from(topic, 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(t.length, 0);
  const body = Buffer.concat([head, t, Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')]);
  return Buffer.concat([Buffer.from([0x30 | (retain ? 1 : 0)]), encodeRemainingLength(body.length), body]);
}

function matches(filter: string, topic: string): boolean {
  if (filter === '#') return true;
  if (filter.endsWith('/#')) return topic === filter.slice(0, -2) || topic.startsWith(filter.slice(0, -1));
  return filter === topic;
}

interface Client {
  socket: net.Socket;
  filters: string[];
}

export class FakeBroker {
  private server = net.createServer((s) => this.onClient(s));
  private clients = new Set<Client>();
  private retained = new Map<string, Buffer | string>();
  /** Packet type numbers received from clients (3 = PUBLISH, which must never appear). */
  readonly receivedTypes: number[] = [];
  port = 0;

  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve) =>
      this.server.listen(port, host, () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve(this.port);
      }),
    );
  }

  close(): Promise<void> {
    for (const c of this.clients) c.socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Drops every connection (simulates the box rebooting or Wi-Fi dropping). */
  dropClients() {
    for (const c of this.clients) c.socket.destroy();
  }

  get clientCount() {
    return [...this.clients].filter((c) => c.filters.length > 0).length;
  }

  publish(topic: string, payload: unknown, retain = false) {
    const data = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
    if (retain) this.retained.set(topic, data);
    for (const c of this.clients) {
      if (c.filters.some((f) => matches(f, topic))) c.socket.write(publishPacket(topic, data, false));
    }
  }

  private onClient(socket: net.Socket) {
    const client: Client = { socket, filters: [] };
    this.clients.add(client);
    const reader = new PacketReader(16 * 1024 * 1024);
    socket.on('data', (chunk: Buffer) => {
      for (const p of reader.push(chunk)) {
        this.receivedTypes.push(p.type);
        if (p.type === 1) socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00])); // CONNACK ok
        else if (p.type === 8) {
          // SUBSCRIBE
          const id = p.body.subarray(0, 2);
          let i = 2;
          const codes: number[] = [];
          while (i < p.body.length) {
            const len = p.body.readUInt16BE(i);
            client.filters.push(p.body.subarray(i + 2, i + 2 + len).toString('utf8'));
            i += 2 + len + 1;
            codes.push(0);
          }
          socket.write(Buffer.concat([Buffer.from([0x90, 2 + codes.length]), id, Buffer.from(codes)]));
          for (const [topic, data] of this.retained) {
            if (client.filters.some((f) => matches(f, topic))) socket.write(publishPacket(topic, data, true));
          }
        } else if (p.type === 12) socket.write(Buffer.from([0xd0, 0x00])); // PINGRESP
        else if (p.type === 14) socket.end(); // DISCONNECT
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.clients.delete(client));
  }
}
