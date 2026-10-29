import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink, link, truncate, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { preflight } from '../../scripts/site-s4-inputs.mjs';
const hash = data => createHash('sha256').update(data).digest('hex');
const run = args => spawnSync(process.execPath, ['scripts/check-site-s4.mjs', ...args], { encoding: 'utf8', env: { PATH: '/nonexistent', DATABASE_URL: 'must-not-use', PAGELINGO_TEST_DATABASE_URL: 'must-not-use' } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pgl-s4-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = '<article>Declared original.</article>';
  await writeFile(join(root, 'source.html'), body);
  const sample = { id: 'one', kind: 'synthetic', format: 'html', url: 'https://example.com/article', version: 'fixture-v1', file: 'source.html', sha256: hash(body), capturedAt: '2026-10-29T00:00:00Z', expected: { scope: 'article', contains: ['Declared original.'] }, unverified: ['Real source'], resources: [] };
  const declaration = { schemaVersion: 'pagelingo-site-s4-samples/1', samples: [sample] };
  const path = join(root, 'samples.json'), output = join(root, 'output');
  const save = () => writeFile(path, JSON.stringify(declaration));
  await save();
  return { root, path, output, sample, declaration, save };
}
test('requires explicit declaration and output without starting a service', () => {
  const result = run([]); assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/);
});
for (const [name, mutate, message] of [
  ['array hash', f => { f.sample.sha256 = [f.sample.sha256]; }, /SHA256 hash required/],
  ['missing sample id', f => { delete f.sample.id; }, /Unique sample id/],
  ['null sample id', f => { f.sample.id = null; }, /Unique sample id/],
  ['numeric sample id', f => { f.sample.id = 123; }, /Unique sample id/],
  ['empty samples', f => { f.declaration.samples = []; }, /1.*32/],
  ['too many samples', f => { f.declaration.samples = Array.from({ length: 33 }, (_, i) => ({ ...f.sample, id: `s${i}` })); }, /1.*32/],
  ['unclassified material', f => { f.sample.kind = 'real'; }, /kind/],
  ['missing version', f => { delete f.sample.version; }, /version/],
  ['missing scope', f => { delete f.sample.expected.scope; }, /scope/],
  ['too many resources', f => { f.sample.resources = Array(257).fill({}); }, /256/],
  ['hash mismatch', f => { f.sample.sha256 = 'a'.repeat(64); }, /hash/],
  ['credentialed URL', f => { f.sample.url = 'https://name:password@example.com/'; }, /URL/],
]) test(`rejects ${name} before output or provisioning`, async t => {
  const f = await fixture(t); mutate(f); await f.save();
  const result = run(['--samples', f.path, '--output', f.output]);
  assert.equal(result.status, 1); assert.match(result.stderr, message);
  assert.equal(await stat(f.output).catch(() => null), null);
});
test('rejects oversized and invalid UTF-8 declarations before JSON reading', async t => {
  const f = await fixture(t);
  await truncate(f.path, 1024 * 1024 + 1);
  assert.match(run(['--samples', f.path, '--output', f.output]).stderr, /1 MiB/);
  await writeFile(f.path, Buffer.from([0xff]));
  assert.match(run(['--samples', f.path, '--output', f.output]).stderr, /UTF-8/);
});
test('rejects oversized HTML, directory and symlink inputs before output', async t => {
  const f = await fixture(t);
  await truncate(join(f.root, 'source.html'), 8 * 1024 * 1024 + 1);
  assert.match(run(['--samples', f.path, '--output', f.output]).stderr, /file limit/);
  f.sample.file = '.'; await f.save();
  assert.match(run(['--samples', f.path, '--output', f.output]).stderr, /regular file/);
  await symlink('source.html', join(f.root, 'alias')); f.sample.file = 'alias'; await f.save();
  assert.match(run(['--samples', f.path, '--output', f.output]).stderr, /symlink/);
  assert.equal(await stat(f.output).catch(() => null), null);
});
test('refuses existing outputs and readonly input aliases including hardlinks', async t => {
  const f = await fixture(t); await mkdir(f.output);
  assert.match(run(['--samples', f.path, '--output', f.output]).stderr, /new directory/);
  await link(join(f.root, 'source.html'), join(f.root, 'hardlink'));
  f.sample.resources = [{ file: 'hardlink', sha256: f.sample.sha256, role: 'html', url: 'https://example.com/resource', mediaType: 'text/html' }]; await f.save();
  assert.match(run(['--samples', f.path, '--output', join(f.root, 'new')]).stderr, /alias/);
});
test('accepts valid preflight without loading a database and streams verified input bytes', async t => {
  const { preflight, verifiedInput } = await import('../../scripts/site-s4-inputs.mjs');
  const f = await fixture(t), plan = await preflight(f.path, f.output);
  assert.equal(plan.samples.length, 1); assert.equal(await stat(f.output).catch(() => null), null);
  const chunks = []; for await (const bytes of verifiedInput(plan.samples[0].input)) chunks.push(bytes);
  assert.equal(Buffer.concat(chunks).toString(), '<article>Declared original.</article>');
  await writeFile(join(f.root, 'source.html'), 'changed after admission');
  await assert.rejects(async () => { for await (const _ of verifiedInput(plan.samples[0].input)) {} }, /changed|hash/);
});
test('rejects aggregate input budget from stat before reading sparse oversized totals', async t => {
  const f=await fixture(t); f.declaration.samples=[];
  for(let i=0;i<3;i++) {
    const file=`large-${i}.zip`; await writeFile(join(f.root,file),''); await truncate(join(f.root,file),256*1024*1024);
    f.declaration.samples.push({...f.sample,id:`large-${i}`,format:'bundle',file,sha256:'a'.repeat(64)});
  }
  await f.save(); const result=run(['--samples',f.path,'--output',f.output]);
  assert.equal(result.status,1); assert.match(result.stderr,/512 MiB/); assert.equal(await stat(f.output).catch(()=>null),null);
});
test('requires a declared upgrade baseline before creating output or provisioning', async t => {
  const f=await fixture(t);const result=run(['--samples',f.path,'--output',f.output]);
  assert.equal(result.status,1);assert.match(result.stderr,/upgrade baseline/);assert.equal(await stat(f.output).catch(()=>null),null);
});
test('does not trust a caller bundle label without actual released package validation', async t => {
  const f=await fixture(t);f.sample.format='bundle';await f.save();
  const result=run(['--samples',f.path,'--output',f.output]);
  assert.equal(result.status,1);assert.match(result.stderr,/BUNDLE|archive|ZIP/i);assert.equal(await stat(f.output).catch(()=>null),null);
});

for (const mode of ['repository', 'descriptor', 'raw', 'rendered', 'github-total']) test(`enforces existing GitHub ${mode} limit before hashing or output`, async t => {
  const root=await mkdtemp(join(tmpdir(),'pgl-s4-source-limit-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sample={id:'github',kind:'synthetic',format:'github',url:'https://github.com/Org/Repo',version:'fixture-v1',file:'repository.json',sha256:'a'.repeat(64),capturedAt:'2026-10-29T00:00:00Z',expected:{scope:'Explicit synthetic repository',contains:[]},unverified:[],resources:[]};
  await writeFile(join(root,sample.file),'{}');
  if(mode==='repository')await truncate(join(root,sample.file),1024*1024+1);
  if(['descriptor', 'raw', 'rendered'].includes(mode)){
    await writeFile(join(root,'descriptor.json'),'');await truncate(join(root,'descriptor.json'),({ descriptor: 2, raw: 1, rendered: 8 }[mode])*1024*1024+1);
    sample.resources.push({file:'descriptor.json',sha256:'a'.repeat(64),role:'json',mediaType:'application/json',url:'https://api.github.com/repos/Org/Repo/readme',accept:{ descriptor:'application/vnd.github+json', raw:'application/vnd.github.raw+json', rendered:'application/vnd.github.html+json' }[mode]});
  }
  if(mode==='github-total')for(let i=0;i<5;i++){
    const file=`image-${i}.png`;await writeFile(join(root,file),'');await truncate(join(root,file),16*1024*1024);
    sample.resources.push({file,sha256:'a'.repeat(64),role:'image',mediaType:'image/png',url:`https://raw.githubusercontent.com/Org/Repo/main/${file}`});
  }
  const declaration=join(root,'samples.json'),output=join(root,'output');await writeFile(declaration,JSON.stringify({schemaVersion:'pagelingo-site-s4-samples/1',samples:[sample]}));
  await assert.rejects(preflight(declaration,output),mode==='github-total'?/total.*limit/:/file limit/);
  assert.equal(await stat(output).catch(()=>null),null);
});

for (const field of ['role', 'accept']) test(`rejects array resource ${field} before output or provisioning`, async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'resource'), 'x');
  f.sample.format = 'github';
  const resource = { file: 'resource', sha256: hash('x'), role: 'text', mediaType: 'text/plain', url: 'https://api.github.com/repos/Org/Repo/readme', accept: 'application/vnd.github.raw+json' };
  resource[field] = [resource[field]];
  f.sample.resources = [resource]; await f.save();
  const result = run(['--samples', f.path, '--output', f.output]);
  assert.equal(result.status, 1); assert.match(result.stderr, field === 'role' ? /Supported input role/ : /supported GitHub response Accept/);
  assert.equal(await stat(f.output).catch(() => null), null);
});

const primaryMetadata = {
  html: { accept: 'text/html', mediaType: 'text/html; charset=utf-8' },
  github: { accept: 'application/vnd.github+json', mediaType: 'application/json; charset=utf-8' },
  arxiv: { accept: 'application/atom+xml', mediaType: 'application/atom+xml; charset=utf-8' },
  bundle: { accept: 'application/zip', mediaType: 'application/zip' },
};
async function withReleasedBaseline(t, format) {
  const f = await fixture(t);
  const directory = resolve('tests/fixtures/site-s4');
  const declared = JSON.parse(await readFile(join(directory, 'samples.json'), 'utf8')).samples;
  const baseline = declared.find(sample => sample.id === 'released-s2');
  f.declaration.samples.push({ ...baseline, file: resolve(directory, baseline.file) });
  Object.assign(f.sample, { format, ...primaryMetadata[format] });
  if (format === 'bundle') {
    const other = declared.find(sample => sample.id === 'released-s3');
    Object.assign(f.sample, { file: resolve(directory, other.file), sha256: other.sha256 });
  }
  await f.save();
  const admitted = await preflight(f.path, f.output, { requireUpgradeBaseline: true });
  assert(admitted.upgradeBaselineId);
  assert(admitted.samples.find(sample => sample.id === 'released-s2').bundle);
  return f;
}
for (const format of Object.keys(primaryMetadata)) {
  for (const field of ['accept', 'mediaType']) {
    for (const malformed of ['non-scalar', 'wrong-format']) {
      test(`rejects ${format} primary ${field} ${malformed} with a validated baseline before side effects`, async t => {
        const f = await withReleasedBaseline(t, format);
        f.sample[field] = malformed === 'wrong-format' ? 'image/png' : field === 'accept' ? [f.sample.accept] : {};
        await f.save();
        const expected = field === 'accept' ? /Primary response Accept/ : /Primary response media type/;
        // RED stops here: no malformed declaration ever launches the owned runner.
        await assert.rejects(preflight(f.path, f.output, { requireUpgradeBaseline: true }), expected);
        const result = run(['--samples', f.path, '--output', f.output]);
        assert.equal(result.status, 1); assert.match(result.stderr, expected);
        assert.equal(await stat(f.output).catch(() => null), null);
      });
    }
  }
}
for (const field of ['accept', 'mediaType']) {
  for (const malformed of ['', 'text/html\r\nX-Untrusted: value']) {
    test(`rejects invalid primary ${field} header ${JSON.stringify(malformed)} before side effects`, async t => {
      const f = await withReleasedBaseline(t, 'html');
      f.sample[field] = malformed; await f.save();
      const expected = field === 'accept' ? /Primary response Accept/ : /Primary response media type/;
      await assert.rejects(preflight(f.path, f.output, { requireUpgradeBaseline: true }), expected);
      const result = run(['--samples', f.path, '--output', f.output]);
      assert.equal(result.status, 1); assert.match(result.stderr, expected);
      assert.equal(await stat(f.output).catch(() => null), null);
    });
  }
}
test('rejects non-scalar optional resource Accept outside GitHub API before side effects', async t => {
  const f = await withReleasedBaseline(t, 'html');
  await writeFile(join(f.root, 'resource'), 'x');
  f.sample.resources = [{ file: 'resource', sha256: hash('x'), role: 'text', mediaType: 'text/plain', url: 'https://example.com/resource', accept: ['text/plain'] }];
  await f.save();
  await assert.rejects(preflight(f.path, f.output, { requireUpgradeBaseline: true }), /Resource response Accept/);
  const result = run(['--samples', f.path, '--output', f.output]);
  assert.equal(result.status, 1); assert.match(result.stderr, /Resource response Accept/);
  assert.equal(await stat(f.output).catch(() => null), null);
});
