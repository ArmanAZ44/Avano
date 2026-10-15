#!/usr/bin/env node
/**
 * lint-firefox.mjs — run Mozilla's addons-linter over the built .xpi.
 *
 *   node tools/lint-firefox.mjs
 *
 * This is the exact validator addons.mozilla.org runs on submission, so it
 * catches AMO-blocking problems (missing add-on ID, missing data collection
 * permissions, unsupported APIs, unsafe innerHTML) before you upload.
 *
 * Requires the optional dev dependency:
 *   npm install
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

const xpi = fs.readdirSync(DIST).find((f) => f.endsWith('.xpi'));
if (!xpi) {
  console.error('No .xpi in dist/ — run `npm run build` first.');
  process.exit(1);
}

let bin;
try {
  const require = createRequire(import.meta.url);
  bin = path.join(
    path.dirname(require.resolve('addons-linter/package.json')),
    'bin',
    'addons-linter'
  );
} catch {
  console.error(
    'addons-linter is not installed.\n' +
      'It is an optional dev dependency: run `npm install` first.'
  );
  process.exit(2);
}

console.log(`Linting ${xpi} the way addons.mozilla.org will…\n`);
const res = spawnSync(process.execPath, [bin, path.join(DIST, xpi)], {
  stdio: 'inherit'
});
process.exit(res.status ?? 1);
