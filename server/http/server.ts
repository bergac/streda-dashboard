// HTTP API, static dashboard files and the live WebSocket.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Store } from '../db/store.ts';
import type { LiveBus } from '../live.ts';
import type { CollectorStatus } from '../live.ts';
import { presentDevice } from './present.ts';

export interface ServerOptions {
  store: Store;
  live: LiveBus;
  getStatus: () => CollectorStatus;
  staticDir: string;
  mainsVoltage: number;
  timezone: string;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

async function readJson(req: http.IncomingMessage, limit = 64 * 1024): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'request too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function date(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `invalid date: ${value}`);
  return d;
}

function int(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) throw new HttpError(400, `invalid number: ${value}`);
  return Math.min(n, max);
}

function text(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new HttpError(400, `${field} is longer than ${maxLength} characters`);
  return trimmed === '' ? null : trimmed;
}

export function createServer(opts: ServerOptions) {
  const { store, live } = opts;
  const deviceExtras = async (ieee: string) => ({
    functionLabels: await store.functionLabels(ieee),
    presses: await store.lastPresses(ieee),
  });
  const staticRoot = path.resolve(opts.staticDir);

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"
    const q = url.searchParams;
    const method = req.method ?? 'GET';
    const now = new Date();

    if (method === 'GET' && parts[0] === 'status' && parts.length === 1) {
      return send(res, 200, { collector: opts.getStatus(), counts: await store.counts(), timezone: opts.timezone });
    }
    if (method === 'GET' && parts[0] === 'devices' && parts.length === 1) {
      const rows = await store.listDevices();
      const extras = { functionLabels: await store.functionLabels(), presses: await store.lastPresses() };
      return send(res, 200, rows.map((r) => presentDevice(r, opts.mainsVoltage, extras)));
    }
    if (parts[0] === 'devices' && parts.length >= 2) {
      const ieee = parts[1];
      if (method === 'GET' && parts.length === 2) {
        const row = await store.getDevice(ieee);
        if (!row) throw new HttpError(404, 'unit not found');
        return send(res, 200, { ...presentDevice(row, opts.mainsVoltage, await deviceExtras(ieee)), definition: row.definition ?? null });
      }
      if (method === 'PUT' && parts[2] === 'label' && parts.length === 3) {
        const body = await readJson(req);
        const label = {
          displayName: text(body.displayName, 'displayName', 100),
          room: text(body.room, 'room', 60),
          notes: text(body.notes, 'notes', 1000),
          hidden: body.hidden === true,
        };
        if (!(await store.saveLabel(ieee, label))) throw new HttpError(404, 'unit not found');
        live.publish({ type: 'devices' });
        const row = await store.getDevice(ieee);
        return send(res, 200, presentDevice(row!, opts.mainsVoltage, await deviceExtras(ieee)));
      }
      if (method === 'PUT' && parts[2] === 'functions' && parts[4] === 'label' && parts.length === 5) {
        const channel = parts[3];
        const row = await store.getDevice(ieee);
        if (!row) throw new HttpError(404, 'unit not found');
        const known = presentDevice(row, opts.mainsVoltage, await deviceExtras(ieee)).functions;
        if (!known.some((f) => f.channel === channel)) throw new HttpError(404, 'function not found');
        const body = await readJson(req);
        const label = {
          displayName: text(body.displayName, 'displayName', 100),
          room: text(body.room, 'room', 60),
          notes: text(body.notes, 'notes', 1000),
          hidden: body.hidden === true,
        };
        await store.saveFunctionLabel(ieee, channel, label);
        live.publish({ type: 'devices' });
        return send(res, 200, presentDevice(row, opts.mainsVoltage, await deviceExtras(ieee)));
      }
      if (parts[2] === 'actions' && parts.length === 3) {
        if (method === 'GET') return send(res, 200, await store.buttonActions(ieee));
        if (method === 'PUT') {
          const body = await readJson(req);
          const raw = body.names;
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new HttpError(400, 'names must be an object');
          const names: Record<string, string | null> = {};
          for (const [action, value] of Object.entries(raw)) {
            if (action.length > 200) throw new HttpError(400, 'action is too long');
            names[action] = text(value, `names.${action}`, 100);
          }
          if (!(await store.saveButtonActionNames(ieee, names))) throw new HttpError(404, 'unit not found');
          live.publish({ type: 'devices' });
          return send(res, 200, await store.buttonActions(ieee));
        }
      }
      if (method === 'GET' && parts[2] === 'attributes' && parts.length === 3) {
        return send(res, 200, await store.attributes(ieee));
      }
      if (method === 'GET' && parts[2] === 'history' && parts.length === 3) {
        const attribute = q.get('attribute');
        if (!attribute) throw new HttpError(400, 'attribute is required');
        const to = date(q.get('to'), now);
        const from = date(q.get('from'), new Date(to.getTime() - 24 * 3600_000));
        return send(res, 200, await store.history(ieee, attribute, from, to));
      }
    }
    if (method === 'GET' && parts[0] === 'rooms' && parts.length === 1) {
      return send(res, 200, await store.rooms());
    }
    if (method === 'GET' && parts[0] === 'energy' && parts.length === 1) {
      const interval = (q.get('interval') ?? 'day') as 'hour' | 'day' | 'month';
      if (!['hour', 'day', 'month'].includes(interval)) throw new HttpError(400, 'interval must be hour, day or month');
      const to = date(q.get('to'), now);
      const from = date(q.get('from'), new Date(to.getTime() - 7 * 24 * 3600_000));
      return send(res, 200, await store.energy({ from, to, interval, timezone: opts.timezone }));
    }
    if (method === 'GET' && parts[0] === 'buttons' && parts.length === 1) {
      const before = q.get('before');
      return send(
        res,
        200,
        await store.buttonEvents({ limit: int(q.get('limit'), 100, 1000), before: before ? date(before, now) : undefined, ieee: q.get('ieee') ?? undefined }),
      );
    }
    if (method === 'GET' && parts[0] === 'sessions' && parts.length === 1) {
      return send(res, 200, await store.sessions(int(q.get('limit'), 50, 500)));
    }
    if (method === 'GET' && parts[0] === 'raw' && parts.length === 1) {
      const rows = await store.rawMessages({ limit: int(q.get('limit'), 200, 20000), topic: q.get('topic') ?? undefined });
      const headers: Record<string, string> = q.get('download')
        ? { 'content-disposition': `attachment; filename="streda-raw-messages-${now.toISOString().slice(0, 10)}.json"` }
        : {};
      return send(res, 200, rows, headers);
    }
    throw new HttpError(404, 'not found');
  }

  async function serveStatic(res: http.ServerResponse, url: URL) {
    let file = path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(staticRoot)) throw new HttpError(404, 'not found');
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = path.join(file, 'index.html');
    } catch {
      file = path.join(staticRoot, 'index.html'); // single-page app: unknown paths get the app
    }
    try {
      const body = await readFile(file);
      const ext = path.extname(file);
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(body);
    } catch {
      throw new HttpError(404, 'dashboard files not found (did the build run?)');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      return await serveStatic(res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[http]', err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (err as Error).message });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'status', status: opts.getStatus() }));
    const unsubscribe = live.subscribe((event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 30_000);
    ws.on('close', () => {
      unsubscribe();
      clearInterval(ping);
    });
    ws.on('message', () => {}); // the dashboard never sends anything that matters
  });

  return {
    listen: (port: number, host = '0.0.0.0') =>
      new Promise<number>((resolve) => server.listen(port, host, () => resolve((server.address() as any).port))),
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
