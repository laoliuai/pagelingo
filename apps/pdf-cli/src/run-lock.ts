import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { CheckpointConflictError } from '@pagelingo/translation-core';
import { serializeBundleJson } from '@pagelingo/document-bundle';
import { atomicWrite, privateDirectory, readJson } from './file-checkpoints.js';
import { LocalTranslationError } from './safe-config.js';
export interface RunLock { epoch: string; assertCurrent(): Promise<void>; release(): Promise<void> }
/** The parent owns the shared open-file description after short-lived flock exits. */
export async function acquireRunLock(runDir: string): Promise<RunLock> {
  if (process.platform !== 'linux') throw new LocalTranslationError('TRANSLATION_PLATFORM_UNSUPPORTED');
  const directory = join(runDir, 'translation'); await privateDirectory(directory);
  const file = await open(join(directory, 'writer.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'],
        { env: {}, stdio: ['ignore', 'ignore', 'ignore', file.fd] });
      child.once('error', () => reject(new LocalTranslationError('TRANSLATION_LOCK_UNAVAILABLE')));
      child.once('exit', resolve);
    });
    if (code !== 0) throw new LocalTranslationError(code === 73 ? 'TRANSLATION_BUSY' : 'TRANSLATION_LOCK_UNAVAILABLE');
    const epoch = randomUUID(); const epochPath = join(directory, 'epoch.json');
    try { await atomicWrite(epochPath, serializeBundleJson(epoch)); }
    catch { throw new CheckpointConflictError('TRANSLATION_DISK_WRITE_FAILED'); }
    let active = true;
    return { epoch,
      async assertCurrent() {
        try { if (!active || await readJson(epochPath) !== epoch) throw new Error(); }
        catch { throw new CheckpointConflictError('TRANSLATION_EPOCH_CONFLICT'); }
      },
      async release() { if (active) { active = false; await file.close(); } },
    };
  } catch (error) { await file.close(); throw error; }
}
