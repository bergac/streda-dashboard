# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **listen-only** dashboard for the Streda control box (SCB, a Zigbee2MQTT box on the home network). It subscribes to `<baseTopic>/#` over MQTT, stores state/readings/energy in PostgreSQL, and serves a React dashboard with live updates over WebSocket. Normally runs via Docker Compose on a Mac.

**Hard invariant:** the app must never send anything to the box. `server/mqtt/client.ts` is a minimal MQTT 3.1.1 client with no publish function by design — do not add one, and do not add anything that talks to the box's Zigbee2MQTT web UI (port 8888).

## Commands

```sh
npm install
npm run typecheck        # tsc --noEmit (covers server, tools, test; not web/)
npm test                 # node --import tsx --test test/*.test.ts
node --import tsx --test --test-name-pattern="<name>" test/logic.test.ts   # single test
npm run build            # esbuild: dist/server.js + dist/web/
npm run fake-box         # simulated Streda box on port 1884
npm start                # runs dist/server.js (needs STREDA_HOST, DATABASE_URL)
docker compose up -d --build   # the normal way to run the full stack (dashboard on :8080)
```

Tests need a local Postgres server plus the `psql` CLI. They use a throwaway database on `TEST_PGHOST`/`TEST_PGPORT`/`TEST_PGUSER` (defaults `/tmp/pgtest`, `55432`, `postgres`). `test/psql-db.ts` is a test-only `Database` adapter that shells out to `psql`; production uses `pg`.

Configuration is via env vars (see `.env.example` and the README table; parsed in `server/config.ts`). `.env` holds real credentials — don't read or print it.

## Architecture

```
SCB (MQTT) ─► mqtt/client ─► collector ─► db/store (Postgres) ◄─ http/server ─► web (React)
                                  └────────► live (LiveBus) ───► WebSocket ───────┘
```

- `server/app.ts` — `startApp(config, db, staticDir)` wires everything together. `main.ts` calls it with real Postgres; tests call it with a test DB and the fake box. Keep new wiring here so tests exercise the same path.
- `server/collector/` — the core logic: `devices.ts` parses the Zigbee2MQTT device list, `state.ts` tracks last known state, `energy.ts` does energy bookkeeping (uses reported W/kWh, or estimates from amps × `MAINS_VOLTAGE`, flagged "est."), `collector.ts` orchestrates, handles sleep/gap detection and retention ticks. Gaps while the app isn't listening must never count as energy use.
- `server/db/` — `migrations.ts` (schema, applied automatically on start via `migrate`) and `store.ts` (all queries). Put SQL in `store.ts`, schema changes in `migrations.ts`.
- `server/http/` — REST API + WebSocket (`server.ts`); `present.ts` shapes DB rows for the UI.
- `web/` — React 19 SPA (`src/pages/*`, `src/components/charts.tsx`), bundled by `scripts/build.mjs` and served as static files from `dist/web`. Not covered by `tsc` (`tsconfig.json` includes only server/tools/test).
- `tools/` — `fake-box.ts` / `fake-broker.ts`: simulated box used by `e2e.test.ts` and `npm run fake-box`. `test/fixtures/z2m.ts` holds sample Zigbee2MQTT payloads.

## Conventions and gotchas

- ESM with `NodeNext`: relative imports use explicit `.ts` extensions (`allowImportingTsExtensions`). Node >= 22. Runtime deps are only `pg` and `ws`; esbuild marks them external.
- **Message parsing is based on Zigbee2MQTT's documented formats, not on a real SCB.** Field names (current/power values) may differ on the real box; the System page's raw-message download exists to adjust parsing. Raw messages are stored in `raw_messages` (pruned by `RAW_RETENTION_DAYS`).
- Which wall button controls which light is configured inside the box and is not visible over MQTT.
