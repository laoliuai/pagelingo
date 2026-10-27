import { captureDraftTranslationCandidateSchema, naturalText, type CaptureDraftTranslationCandidate, type SanitizedSnapshot } from '@pagelingo/document-contracts';
import { encodeBlock, validateStructure, decodeTranslation, PROMPT_VERSION, PROTECTION_VERSION, type TranslationBlock } from '@pagelingo/translation-core';
import { canonicalManifestBytes, projectSnapshotTranslationSources, sha256 } from '@pagelingo/web-capture';

export interface ExistingTranslationEvidence {
  sourceLanguage: string | null;
  targetLanguage: string;
  sdkVersion: string;
  promptVersion: string;
  protectionVersion: string;
  blocks: readonly { source: TranslationBlock; rawText: string }[];
}
const canonical = (value: unknown) => new TextDecoder().decode(canonicalManifestBytes(value));
/** Compare the actual SDK input, allowing only the server-supported top-level ID rebinding. */
export async function collectExistingTranslations(snapshot: SanitizedSnapshot, evidence: ExistingTranslationEvidence | undefined, snapshotSha256: string): Promise<CaptureDraftTranslationCandidate | null> {
  if (!evidence?.blocks.length) return null;
  if (evidence.sdkVersion !== '0.4.0' || evidence.promptVersion !== PROMPT_VERSION || evidence.protectionVersion !== PROTECTION_VERSION) {
    snapshot.warnings.push('Translation candidate versions are unsupported; original retained.'); return null;
  }
  const projected = projectSnapshotTranslationSources(snapshot);
  const bySource = new Map<string, typeof projected>();
  for (const block of projected) {
    const key = canonical({ ...block.source, id: '' });
    const entries = bySource.get(key) ?? []; entries.push(block); bySource.set(key, entries);
  }
  const used = new Set<string>();
  const blocks: CaptureDraftTranslationCandidate['blocks'] = [];
  for (const proof of evidence.blocks) {
    const matching = bySource.get(canonical({ ...proof.source, id: '' })) ?? [];
    if (matching.length !== 1 || used.has(matching[0]!.nodeId)) {
      snapshot.warnings.push(`Translation candidate source mismatch or ambiguous: ${proof.source.id}`); continue;
    }
    try {
      const input = encodeBlock(proof.source);
      if (validateStructure(input, proof.rawText).length) throw new Error('Invalid markers');
      decodeTranslation(input, proof.rawText);
      const nodeId = matching[0]!.nodeId;
      blocks.push({ nodeId, source: proof.source, rawText: proof.rawText, sourceTextSha256: await sha256(new TextEncoder().encode(naturalText(proof.source.content))) });
      used.add(nodeId);
    } catch { snapshot.warnings.push(`Translation candidate markers invalid: ${proof.source.id}`); }
  }
  if (!blocks.length) return null;
  const result = captureDraftTranslationCandidateSchema.safeParse({ ...evidence, schemaVersion: 'web-capture-translation-candidate/1', sourceSnapshotSha256: snapshotSha256, sourceContentFingerprint: null, blocks });
  if (!result.success) { snapshot.warnings.push('Translation candidates exceed supported schema or byte limits; original retained.'); return null; }
  return result.data;
}
