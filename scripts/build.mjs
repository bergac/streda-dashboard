// Builds the server (dist/server.js) and the dashboard (dist/web/).
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/web', { recursive: true });

await build({
  entryPoints: ['server/main.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external', // pg and ws come from node_modules
  sourcemap: true,
  logLevel: 'info',
});

await build({
  entryPoints: ['web/src/main.tsx'],
  outfile: 'dist/web/app.js',
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  jsx: 'automatic',
  minify: true,
  sourcemap: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

await cp('web/index.html', 'dist/web/index.html');
await cp('web/styles.css', 'dist/web/styles.css');
