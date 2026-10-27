import { webReadingProgressSchema, type WebReaderDescriptor, type WebReadingPosition } from '@pagelingo/document-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../../app/session';
import { useInteractionProgress } from '../reader/use-interaction-progress';
export function useWebReadingProgress(descriptor: WebReaderDescriptor) {
  const { user, epoch } = useSession();
  const client = useQueryClient();
  return useInteractionProgress<WebReadingPosition>({ path: `/api/v1/documents/${descriptor.documentId}/web-progress`, descriptor, parseProgress: webReadingProgressSchema.parse,
    onSaved: () => { void client.invalidateQueries({ queryKey: [user!.id, 'web-reading-progress', descriptor.documentId, epoch] }); } });
}
