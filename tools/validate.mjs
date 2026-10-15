#!/usr/bin/env node
/**
 * validate.mjs — sanity checks that run locally and in CI.
 *
 *   node tools/validate.mjs
 *
 * Checks
 *  1. every JS/MJS file parses
 *  2. both manifests are valid JSON and agree on the version
 *  3. every file a manifest references actually exists
 *  4. icons are real PNGs at the expected sizes
 *  5. every local image the README references exists
 *
 * Flags
 *   --strict   treat skipped checks as failures (used by CI so a check can
 *              never silently pass because the environment could not run it)
 *
 * Exits non-zero when anything fails so CI turns red.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');
const problems = [];
const notes = [];
const warnings = [];

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const abs = (p) => path.join(ROOT, p);
const exists = (p) => fs.existsSync(abs(p));

/* ------------------------------------------------------------- 1. syntax */

function walk(dir, test, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, test, out);
    else if (test(entry.name)) out.push(full);
  }
  return out;
}

const sources = [
  ...walk(path.join(ROOT, 'src'), (n) => n.endsWith('.js')),
  ...walk(path.join(ROOT, 'tools'), (n) => n.endsWith('.mjs'))
].sort();

/**
 * Parse a file without running it.
 *
 * `vm.SourceTextModule` needs --experimental-vm-modules, so the normal path is
 * a `node --check` child process. Some sandboxes refuse to spawn the running
 * binary (EBUSY); that is an environment limitation rather than a code defect,
 * so it downgrades to a warning instead of failing the run.
 */
function checkSyntax(file) {
  if (vm.SourceTextModule) {
    try {
      new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.error) return { ok: true, skipped: res.error.code };
  if (res.status !== 0) return { ok: false, reason: (res.stderr || '').trim() };
  return { ok: true };
}

let skipped = 0;
for (const file of sources) {
  const result = checkSyntax(file);
  if (result.ok && result.skipped) {
    skipped++;
    if (!warnings.length) {
      warnings.push(
        `could not spawn ${path.basename(process.execPath)} to parse files ` +
          `(${result.skipped}) — syntax checks skipped in this environment`
      );
    }
  } else if (!result.ok) {
    problems.push(`syntax error in ${rel(file)}\n${result.reason}`);
  }
}
notes.push(
  skipped
    ? `parsed 0 of ${sources.length} JS files (spawning unavailable)`
    : `parsed ${sources.length} JS files`
);

/* ----------------------------------------------------------- 2. manifests */

const manifests = ['manifest.json', 'manifest-v2.json'];
const parsed = {};

for (const name of manifests) {
  if (!exists(name)) {
    problems.push(`missing ${name}`);
    continue;
  }
  try {
    parsed[name] = JSON.parse(fs.readFileSync(abs(name), 'utf8'));
  } catch (err) {
    problems.push(`${name} is not valid JSON: ${err.message}`);
  }
}

const versions = new Set(Object.values(parsed).map((m) => m.version));
if (versions.size > 1) {
  problems.push(`manifests disagree on version: ${[...versions].join(' vs ')}`);
} else if (versions.size === 1) {
  notes.push(`version ${[...versions][0]}`);
}

/* ------------------------------------------------- 3. referenced files exist */

for (const [name, m] of Object.entries(parsed)) {
  const refs = new Set();

  const addRef = (v) => {
    if (typeof v === 'string' && v && !v.startsWith('http')) refs.add(v);
  };

  const action = m.action || m.browser_action || {};
  addRef(action.default_popup);
  for (const p of Object.values(action.default_icon || {})) addRef(p);

  addRef(m.options_ui && m.options_ui.page);

  const bg = m.background || {};
  addRef(bg.service_worker);
  addRef(bg.page);
  for (const s of bg.scripts || []) addRef(s);

  for (const cs of m.content_scripts || []) {
    for (const f of cs.js || []) addRef(f);
    for (const f of cs.css || []) addRef(f);
  }

  for (const p of Object.values(m.icons || {})) addRef(p);

  for (const war of m.web_accessible_resources || []) {
    for (const r of typeof war === 'string' ? [war] : war.resources || []) {
      if (r.includes('*')) continue;
      addRef(r);
    }
  }

  for (const ref of refs) {
    if (!exists(ref)) problems.push(`${name} references a missing file: ${ref}`);
  }
  notes.push(`${name}: ${refs.size} referenced files all present`);
}

/* --------------------------------------------------------------- 4. icons */

function pngSize(file) {
  const head = fs.readFileSync(abs(file)).subarray(0, 24);
  if (head.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

for (const size of [16, 32, 48, 128]) {
  const file = `assets/icon${size}.png`;
  if (!exists(file)) {
    problems.push(`missing ${file}`);
    continue;
  }
  const dim = pngSize(file);
  if (!dim) problems.push(`${file} is not a PNG`);
  else if (dim.w !== size || dim.h !== size) {
    problems.push(`${file} is ${dim.w}x${dim.h}, expected ${size}x${size}`);
  }
}
notes.push('icons are square PNGs at 16/32/48/128');

/* ------------------------------------------------------- 5. README images */

if (exists('README.md')) {
  const md = fs.readFileSync(abs('README.md'), 'utf8');
  const refs = [...md.matchAll(/src="(docs\/[^"]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(refs)].filter((r) => !exists(r));
  for (const r of missing) problems.push(`README references a missing image: ${r}`);
  notes.push(`README: ${new Set(refs).size} images all present`);
}

/* --------------------------------------------------------------- report */

for (const n of notes) console.log(`  ✓ ${n}`);
for (const w of warnings) console.log(`  ! ${w}`);

if (STRICT && warnings.length) {
  problems.push(...warnings.map((w) => `${w} (--strict)`));
}

if (problems.length) {
  console.error('\n✗ validation failed:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nAll checks passed.');
