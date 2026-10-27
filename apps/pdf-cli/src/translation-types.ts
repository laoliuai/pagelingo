import type { GenerationKind, ReaderTranslation } from '@pagelingo/document-contracts';
import type { BudgetOptions, TranslationProfile, GlossaryEntry, TranslationProvider } from '@pagelingo/translation-core';
import type { LocalProviderConfig } from './safe-config.js';
import type { AtomicWrite } from './file-checkpoints.js';
export interface TranslateRunOptions {
  runDir: string;
  selection: 'auto' | 'all' | 'none';
  sourceLanguage?: string;
  provider: LocalProviderConfig;
  resume: boolean;
  newJob: boolean;
  targetLanguage?: string;
  profile?: TranslationProfile;
  budget?: Partial<BudgetOptions>;
  glossary?: GlossaryEntry[];
  glossaryDomain?: GlossaryEntry['domain'];
  maxRetries?: number;
  backoffMs?: number;
}
export interface TranslationDependencies {
  provider?: TranslationProvider;
  generationKind?: Exclude<GenerationKind, 'none'>;
  signal?: AbortSignal;
  checkpointWrite?: AtomicWrite;
}
export interface LocalTranslationJob {
  schemaVersion: 'pagelingo-local-translation-job/1';
  jobId: string;
  configSha256: string;
  readerIrSha256: string;
  sourceSha256: string;
  parseId: string;
  selection: TranslateRunOptions['selection'];
  selectionBlockIds: string[];
  sourceLanguage: string | null;
  targetLanguage: string;
  profile: TranslationProfile;
  budget: BudgetOptions;
  glossary: GlossaryEntry[];
  glossaryDomain: GlossaryEntry['domain'];
  maxRetries: number;
  backoffMs: number;
  provider: ReaderTranslation['provider'];
  generationKind: Exclude<GenerationKind, 'none'>;
}
export interface LocalTranslationResult {
  job: LocalTranslationJob;
  snapshot: ReaderTranslation;
  /** Paths relative to the existing processing run directory. */
  jobPath: string;
  checkpointPath: string;
  snapshotPath: string;
  snapshotSha256: string;
  warnings: string[];
}
