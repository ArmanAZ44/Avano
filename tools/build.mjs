#!/usr/bin/env node
/**
 * build.mjs — package Avano for Chrome and Firefox from a single source tree.
 *
 *   node tools/build.mjs
 *
 * Outputs (in dist/):
 *   Avano-<version>-chrome.zip   Chrome / Edge / Brave / Opera  (Manifest V3)
 *   Avano-<version>-firefox.xpi  Firefox                        (Manifest V2)
 *
 * An .xpi is just a ZIP with a different extension, so both targets share the
 * same tiny dependency-free ZIP writer below (node:zlib only).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Files/directories that never belong inside a shipped extension. */
const EXCLUDE = new Set([
  '.git',
  '.gitignore',
  '.github',
  '.editorconfig',
  'dist',
  'node_modules',
  'tools',
  'docs',
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'LICENSE',
  'package.json',
  'package-lock.json'
]);

/* ------------------------------------------------------------------- crc32 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* --------------------------------------------------------------------- zip */

function walk(dir, prefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && EXCLUDE.has(entry.name)) continue;
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name), rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Minimal ZIP writer (deflate or store, UTF-8 names, no data descriptors).
 * @param {Array<{name: string, data: Buffer}>} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory header
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ------------------------------------------------------------------- build */

function collect({ manifestFrom, manifestTo }) {
  // Both source manifests are dropped, then the right one is written back under
  // the name the browser expects. Removing only `manifestFrom` would leave the
  // other manifest in place and ship two copies of `manifest.json`.
  const files = walk(ROOT, '', []).filter(
    (f) => f !== 'manifest.json' && f !== 'manifest-v2.json'
  );
  const entries = files.map((f) => ({
    name: f,
    data: fs.readFileSync(path.join(ROOT, f))
  }));

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, manifestFrom), 'utf8'));
  entries.push({
    name: manifestTo,
    data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  });

  // Deterministic order keeps diffs and hashes stable between builds.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, version: manifest.version };
}

function build() {
  fs.mkdirSync(DIST, { recursive: true });

  const targets = [
    {
      label: 'Chrome / Chromium (MV3)',
      manifestFrom: 'manifest.json',
      manifestTo: 'manifest.json',
      ext: 'zip',
      browser: 'chrome'
    },
    {
      label: 'Firefox (MV2)',
      manifestFrom: 'manifest-v2.json',
      manifestTo: 'manifest.json',
      ext: 'xpi',
      browser: 'firefox'
    }
  ];

  const summary = [];
  for (const t of targets) {
    const { entries, version } = collect(t);
    const outName = `Avano-${version}-${t.browser}.${t.ext}`;
    const outPath = path.join(DIST, outName);
    const zip = makeZip(entries);
    fs.writeFileSync(outPath, zip);
    summary.push({ label: t.label, file: outName, bytes: zip.length, files: entries.length });
  }

  console.log('Avano build complete\n');
  for (const s of summary) {
    console.log(
      `  ${s.label.padEnd(26)} ${s.file.padEnd(30)} ` +
        `${String(s.files).padStart(3)} files  ${(s.bytes / 1024).toFixed(0)} KB`
    );
  }
  console.log(`\n  → ${path.relative(process.cwd(), DIST)}/`);
}

build();
