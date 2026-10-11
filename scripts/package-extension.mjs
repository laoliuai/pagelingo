import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'apps/extension/dist');
const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
const extensionPackage = JSON.parse(readFileSync(path.join(root, 'apps/extension/package.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, extensionPackage.version, 'Build version does not match the extension package.');
assert.ok(!manifest.host_permissions && !manifest.content_scripts, 'Production permissions changed.');
const files = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(full);
    else if (!entry.name.endsWith('.map')) files.push({ name: path.relative(dist, full).split(path.sep).join('/'), data: readFileSync(full) });
  }
}
visit(dist);
files.push({ name: 'INSTALL.md', data: readFileSync(path.join(root, 'docs/install-m2.md')) });
files.push({ name: 'glossary.md', data: readFileSync(path.join(root, 'docs/glossary.md')) });
files.push({ name: 'assistant.md', data: readFileSync(path.join(root, 'docs/assistant.md')) });
for (const extension of ['json', 'csv', 'md']) {
  const name = `glossaries/common-tech.en-zh.${extension}`;
  files.push({ name, data: readFileSync(path.join(root, 'docs', name)) });
}
let local = {};
try { local = parseEnv(readFileSync(path.join(root, '.env.local'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const secret = process.env.PAGELINGO_LLM_API_KEY?.trim() || local.PAGELINGO_LLM_API_KEY?.trim();
for (const file of files) {
  assert.ok(!/\.env|node_modules|(^|\/)\.\.(\/|$)/.test(file.name), 'Unexpected package file.');
  if (secret) assert.ok(!file.data.includes(Buffer.from(secret)), 'Package contains a local credential.');
}
for (const name of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, manifest.side_panel.default_path]) assert.ok(files.some((f) => f.name === name), `Missing entry: ${name}`);

// Small reproducible ZIP using Node only. DOS date 1980-01-01, UTF-8 filenames,
// DEFLATE, CRC32 and central directory; our bounded extension needs no ZIP64.
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};
const localParts = []; const directoryParts = []; let offset = 0;
for (const file of files) {
  const name = Buffer.from(file.name); const compressed = deflateRawSync(file.data); const crc = crc32(file.data);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26);
  localParts.push(header, name, compressed);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(file.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  directoryParts.push(central, name); offset += header.length + name.length + compressed.length;
}
const directory = Buffer.concat(directoryParts); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...localParts, directory, end]);
const name = `pagelingo-${manifest.version}.zip`; const releases = path.join(root, 'releases'); mkdirSync(releases, { recursive: true });
writeFileSync(path.join(releases, name), archive);
const sha256 = createHash('sha256').update(archive).digest('hex');
writeFileSync(path.join(releases, `${name}.sha256`), `${sha256}  ${name}\n`);
console.log(JSON.stringify({ artifact: `releases/${name}`, files: files.length, bytes: archive.length, sha256 }, null, 2));
