import { createHash } from 'node:crypto';
import { createWebCaptureRequestSchema, defaultCaptureLimits, webCaptureManifestSchema, webCaptureTranslationCandidateSchema, type WebTranslation, type WebCaptureManifest, type WebDocumentBundleManifest } from '@pagelingo/document-contracts';
import { canonicalManifestBytes } from '@pagelingo/web-capture';
import { check } from './errors.js';
import { checkSize, parseBoundedJson } from './limits.js';
import { digestFile } from './file-reader.js';
import type { BundleFileSource, BundleLimits } from './types.js';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Original material is inert. Only this bounded closure reads it; never pass it to the renderer. */
export async function validateWebOriginals(input: BundleFileSource, manifest: WebDocumentBundleManifest, source: WebCaptureManifest, translation: WebTranslation | null, limits: BundleLimits, allowed: Set<string>, tick: () => void, signal?: AbortSignal) {
  if (!manifest.originals) return;
  const members = new Map(manifest.files.map(file => [file.path, file]));
  let total = 0;
  async function read(path: string, sha256: string, ceiling: number, mediaType: string, bytes?: number, collect = false, reuse = false) {
    const member = members.get(path);
    check(member, 'BUNDLE_MISSING_RESOURCE'); check(reuse ? allowed.has(path) : !allowed.has(path));
    check(member.role === 'provenance' && member.sha256 === sha256 && member.mediaType === mediaType && (bytes === undefined || bytes === member.bytes));
    checkSize(member.bytes, ceiling);
    let actualBytes = 0;
    const actual = await digestFile(input, member, limits, n => { tick(); actualBytes += n; total += n; checkSize(actualBytes, ceiling); checkSize(total, defaultCaptureLimits.maxTotalBytes); }, collect, signal);
    check(actual.sha256 === sha256); allowed.add(path);
    return actual.body;
  }
  if ('capture' in manifest.originals) {
    const groups = manifest.originals;
    async function captureGroup(declaration: typeof groups.capture, prefix: string, sharedSource?: WebCaptureManifest) {
      total = 0;
      const bytes = (await read(`${prefix}/manifest.json`, declaration.manifestSha256, defaultCaptureLimits.maxIrBytes, 'application/json', undefined, true))!;
      const original = webCaptureManifestSchema.parse(parseBoundedJson(bytes, limits.maxJsonDepth));
      check(hash(canonicalManifestBytes(original)) === declaration.manifestSha256);
      if (declaration.admissionKind === 'upload') {
        const requestBytes = (await read(`${prefix}/request.json`, declaration.requestSha256, defaultCaptureLimits.maxIrBytes, 'application/json', undefined, true))!;
        const request = createWebCaptureRequestSchema.parse(parseBoundedJson(requestBytes, limits.maxJsonDepth));
        check(hash(canonicalManifestBytes(request)) === declaration.requestSha256 && hash(canonicalManifestBytes(request.manifest)) === declaration.manifestSha256);
      } else check(declaration.requestSha256 === declaration.manifestSha256);
      const shared = new Map((sharedSource ? groups.readerCapture!.sharedFiles : []).map(file => [file.id, file.sourceFileId]));
      check(shared.size === (sharedSource ? groups.readerCapture!.sharedFiles.length : 0));
      check([...shared.keys()].every(id => original.files.some(file => file.id === id)));
      total = 0;
      let candidateBytes: Buffer | undefined;
      for (const file of original.files) {
        const sourceFile = shared.has(file.id) ? sharedSource?.files.find(sourceFile => sourceFile.id === shared.get(file.id)) : undefined;
        if (shared.has(file.id)) {
          check(sourceFile && sourceFile.sha256 === file.sha256 && sourceFile.bytes === file.bytes && sourceFile.mediaType === file.mediaType && sourceFile.role === file.role);
        }
        const path = sourceFile ? `originals/capture/files/${sourceFile.path}` : `${prefix}/files/${file.path}`;
        const candidate = file.id === original.existingTranslation?.fileId;
        const body = await read(path, file.sha256,
          file.role === 'html' ? defaultCaptureLimits.maxHtmlBytes : file.role === 'preview' ? defaultCaptureLimits.maxPreviewHtmlBytes : defaultCaptureLimits.maxResourceBytes,
          file.mediaType, file.bytes, candidate, !!sourceFile);
        if (candidate) candidateBytes = body;
      }
      return { original, candidateBytes };
    }
    const first = await captureGroup(groups.capture, 'originals/capture');
    check(first.original.captureId === source.captureId);
    let selected = first;
    if (groups.readerCapture) {
      check(groups.readerCapture.admissionKind === 'upload' && translation?.generationKind === 'import');
      check(groups.readerCapture.translationSha256 === manifest.translation?.sha256);
      selected = await captureGroup(groups.readerCapture, 'originals/reader-capture', first.original);
      check(selected.original.captureId !== first.original.captureId);
    }
    if (translation?.generationKind === 'import') {
      check(selected.candidateBytes && selected.original.existingTranslation);
      const candidate = webCaptureTranslationCandidateSchema.parse(parseBoundedJson(selected.candidateBytes, limits.maxJsonDepth));
      const declared = selected.original.existingTranslation;
      check(candidate.sourceSnapshotSha256 === manifest.source.snapshotSha256 && candidate.sourceContentFingerprint === manifest.source.contentFingerprint);
      check(declared.sourceSnapshotSha256 === candidate.sourceSnapshotSha256 && declared.sourceContentFingerprint === candidate.sourceContentFingerprint && declared.targetLanguage === candidate.targetLanguage);
      check(candidate.sourceLanguage === translation.sourceLanguage && candidate.targetLanguage === translation.targetLanguage && candidate.sdkVersion === translation.sdkVersion && candidate.promptVersion === translation.promptVersion && candidate.protectionVersion === translation.protectionVersion);
      for (const block of translation.blocks) {
        const proof = candidate.blocks.find(proof => proof.nodeId === block.nodeId);
        check(proof && proof.rawText === block.rawText && proof.sourceTextSha256 === block.sourceTextSha256);
        check(hash(canonicalManifestBytes({ ...proof.source, id: block.source.id })) === hash(canonicalManifestBytes(block.source)));
      }
    }
  } else {
    const { github } = manifest.originals;
    check(github.sourceManifestSha256 === manifest.source.manifestSha256);
    check(github.revision.readme && github.revision.sourceVersionId && github.revision.commitSha);
    check(source.source.canonicalUrl === github.revision.repository.url);
    const roles = new Map(github.files.map(file => [file.role, file]));
    check(roles.size === github.files.length && new Set(github.files.map(file => file.id)).size === github.files.length);
    const readme = github.revision.readme;
    for (const [role, asset] of [['github-raw', readme.raw], ['github-html', readme.renderedHtml]] as const) {
      check(asset); const registered = roles.get(role); check(registered);
      check(registered.assetId === asset.assetId && registered.sha256 === asset.sha256 && registered.bytes === asset.bytes && registered.mediaType === asset.mediaType && registered.filename === asset.filename);
      check(new URL(registered.url).searchParams.get('ref') === github.revision.commitSha);
    }
    for (const role of ['github-repository', 'github-commit', 'github-descriptor']) check(roles.has(role), 'BUNDLE_MISSING_RESOURCE');
    for (const file of github.files) {
      const ceiling = file.role === 'github-html' ? defaultCaptureLimits.maxHtmlBytes : file.role === 'github-descriptor' ? 2 * 1024 * 1024 : ['github-repository','github-commit','github-raw'].includes(file.role) ? 1024 * 1024 : defaultCaptureLimits.maxResourceBytes;
      await read(`originals/github/${file.role}`, file.sha256, ceiling, file.mediaType, file.bytes);
    }
  }
}
