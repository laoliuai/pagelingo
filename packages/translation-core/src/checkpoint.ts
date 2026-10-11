import type { CacheEntry, TranslationCache, ProviderIdentity } from './cache.js';
import type { BudgetOptions } from './budget.js';
import type { ConcurrencyScheduler } from './concurrency.js';
import type { TranslationMetrics } from './types.js';

export interface UnitState {
  id: string; key: string; status: 'pending' | 'inflight' | 'completed' | 'failed' | 'cancelled';
  attempt: number; text?: string; error?: string; retryAt?: number; source?: 'network' | 'cache';
}
export interface TranslationCheckpoint {
  version: 1; fingerprint: string; units: UnitState[];
  blocks: Record<string, { text: string; source: 'network' | 'cache' | 'recovered' }>;
  metrics: TranslationMetrics;
  /** Endpoint cooldown, retained when a worker resumes this checkpoint. */
  nextRequestAt?: number;
}
export interface TranslationStateStore {
  load(): Promise<TranslationCheckpoint | undefined>;
  /** Implementations may atomically persist completed units and cache entries. */
  save(checkpoint: TranslationCheckpoint, cacheWrites: CacheEntry[]): Promise<void>;
}
/** A fenced/obsolete job must stop rather than degrade to memory-only execution. */
export class CheckpointConflictError extends Error { readonly name = 'CheckpointConflictError'; }
export interface ReliabilityOptions {
  identity: ProviderIdentity; budget: BudgetOptions; cache?: TranslationCache;
  state?: TranslationStateStore; scheduler?: ConcurrencyScheduler;
  maxRetries?: number; backoffMs?: number; dependencies?: unknown;
}
