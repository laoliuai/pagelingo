import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { RuntimeConfig } from '../../src/config.js';
import type { Database } from '../../src/db/database.js';
export interface WorkerMessage { type: string; documentId?: string; units?: string[]; pid: number; url?: string }
export async function startWorker(t: { db: Database; config: RuntimeConfig }, options: { delay?: number; rateLimit?: boolean; holdPublication?: boolean; publicationControl?: boolean; fetchDelay?: number; github?: boolean; arxiv?: boolean; arxivLatest?: number; arxivHoldPdf?: boolean } = {}) {
  const schema = (await t.db.pool.query('SELECT current_schema() AS schema')).rows[0].schema;
  const child = spawn(process.execPath, ['--import','tsx',new URL('./mock-worker-process.ts',import.meta.url).pathname,schema], {
    env: { PATH: process.env.PATH, PAGELINGO_SITE_MODE: 'test', PAGELINGO_SITE_ORIGIN: t.config.publicOrigin, PAGELINGO_DATA_DIR: t.config.dataDir,
      DATABASE_URL: t.config.databaseUrl, PAGELINGO_MASTER_KEY_ID: 'test', PAGELINGO_MASTER_KEYS_JSON: JSON.stringify({ test: Buffer.alloc(32,9).toString('base64') }),
      TEST_WORKER_ARXIV_HOLD_PDF: options.arxivHoldPdf ? '1' : '0', TEST_WORKER_ARXIV_FIXTURES: options.arxiv ? '1' : '0', TEST_WORKER_ARXIV_LATEST: String(options.arxivLatest ?? 1),
      TEST_WORKER_GITHUB_FIXTURES: options.github ? '1' : '0', TEST_WORKER_LINK_FIXTURES: options.fetchDelay === undefined ? '0' : '1', TEST_WORKER_FETCH_DELAY: String(options.fetchDelay ?? 0),
      TEST_WORKER_PUBLICATION_CONTROL: options.publicationControl ? '1' : '0', TEST_WORKER_HOLD_PUBLICATION: options.holdPublication ? '1' : '0', TEST_WORKER_DELAY: String(options.delay ?? 0), TEST_WORKER_429: options.rateLimit ? '1' : '0' },
    stdio: ['ignore','pipe','pipe','ipc'],
  });
  const messages: WorkerMessage[] = []; let output = '';
  child.on('message', value => messages.push(value as WorkerMessage));
  child.stdout!.on('data', value => { output+=value; }); child.stderr!.on('data', value => { output+=value; });
  async function stop(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child,'exit'); child.kill(signal); await exited;
  }
  return { child, messages, stop, output: () => output };
}
