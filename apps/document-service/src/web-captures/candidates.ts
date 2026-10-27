import { randomUUID } from 'node:crypto';
import { webCaptureTranslationCandidateSchema, webImportedTranslationSchema, naturalText, type WebCaptureManifest, type WebReaderIR, type WebImportedTranslation, type CaptureLimits } from '@pagelingo/document-contracts';
import { encodeBlock, validateStructure, decodeTranslation, PROMPT_VERSION, PROTECTION_VERSION } from '@pagelingo/translation-core';
import { canonicalManifestBytes, sha256 } from '@pagelingo/web-capture';
/** Candidate structure is only evidence. Every accepted value is compared with the server projection. */
export async function importCandidates(ir: WebReaderIR, manifest: WebCaptureManifest, fingerprint: string, irSha256: string, bytes: Uint8Array | undefined, warnings: string[], limits: CaptureLimits): Promise<WebImportedTranslation | null> {
  if (!manifest.existingTranslation) return null;
  try {
    const candidate = webCaptureTranslationCandidateSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const declared = manifest.existingTranslation;
    if (candidate.sdkVersion !== '0.4.0' || candidate.promptVersion !== PROMPT_VERSION || candidate.protectionVersion !== PROTECTION_VERSION
      || candidate.sourceSnapshotSha256 !== ir.source.snapshotSha256 || candidate.sourceContentFingerprint !== fingerprint
      || declared.sourceSnapshotSha256 !== candidate.sourceSnapshotSha256 || declared.sourceContentFingerprint !== fingerprint
      || declared.targetLanguage !== candidate.targetLanguage) throw new Error('Candidate identity/version mismatch');
    const blocks: WebImportedTranslation['blocks'] = []; const used = new Set<string>();
    for (const proof of candidate.blocks) {
      const matching = ir.blocks.filter(b => b.type === 'text' && b.sourceRefs.some(ref => ref.nodeId === proof.nodeId));
      const source = matching[0];
      if (matching.length !== 1 || source.type !== 'text' || used.has(source.id)
        || await sha256(new TextEncoder().encode(naturalText(source.value.content))) !== proof.sourceTextSha256
        || Buffer.compare(Buffer.from(canonicalManifestBytes({ ...proof.source, id: source.id })), Buffer.from(canonicalManifestBytes(source.value))) !== 0) {
        warnings.push(`Translation candidate source mismatch: ${proof.nodeId}`); continue;
      }
      const encoded = encodeBlock(source.value);
      if (validateStructure(encoded, proof.rawText).length) { warnings.push(`Translation candidate markers invalid: ${proof.nodeId}`); continue; }
      const decoded = decodeTranslation(encoded, proof.rawText);
      // A result may fit the candidate-file limit but exceed even the Reader's
      // single oversized-block allowance once the authoritative source is included.
      const entry = { source, translation: { ...source.value, content: decoded }, sourceOnlyReason: null };
      if (Buffer.byteLength(JSON.stringify(entry)) > limits.maxOversizedBlockBytes) {
        warnings.push(`Translation candidate exceeds Reader block budget: ${proof.nodeId}`); continue;
      }
      used.add(source.id); blocks.push({ ...proof, blockId: source.id, source: { ...proof.source, id: source.id } });
    }
    if (!blocks.length) return null;
    const complete = ir.blocks.every(b => b.type !== 'text' || used.has(b.id) || ir.metadata.language.language === 'zh' || b.language.language === 'zh' || b.language.reason === 'no-language');
    return webImportedTranslationSchema.parse({ schemaVersion: 'web-imported-translation/1', id: randomUUID(), generationKind: 'import',
      sourceSha256: ir.source.manifestSha256, parseId: ir.parse.id, readerIrSha256: irSha256,
      sourceSnapshotSha256: candidate.sourceSnapshotSha256, sourceContentFingerprint: fingerprint,
      sdkVersion: candidate.sdkVersion, promptVersion: candidate.promptVersion, protectionVersion: candidate.protectionVersion,
      sourceLanguage: candidate.sourceLanguage, targetLanguage: candidate.targetLanguage, blocks, status: complete ? 'completed' : 'partial' });
  } catch { warnings.push('Translation candidates were unsupported or did not match the archived source.'); return null; }
}
