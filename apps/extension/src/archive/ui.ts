import { useEffect, useRef, useState } from 'react';
import { BINDING_KEY, type SiteBinding } from './binding';
export interface ArchiveSummary {
  id: string; title: string; state: 'permission' | 'pending' | 'retry' | 'manual' | 'completed' | 'cancelled'; kind: 'capture' | 'link';
  saveStatus: 'original-saved' | 'partial-resources' | 'link-only' | null; warnings: string[]; error?: string;
  completeWithinScope: boolean | null; permissionOrigins: string[];
}
export interface ArchiveStatus { binding: SiteBinding | null; username: string | null; items: ArchiveSummary[] }
export async function archiveCommand<T = unknown>(command: unknown): Promise<T> {
  const result = await chrome.runtime.sendMessage(command);
  if (!result?.ok) throw new Error(result?.error ?? '无法连接资料后台。'); return result.value as T;
}
export function useArchiveStatus() {
  const [status, setStatus] = useState<ArchiveStatus>({ binding: null, username: null, items: [] });
  const [error, setError] = useState(''); const epoch = useRef(0);
  useEffect(() => {
    let disposed = false; let fetching = false;
    const refresh = async () => {
      if (fetching) return; fetching = true; const version = epoch.current;
      try { const value = await archiveCommand<ArchiveStatus>({ type: 'archive:status' }); if (!disposed && version === epoch.current) { setStatus(value); setError(''); } }
      catch (e) { if (!disposed && version === epoch.current) setError(e instanceof Error ? e.message : '读取失败。'); }
      finally { fetching = false; }
    };
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !(BINDING_KEY in changes)) return;
      epoch.current++; setStatus({ binding: null, username: null, items: [] }); setError(''); void refresh();
    };
    chrome.storage.onChanged.addListener(changed); void refresh(); const timer = setInterval(() => { void refresh(); }, 700);
    return () => { disposed = true; epoch.current++; clearInterval(timer); chrome.storage.onChanged.removeListener(changed); };
  }, []);
  return { status, error, epoch };
}
