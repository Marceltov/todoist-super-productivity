// Bundles src/plugin.ts into dist/plugin.js (one IIFE, as SP requires) and copies the manifest and icon.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
await build({
  entryPoints: ['src/plugin.ts'],
  outfile: 'dist/plugin.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
});
for (const f of ['manifest.json', 'icon.svg']) copyFileSync(`src/${f}`, `dist/${f}`);
console.log('built dist/');
