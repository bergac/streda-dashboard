import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { connectPostgres } from './db/db.ts';
import { startApp } from './app.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const db = await connectPostgres(config.databaseUrl);
  const staticDir = process.env.STATIC_DIR ?? path.join(here, 'web');
  const app = await startApp(config, db, staticDir);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[app] ${signal} received, stopping`);
    await app.stop().catch((err) => console.error(err));
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[app] failed to start:', err.message ?? err);
  process.exit(1);
});
