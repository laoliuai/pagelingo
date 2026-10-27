import { captureResourceSchema, captureFileSchema, webCaptureTranslationCandidateSchema, type CaptureDraft, type CaptureResource, type CaptureFile, type WebCaptureTranslationCandidate } from '@pagelingo/document-contracts';
import { captureContentFingerprint, sha256 } from '@pagelingo/web-capture';

/** Task8 calls this only after acquisition/inspection yields real immutable file descriptors.
 * No resource bytes or status are guessed, and the original candidate snapshot may not change. */
export async function finalizeCaptureTranslation(draft: CaptureDraft, resources: readonly CaptureResource[], files: readonly CaptureFile[]): Promise<WebCaptureTranslationCandidate | null> {
  const candidate = draft.existingTranslation;
  if (!candidate) return null;
  if (candidate.sourceSnapshotSha256 !== await sha256(new TextEncoder().encode(draft.snapshot.html))) throw new Error('Candidate snapshot changed before resource finalization');
  const resolved = resources.map(resource => captureResourceSchema.parse(resource));
  const byId = new Map(resolved.map(resource => [resource.id, resource]));
  if (byId.size !== resolved.length || byId.size !== draft.pendingResources.length || draft.pendingResources.some(resource => {
    const final = byId.get(resource.id); return !final || final.url !== resource.url || final.role !== resource.role;
  })) throw new Error('Resolved resources do not match captured membership');
  const descriptors = files.map(file => captureFileSchema.parse(file));
  const fingerprint = await captureContentFingerprint(draft.snapshot, resolved, descriptors);
  if (candidate.sourceContentFingerprint && candidate.sourceContentFingerprint !== fingerprint) throw new Error('Candidate resource fingerprint changed');
  return webCaptureTranslationCandidateSchema.parse({ ...candidate, sourceContentFingerprint: fingerprint });
}
