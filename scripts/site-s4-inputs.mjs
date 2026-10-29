import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
const MiB = 1024 * 1024;
const limits = { html: 8 * MiB, image: 16 * MiB, css: 16 * MiB, json: 16 * MiB, text: MiB, pdf: 256 * MiB, bundle: 256 * MiB };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0;
const headerValue = value => text(value) && value.length <= 256 && /^[\x20-\x7e]+$/.test(value);
const primaryResponses = {
  html: { accept: 'text/html', mediaTypes: ['text/html', 'application/xhtml+xml'] },
  github: { accept: 'application/vnd.github+json', mediaTypes: ['application/json', 'application/vnd.github+json'] },
  arxiv: { accept: 'application/atom+xml', mediaTypes: ['application/atom+xml', 'application/xml', 'text/xml'] },
  bundle: { accept: 'application/zip', mediaTypes: ['application/zip', 'application/x-zip-compressed'] },
};
function sourceUrl(value) {
  assert(text(value) && value.length <= 8192, 'Source URL required');
  const url = new URL(value);
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'Uncredentialed HTTP(S) URL required');
}
async function regular(path) {
  const info = await lstat(path);
  assert(!info.isSymbolicLink(), 'Input symlink is not supported');
  assert(info.isFile(), 'Input must be a regular file');
  // Reject aliases through symlinked parent directories too.
  assert(await realpath(path) === path, 'Input parent symlink is not supported');
  return info;
}
function outside(root, path) {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}
/** Open with no-follow and verify inode/size/time before and after bounded streaming. */
export async function* verifiedInput(input) {
  const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const same = value => value.isFile() && value.dev === input.dev && value.ino === input.ino && value.size === input.bytes && value.mtimeMs === input.mtimeMs;
    assert(same(before), 'Declared input changed after preflight');
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      bytes += chunk.length; assert(bytes <= input.bytes, 'Declared input changed size'); hash.update(chunk); yield chunk;
    }
    assert(bytes === input.bytes && hash.digest('hex') === input.sha256, 'Declared input hash mismatch');
    assert(same(await handle.stat()), 'Declared input changed during read');
  } finally { await handle.close(); }
}
/** Read-only preflight: all paths and stat budgets pass before any sample body is read. */
export async function preflight(samplePath, outputPath, { requireUpgradeBaseline = false } = {}) {
  const declarationPath = resolve(samplePath), requestedOutput = resolve(outputPath);
  const declarationInfo = await regular(declarationPath);
  assert(declarationInfo.size <= MiB, 'Declaration exceeds 1 MiB');
  const handle = await open(declarationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let declaration;
  try {
    const info = await handle.stat();
    assert(info.dev === declarationInfo.dev && info.ino === declarationInfo.ino && info.size <= MiB, 'Declaration changed');
    const chunks = []; let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; assert(bytes <= MiB, 'Declaration exceeds 1 MiB'); chunks.push(chunk); }
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new Error('Declaration must be UTF-8'); }
    declaration = JSON.parse(content);
  } finally { await handle.close(); }
  assert(declaration.schemaVersion === 'pagelingo-site-s4-samples/1', 'Expected pagelingo-site-s4-samples/1');
  assert(Array.isArray(declaration.samples) && declaration.samples.length >= 1 && declaration.samples.length <= 32, 'Declare 1 to 32 samples');
  const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  assert(!await lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), 'Output must be a new directory');
  const inodes = new Set([`${declarationInfo.dev}:${declarationInfo.ino}`]), ids = new Set(), inputs = [];
  let total = 0;
  async function input(file, sha256, role) {
    assert(text(file) && digest(sha256), 'Input file and SHA256 hash required');
    assert(text(role) && Object.hasOwn(limits, role), 'Supported input role required');
    const path = resolve(dirname(declarationPath), file), info = await regular(path);
    assert(info.size > 0 && info.size <= limits[role], `${role} file limit exceeded`);
    assert(outside(output, path), 'Output aliases readonly input');
    const identity = `${info.dev}:${info.ino}`;
    assert(!inodes.has(identity), 'Readonly input alias (including hardlink)'); inodes.add(identity);
    total += info.size; assert(total <= 512 * MiB, 'Total input exceeds 512 MiB');
    const value = { path, sha256, role, bytes: info.size, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs };
    inputs.push(value); return value;
  }
  const samples = [];
  for (const sample of declaration.samples) {
    assert(typeof sample.id === 'string' && /^[a-z0-9-]{1,80}$/.test(sample.id) && !ids.has(sample.id), 'Unique sample id required'); ids.add(sample.id);
    assert(['synthetic', 'cached-public', 'live-public'].includes(sample.kind), 'Explicit sample kind required');
    assert(['html', 'github', 'arxiv', 'bundle'].includes(sample.format), 'Supported sample format required');
    const response = primaryResponses[sample.format];
    if (sample.accept !== undefined) {
      assert(headerValue(sample.accept) && sample.accept === response.accept, 'Primary response Accept must match the declared format');
    }
    if (sample.mediaType !== undefined) {
      assert(headerValue(sample.mediaType) && response.mediaTypes.includes(sample.mediaType.split(';')[0].trim().toLowerCase()), 'Primary response media type must match the declared format');
    }
    sourceUrl(sample.url);
    if (sample.responseUrl !== undefined) sourceUrl(sample.responseUrl);
    assert(text(sample.version), 'Fixed source version required');
    assert(text(sample.capturedAt) && /^\d{4}-\d{2}-\d{2}T/.test(sample.capturedAt) && Number.isFinite(Date.parse(sample.capturedAt)), 'Actual collection time required');
    assert(text(sample.expected?.scope) && Array.isArray(sample.expected?.contains) && sample.expected.contains.every(text), 'Expected scope and content required');
    assert(Array.isArray(sample.unverified) && sample.unverified.every(text), 'Unverified boundaries required');
    assert(Array.isArray(sample.resources) && sample.resources.length <= 256, 'At most 256 declared resources');
    const primary = await input(sample.file, sample.sha256, { html: 'html', github: 'json', arxiv: 'text', bundle: 'bundle' }[sample.format]);
    if (sample.format === 'github') assert(primary.bytes <= MiB, 'GitHub repository file limit exceeded');
    const resources = []; let sampleBytes = primary.bytes; const origins = new Set([new URL(sample.url).origin]);
    for (const resource of sample.resources) {
      sourceUrl(resource.url); assert(text(resource.mediaType), 'Resource media type required');
      const resourceInput = await input(resource.file, resource.sha256, resource.role);
      if (sample.format === 'github' && new URL(resource.url).hostname === 'api.github.com') {
        const responseLimits = { 'application/vnd.github+json': 2 * MiB, 'application/vnd.github.raw+json': MiB, 'application/vnd.github.sha': MiB, 'application/vnd.github.html+json': 8 * MiB };
        assert(text(resource.accept) && Object.hasOwn(responseLimits, resource.accept), 'Explicit supported GitHub response Accept required');
        assert(resourceInput.bytes <= responseLimits[resource.accept], 'GitHub response file limit exceeded');
      }
      if (resource.accept !== undefined) assert(headerValue(resource.accept), 'Resource response Accept must be a scalar HTTP header');
      resources.push({ ...resource, input: resourceInput }); sampleBytes += resourceInput.bytes; origins.add(new URL(resource.url).origin);
    }
    if (['html', 'github'].includes(sample.format)) assert(sample.resources.length + 1 <= 256 && sampleBytes <= 64 * MiB && origins.size <= 16, 'Capture file/total/origin limit exceeded');
    samples.push({ ...sample, input: primary, resources });
  }
  // Sequential streaming hashes; never retain all declared inputs in memory.
  for (const value of inputs) for await (const _ of verifiedInput(value)) {}
  let upgradeBaselineId;
  if (requireUpgradeBaseline) {
    assert(samples.some(sample => sample.format === 'bundle'), 'Declare a released PDF bundle for the S3 upgrade baseline');
    const { createArchiveFileSource, validateBundle } = await import('@pagelingo/document-bundle');
    const { defaultBundleLimits } = await import('@pagelingo/document-contracts');
    for (const sample of samples.filter(value => value.format === 'bundle')) {
      const validated = await validateBundle(createArchiveFileSource(sample.input.path, defaultBundleLimits), { limits: defaultBundleLimits });
      sample.bundle = { packageId: validated.packageId, manifestSha256: validated.manifestSha256, renderer: validated.manifest.renderer };
      if (['0.1.0', '0.2.0'].includes(validated.manifest.renderer.version)) upgradeBaselineId ??= sample.id;
    }
    assert(upgradeBaselineId, 'Upgrade baseline requires a validated released PDF renderer 0.1.0 or 0.2.0 bundle');
  }
  return { schemaVersion: declaration.schemaVersion, declarationPath, output, samples, totalBytes: total, upgradeBaselineId };
}
