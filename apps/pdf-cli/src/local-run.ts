import type { PdfPageMetadata, ReaderIR } from '@pagelingo/document-contracts';
import type { ParserConfig } from '@pagelingo/document-bundle';
export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}
export interface VerifiedFiles {
  root: string;
  manifestBytes: Buffer;
  files: Map<string, ManifestEntry>;
}
export interface P0Metadata {
  schemaVersion: string;
  runId: string;
  parser: string;
  input: string;
  sourceSha256: string;
  sourcePageCount: number;
  requestedPageIndices: number[];
  coverage: string;
  status: 'complete' | 'partial';
  modelLockSha256?: string | null;
  pythonLockSha256?: string | null;
  worker: {
    config: Record<string, unknown>;
    versions?: Record<string, string>;
  };
  [key: string]: unknown;
}
export interface RawBlock {
  index: number;
  type: string;
  bbox?: number[];
  content?: unknown;
}
export interface RawDocument {
  pages: { page_idx: number; blocks: RawBlock[] }[];
}
export interface VerifiedP0Run extends VerifiedFiles {
  metadata: P0Metadata;
  raw: RawDocument;
  parsedPageIndices: number[];
  config: ParserConfig;
  configBytes: Uint8Array;
  sourceBytes: number;
}
export interface EvidenceBlock {
  id: string;
  blockIndex: number;
  bbox: number[];
  ambiguousCharacterRanges?: unknown[];
}
export interface EvidencePage {
  sourcePageIndex: number;
  parsedPageIndex: number;
  width: number;
  height: number;
  cropBox: number[];
  rotation: number;
  blocks: EvidenceBlock[];
}
export interface SourceLayout {
  sourceRunId: string;
  sourceSha256: string;
  coordinateSpace: string;
  pages: EvidencePage[];
}
export interface PreviewPage {
  path: string;
  sourcePageIndex: number;
  parsedPageIndex: number;
}
export interface PreviewMetadata {
  schemaVersion: string;
  sourceRunId: string;
  sourceSha256: string;
  sourceManifestSha256: string;
  sourceStatus: string;
  coverage: string;
  sourcePageCount: number;
  requestedPageIndices: number[];
  translated: boolean;
  pages: PreviewPage[];
  originalVisuals: { path: string; [key: string]: unknown }[];
  [key: string]: unknown;
}
export interface SourceBinding {
  blockId: string;
  semanticFile: string;
  semanticPointer: string;
  sourceId?: string;
  rawRef?: string;
  evidencePointer?: string;
  precision: 'page' | 'bbox';
  warning?: string;
}
export interface VerifiedPreview extends VerifiedFiles {
  metadata: PreviewMetadata;
  layout: SourceLayout;
  bindings: SourceBinding[];
  assetFiles: Map<string, string>;
}
export interface PdfInspection {
  schemaVersion: 'pagelingo-pdf-inspection/1';
  sourceSha256: string;
  pages: PdfPageMetadata[];
  warnings: string[];
}
export interface ProcessOptions {
  sourcePath: string;
  runDir: string;
  pythonPath?: string;
  p0RunDir?: string;
  previewDir?: string;
  katexDir?: string;
  modelDir?: string;
  pages?: string;
}
export interface PythonRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
}
export interface PythonResult {
  exitCode: number;
  stdout: string;
}
export interface ProcessDependencies {
  runPython?: (request: PythonRequest) => Promise<PythonResult>;
  inspectPdf?: (
    sourcePath: string,
    request: PythonRequest,
  ) => Promise<PdfInspection>;
  signal?: AbortSignal;
}
export interface LocalRun {
  schemaVersion: 'pagelingo-local-run/1';
  workflowId: string;
  status: 'processing' | 'complete' | 'partial' | 'failed' | 'cancelled';
  sourceSha256: string;
  configSha256?: string;
  readerIrSha256?: string;
  parseId?: string;
  translationStatus: 'pending' | 'not-required';
  paths: {
    source: string;
    ir: string;
    provenance: string;
    assets: string;
    inspection: string;
    parser: string | null;
    preview: string | null;
  };
  stage: string;
  failure?: string;
  exportReady: boolean;
  exportBlockers: string[];
}
export type TextBlock = Extract<ReaderIR['blocks'][number], { type: 'text' }>;
