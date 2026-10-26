import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { glossaryKey, mergeGlossaryEntries, parseGlossaryFile } from '@pagelingo/translation-core';

const sourceKey = value => value.trim().toLowerCase();
const spellingKey = value => sourceKey(value).normalize('NFKC').replace(/[\s_\-‐‑–—]/gu, '');
const reviewed = new Map([
  ['pca', { target: '主成分分析', policy: 'keep', note: '修正原表 PCA → PAC；缩写保留英文。' }],
  ['actor-critic algorithm', { target: 'Actor-Critic 算法', policy: 'keep', note: '沿用 Actor-Critic 英文保留策略，避免长词组引入演员/评论员译法。' }],
  ['actor-critic method', { target: 'Actor-Critic 方法', policy: 'keep', note: '沿用 Actor-Critic 英文保留策略，避免长词组引入演员/评论员译法。' }],
]);

/** Prefer curated sources across domains; import additional ML terms and explicit spelling aliases. */
export function mergeTechGlossary(preferred, incoming) {
  const ours = mergeGlossaryEntries([], preferred);
  const external = mergeGlossaryEntries([], incoming);
  const exact = new Set(ours.map(entry => sourceKey(entry.source)));
  const spellings = new Map();
  for (const entry of ours) {
    const key = spellingKey(entry.source);
    spellings.set(key, [...(spellings.get(key) ?? []), entry]);
  }
  const records = [];
  let skippedExact = 0;
  for (const entry of external) {
    if (exact.has(sourceKey(entry.source))) { skippedExact++; continue; }
    const aliases = spellings.get(spellingKey(entry.source));
    if (aliases) {
      for (const preferred of aliases) records.push({
        entry: { ...preferred, source: entry.source }, origin: 'pagelingo-alias',
        canonicalSource: preferred.source, notes: `沿用 ${preferred.source} 的领域、译法和策略。`,
      });
      continue;
    }
    const correction = reviewed.get(sourceKey(entry.source));
    records.push({
      entry: {
        source: entry.source, target: correction?.target ?? entry.target,
        policy: correction?.policy ?? (sourceKey(entry.source) === sourceKey(entry.target) ? 'keep' : 'translate'),
        domain: 'machine-learning',
      },
      origin: correction ? 'reviewed-hjfy' : 'hjfy', canonicalSource: '',
      notes: correction?.note ?? 'HJFY 补充词条，仅用于机器学习领域；未模拟原 case 字段。',
    });
  }
  records.push(...ours.map(entry => ({ entry, origin: 'pagelingo', canonicalSource: entry.source, notes: '保留 PageLingo 参考词表的领域、译法和策略。' })));
  const entries = mergeGlossaryEntries([], records.map(record => record.entry));
  const metadata = new Map(records.map(record => [glossaryKey(record.entry), record]));
  return { entries, records: entries.map(entry => metadata.get(glossaryKey(entry))), skippedExact };
}

export function mergedGlossaryCsv(records) {
  const quote = value => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const rows = [['source', 'target', 'policy', 'domain', 'origin', 'canonical_source', 'notes'],
    ...records.map(({ entry, origin, canonicalSource, notes }) => [entry.source, entry.target, entry.policy, entry.domain, origin, canonicalSource, notes])];
  return '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

async function main() {
  const { values } = parseArgs({ options: {
    hjfy: { type: 'string' }, preferred: { type: 'string' }, 'out-dir': { type: 'string' },
    check: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    process.stdout.write('Usage: npm run glossary:merge -- --hjfy <MachineLearningTerminology.csv> [--preferred <glossary.json>] [--out-dir <directory>] [--check]\n');
    return;
  }
  if (!values.hjfy) throw new Error('请通过 --hjfy 提供本机 HJFY 术语 CSV；不会下载外部数据。');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const preferredPath = path.resolve(values.preferred ?? path.join(root, 'docs/glossaries/common-tech.en-zh.json'));
  const incomingPath = path.resolve(values.hjfy);
  const output = path.resolve(values['out-dir'] ?? path.join(root, 'docs/glossaries'));
  const [preferredText, incomingText] = await Promise.all([readFile(preferredPath, 'utf8'), readFile(incomingPath, 'utf8')]);
  const preferred = parseGlossaryFile(preferredText, 'json');
  const incoming = parseGlossaryFile(incomingText, 'csv');
  const merged = mergeTechGlossary(preferred, incoming);
  const count = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
  const sha256 = text => createHash('sha256').update(text).digest('hex');
  const json = JSON.stringify(merged.entries, null, 2) + '\n';
  const csv = mergedGlossaryCsv(merged.records);
  const manifest = {
    formatVersion: 1,
    inputs: {
      preferred: { file: path.basename(preferredPath), sha256: sha256(preferredText), entries: preferred.length },
      hjfy: { file: path.basename(incomingPath), sha256: sha256(incomingText), entries: incoming.length },
    },
    entries: merged.entries.length, distinctSources: new Set(merged.entries.map(entry => sourceKey(entry.source))).size,
    skippedExactHjfySources: merged.skippedExact,
    origins: count(merged.records.map(record => record.origin)),
    policies: count(merged.entries.map(entry => entry.policy)), domains: count(merged.entries.map(entry => entry.domain)),
    reviewedCorrections: merged.records.filter(record => record.origin === 'reviewed-hjfy').map(record => ({ ...record.entry, reason: record.notes })),
    rules: [
      'Existing PageLingo sources take precedence across all domains; their original domains and policies are retained.',
      'Whitespace/hyphen spelling aliases inherit the matching PageLingo policy and domain.',
      'Additional HJFY terms are scoped to machine-learning; unchanged English targets use keep.',
      'HJFY case flags are not reproduced; PageLingo matching remains case-insensitive.',
      'Accuracy and precision preferences are maintained in the preferred reference glossary.',
    ],
    outputSha256: { json: sha256(json), csv: sha256(csv) },
  };
  // Validate both complete exports before writing any files.
  if (JSON.stringify(parseGlossaryFile(csv, 'csv')) !== JSON.stringify(parseGlossaryFile(json, 'json'))) {
    throw new Error('CSV 和 JSON 输出不一致。');
  }
  const files = new Map([
    ['merged-tech.en-zh.json', json], ['merged-tech.en-zh.csv', csv],
    ['merged-tech.en-zh.manifest.json', JSON.stringify(manifest, null, 2) + '\n'],
  ]);
  if (!values.check) await mkdir(output, { recursive: true });
  for (const [name, content] of files) {
    const target = path.join(output, name);
    if (values.check) {
      if (await readFile(target, 'utf8') !== content) throw new Error(`融合词表需要更新：${name}`);
    } else await writeFile(target, content, 'utf8');
  }
  process.stdout.write(`${values.check ? 'Verified' : 'Generated'} ${merged.entries.length} entries in ${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
