// Zips dist/ flat (files at the zip root) into todoist-sync-<version>.zip.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const zip = `todoist-sync-${version}.zip`;
rmSync(zip, { force: true });
execFileSync('zip', ['-j', '-q', zip, 'dist/plugin.js', 'dist/manifest.json', 'dist/icon.svg']);
console.log(zip);
