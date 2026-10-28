import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';

export async function cleanupRestartAcceptance({ archiveHashes, started, compose, project, ownedFixture, directory }) {
  for (const [path, before] of archiveHashes) {
    try {
      const after = createHash('sha256').update(await readFile(path)).digest('hex');
      console.log(JSON.stringify({ archive: path, before, after, unchanged: before === after }));
      if (before !== after) process.exitCode ||= 1;
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({ archive: path, before, after: null, unchanged: false, error: diagnostic }));
      console.error(`Failed to verify original restart input: ${diagnostic}`);
      process.exitCode ||= 1;
    }
  }
  if (started) {
    try { await compose(['down', '--volumes', '--remove-orphans', '--rmi', 'local']); }
    catch { console.error('Failed to clean isolated restart project: ' + project); process.exitCode ||= 1; }
  }
  for (const path of [ownedFixture?.root, directory].filter(Boolean)) {
    try { await rm(path, { recursive: true, force: true }); }
    catch (error) {
      console.error(`Failed to clean owned restart directory ${path}: ${error.message}`);
      process.exitCode ||= 1;
    }
  }
}
