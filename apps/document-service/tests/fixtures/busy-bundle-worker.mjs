import { workerData } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
// Owned adversarial CPU fixture: publish readiness/environment, then never yield.
writeFileSync(workerData.path, JSON.stringify({ env: process.env, inputs: Object.keys(workerData).sort() }));
while (true) { Math.sqrt(Math.random()); }
