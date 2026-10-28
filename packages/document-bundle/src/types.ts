import type {
  BundleFile,
  BundleLimits,
  DocumentBundleManifest,
  ReaderIR,
  ReaderTranslation,
} from '@pagelingo/document-contracts';
import type { ReaderBuild } from '@pagelingo/document-renderer';
export type { BundleLimits };
export interface FileInfo {
  path: string;
  bytes: number;
}
/** list/read may be called repeatedly. Each read must open a fresh, bounded stream. */
export interface BundleFileSource {
  list(): Promise<FileInfo[]>;
  read(path: string): AsyncIterable<Uint8Array>;
}
export interface ArchiveEntry extends FileInfo {
  content: AsyncIterable<Uint8Array>;
}
export interface BundleOptions {
  limits: BundleLimits;
  signal?: AbortSignal;
}
export interface BundleIdentity {
  packageId: string;
  manifestSha256: string;
}
export interface ValidatedBundle extends BundleIdentity {
  manifest: DocumentBundleManifest;
  ir: ReaderIR;
  translation: ReaderTranslation;
  readerBuild: ReaderBuild;
  files: readonly BundleFile[];
}

export interface ValidatedWebBundle extends BundleIdentity {
  manifest: import('@pagelingo/document-contracts').WebDocumentBundleManifest;
  source: import('@pagelingo/document-contracts').WebCaptureManifest;
  ir: import('@pagelingo/document-contracts').WebReaderIR;
  translation: import('@pagelingo/document-contracts').WebTranslation | null;
  readerBuild: import('@pagelingo/document-renderer').WebReaderBuild;
  files: readonly BundleFile[];
}
