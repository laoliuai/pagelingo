import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultBundleLimits } from '@pagelingo/document-contracts';
import { createArchiveFileSource, validateBundle } from '@pagelingo/document-bundle';

function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    assert(['--input', '--output'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--') && !options[key.slice(2)], 'Usage: check-s2-compat.mjs --input <file-or-dir> --output <new-dir>');
    options[key.slice(2)] = args[i + 1];
  }
  assert(options.input && options.output, 'Usage: check-s2-compat.mjs --input <file-or-dir> --output <new-dir>');
  return options;
}
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}
async function findArchives(path) {
  const info = await lstat(path);
  assert(!info.isSymbolicLink(), 'Symlink inputs are not supported');
  if (info.isFile()) return /\.zip$/i.test(path) ? [path] : [];
  assert(info.isDirectory(), 'Input must be a file or directory');
  const paths = [];
  for (const entry of (await readdir(path)).sort()) paths.push(...await findArchives(join(path, entry)));
  return paths;
}
function outside(root, path) {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}

/** Validate original archives in place; no parsing, model calls, rewriting or extraction. */
export async function checkS2Compat(options) {
  const input = await realpath(resolve(options.input));
  const inputInfo = await lstat(input);
  const requestedOutput = resolve(options.output);
  const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  assert(inputInfo.isFile() || inputInfo.isDirectory(), 'Input must be a file or directory');
  assert(inputInfo.isDirectory() ? outside(input, output) : output !== input, 'Output must be outside original inputs');
  const archives = await findArchives(input);
  assert(archives.length > 0, 'No ZIP archives found');
  // Non-recursive mkdir guarantees even an empty existing output is never reused.
  await mkdir(output, { mode: 0o700 });
  const report = { schemaVersion: 'pagelingo-s2-compat/1', status: 'running', samples: [] };
  const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  try {
    for (const path of archives) {
      const sample = { input: path, status: 'running', archiveBytes: (await lstat(path)).size,
        archiveSha256Before: await fileHash(path) };
      report.samples.push(sample);
      await save();
      try {
        const validated = await validateBundle(createArchiveFileSource(path, defaultBundleLimits), { limits: defaultBundleLimits });
        Object.assign(sample, {
          status: 'passed', packageId: validated.packageId, manifestSha256: validated.manifestSha256,
          renderer: validated.manifest.renderer, sourceSha256: validated.ir.source.sha256,
          readerIrSha256: validated.manifest.readerIrSha256, translationSha256: validated.manifest.translation.sha256,
          files: validated.files.length + 1, chunks: validated.readerBuild.chunks.length,
        });
      } catch (error) {
        sample.status = 'failed'; sample.error = error.message;
        throw error;
      } finally {
        sample.archiveSha256After = await fileHash(path);
        if (sample.archiveSha256After !== sample.archiveSha256Before) {
          sample.status = 'failed'; sample.error = 'Original archive changed during validation';
        }
        await save();
        assert.equal(sample.archiveSha256After, sample.archiveSha256Before, 'Original archive changed during validation');
      }
    }
    report.status = 'passed';
    await save();
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    await save();
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await checkS2Compat(parseArguments(process.argv.slice(2)));
    console.log(`S2 compatibility passed: ${report.samples.length} original ZIP archives`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
