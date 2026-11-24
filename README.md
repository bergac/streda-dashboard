# Streda dashboard

A dashboard for your Streda home installation. It **listens** to the Streda control box (SCB) and shows:

- which lights and sockets are on or off, what each unit reports, and alerts (smoke, low battery, offline)
- power right now and energy per unit, room, day, week and month
- every press on a wireless wall switch or the doorbell
- history charts per unit

It remembers the last known state of every unit (also after a restart) and stores everything in PostgreSQL, including the readable names and rooms you give each unit.

**Listen-only.** The app subscribes to the box's messages and never sends commands. Its MQTT client has no publish function at all, so it cannot switch anything or change settings on the box.

## Requirements

- **Docker Desktop** for Mac (Apple Silicon is fine): https://www.docker.com/products/docker-desktop/
- Your Mac on the same home network as the Streda box (`123.456.7.8`)

## Start it

1. Open Terminal in this folder.
2. Create your configuration file by copying the example:

   ```sh
   cp .env.example .env
   ```

3. Open `.env` and fill it in:
   - `STREDA_HOST`: the IP address of the Streda box on your home network (for example `123.456.7.8`).
   - `POSTGRES_PASSWORD`: choose your own database password, using letters and digits only (it goes into a URL).
   - Adjust the other values (MQTT port, timezone, retention) only if you need to. Each one is explained in the file.

   Keep `.env` private. It holds your credentials and is not meant to be committed.
4. Start:

   ```sh
   docker compose up -d --build
   ```

5. Open **http://localhost:8080**

The first build downloads Node and Postgres images and installs packages, which takes a few minutes. After that it starts in seconds. Containers restart automatically when Docker Desktop starts. To have it running after a reboot, turn on *Start Docker Desktop when you sign in* in Docker Desktop's settings.

Other devices on your home network can open the dashboard at `http://<your-mac's-ip>:8080`. There is no login, so anyone on your Wi-Fi can view it and edit names.

## First steps

1. **System** page: check that it says *Connected and listening* and that messages are arriving.
2. **Names** page: give every unit a name and a room. To find out which unit is which, switch a light on or off: the unit that changes shows *updated just now*.
3. Let it run. Charts and energy figures fill up over time.

**Please send the raw messages after the first hour.** This is the first time the dashboard talks to a real Streda box, and the parsing was built from Zigbee2MQTT's documented formats, not from your box. On the **System** page, click *Download (JSON)* and share the file, so the parsing can be adjusted where your box differs (for example a different name for the current or power value).

## Everyday commands

```sh
docker compose ps              # is it running?
docker compose logs -f app     # watch what the app is doing
docker compose stop            # stop (data is kept)
docker compose up -d           # start again
docker compose up -d --build   # after updating the code
```

**Backup** the database (names, history, energy):

```sh
docker compose exec db pg_dump -U streda streda > streda-backup.sql
```

**Restore** into a fresh install: `docker compose exec -T db psql -U streda streda < streda-backup.sql`

`docker compose down` keeps your data. `docker compose down -v` **deletes** it.

## Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `STREDA_HOST` | — | IP address of the Streda box |
| `STREDA_MQTT_PORT` | `1883` | MQTT port of the box |
| `STREDA_MQTT_USERNAME` / `_PASSWORD` | empty | only if the box asks for a login |
| `STREDA_BASE_TOPIC` | `zigbee2mqtt` | MQTT topic prefix used by the box |
| `POSTGRES_PASSWORD` | — | database password (letters and digits) |
| `DASHBOARD_PORT` | `8080` | port of the dashboard on your Mac |
| `TZ` | `Europe/Amsterdam` | time zone for days and months in energy totals |
| `MAINS_VOLTAGE` | `230` | used to estimate power from current |
| `RAW_RETENTION_DAYS` | `7` | how long raw messages are kept (0 = forever) |
| `READINGS_RETENTION_DAYS` | `0` | how long value history is kept (0 = forever) |

## Good to know

- **Energy is approximate.** Units that report power (W) or an energy counter (kWh) are used as reported. Units that only report current (A) get power estimated as amps × 230 V; those figures are marked *est.* It is good for comparing units, not a replacement for your electricity meter.
- **Gaps.** The dashboard only records while your Mac is awake and on your home network. When the lid is closed, there's a gap. The *Listening periods* table on the System page shows them, and gaps never count as energy use. After a gap, the dashboard assumes the last known values still hold until a unit reports again. Units with their own energy counter stay accurate across gaps.
- **Which button controls which light** is set inside the Streda box and isn't visible over MQTT, so the dashboard can't show that mapping.
- The Zigbee2MQTT web interface on the box (port 8888) can change the box's configuration. This dashboard never touches it.

## Troubleshooting

**"Box not reachable"**: check from your Mac that the box answers:

```sh
nc -vz 123.456.7.8 1883
```

If that fails, the Mac isn't on the same network, or the box's address changed (check your router). If it works but the dashboard still can't connect, check `docker compose logs app`.

**Units show "Not heard from yet"**: many units only report when something changes. Switch the light, or wait.

**Port 8080 already in use**: set `DASHBOARD_PORT=8081` in `.env` and run `docker compose up -d`.

## Try it without the box

A built-in simulator pretends to be a Streda box with made-up units:

```sh
npm install
npm run fake-box     # listens on port 1884
```

Then, in another terminal, start the dashboard against it:

```sh
STREDA_HOST=host.docker.internal STREDA_MQTT_PORT=1884 docker compose up -d --build
```

Note that this writes simulated data into the database. Use `docker compose down -v` afterwards for a clean start with the real box.

## How it's built

```
Streda box (Zigbee2MQTT, MQTT :1883)
   │  subscribe only: zigbee2mqtt/#
   ▼
collector ──► PostgreSQL ◄── HTTP API ──► dashboard (React)
                                └── WebSocket: live updates
```

- `server/mqtt/client.ts`: minimal MQTT 3.1.1 client that can only connect, subscribe and receive
- `server/collector/`: understands the device list and messages, remembers state, energy bookkeeping, sleep detection
- `server/db/`: schema (`migrations.ts`, applied automatically on start) and all queries
- `server/http/`: REST API and WebSocket
- `web/`: the dashboard (React, built with esbuild)
- `tools/`: the fake box used by the tests and `npm run fake-box`

Database tables: `devices`, `device_labels` (your names and rooms), `device_state` (last known state), `readings` (history), `button_events`, `energy_hourly`, `raw_messages`, `collector_sessions` (listening periods).

### Development

```sh
npm install
npm run typecheck
npm test             # needs a Postgres server and the psql command line tool
npm run build && STREDA_HOST=... DATABASE_URL=postgres://... npm start
```

The tests use a throwaway database on the server set by `TEST_PGHOST`, `TEST_PGPORT` and `TEST_PGUSER` (defaults: `/tmp/pgtest`, `55432`, `postgres`).

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You can use, modify and share it for personal, hobby, educational, research and other non-commercial purposes. Any commercial use needs a separate commercial license from the author.
