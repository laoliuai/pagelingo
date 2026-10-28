import { captureDraftSchema, defaultCaptureLimits, type CaptureDraft } from '@pagelingo/document-contracts';
import { CaptureUnavailableError } from './collector';
import type { CaptureGrant } from './grants';

/** Count the exact Chrome JSON delivery, including escaping and the trusted grant. */
export function fitCaptureDelivery(grant: CaptureGrant, input: CaptureDraft): CaptureDraft {
  const draft = structuredClone(input);
  const bytes = () => new TextEncoder().encode(JSON.stringify({ type: 'capture:deliver', grant, payload: { ok: true, value: draft } })).byteLength;
  let deliveryBytes = bytes();
  for (const [index, resource] of draft.pendingResources.entries()) {
    if (deliveryBytes <= defaultCaptureLimits.maxIrBytes) break;
    if (resource.role !== 'css' || !('text' in resource)) continue;
    const { text: _text, ...identity } = resource;
    draft.pendingResources[index] = { ...identity, missingReason: 'too-large' };
    const warning = `Stylesheet ${resource.id} missing: complete delivery byte budget exceeded.`;
    draft.snapshot.warnings.push(warning); draft.snapshot.scope.warnings.push(warning);
    deliveryBytes = bytes();
  }
  if (deliveryBytes > defaultCaptureLimits.maxIrBytes || !captureDraftSchema.safeParse(draft).success) {
    throw new CaptureUnavailableError({ kind: 'link-only', url: draft.snapshot.sourceUrl, title: draft.metadata.title,
      warnings: ['Complete capture delivery exceeds the byte budget; only the source link can be saved.'] });
  }
  return draft;
}
