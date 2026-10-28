import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useSession } from '../../app/session';
import { LinkDialog } from './link-dialog';

interface DiscoveredLink { documentId: string; url: string; title: string }
interface LinkAction extends DiscoveredLink { request: number }
const Context = createContext<((link: DiscoveredLink) => void) | null>(null);

/** Explicitly opened actions belong to the document, independently of Reader windows and chunks. */
export function DiscoveredLinksProvider({ documentId, children }: { documentId: string; children: ReactNode }) {
  const { user, epoch } = useSession();
  return <DiscoveredLinksScope key={`${user!.id}:${epoch}:${documentId}`} documentId={documentId}>{children}</DiscoveredLinksScope>;
}
function DiscoveredLinksScope({ documentId, children }: { documentId: string; children: ReactNode }) {
  const [actions, setActions] = useState<LinkAction[]>([]);
  const sequence = useRef(0);
  const open = useCallback((link: DiscoveredLink) => {
    if (link.documentId.toLowerCase() !== documentId.toLowerCase()) return;
    const request = ++sequence.current;
    setActions(previous => previous.some(action => action.url === link.url)
      ? previous.map(action => action.url === link.url ? { ...action, request } : action)
      : [...previous, { ...link, request }]);
  }, [documentId]);
  const dismiss = useCallback((url: string, retained: boolean) => {
    if (!retained) setActions(previous => previous.filter(action => action.url !== url));
  }, []);
  return <Context.Provider value={open}>
    {children}
    {actions.map(action => <LinkDialog key={action.url}
      discoveredFromDocumentId={action.documentId} initialUrl={action.url} initialTitle={action.title}
      triggerLabel={`继续收藏发现的链接：${action.title}`} openRequest={action.request}
      onDismiss={retained => dismiss(action.url, retained)} />)}
  </Context.Provider>;
}
export function useDiscoveredLinks() {
  const open = useContext(Context);
  if (!open) throw new Error('Discovered link actions require an owned document scope');
  return open;
}
