import type { ReactNode } from 'react';
export function Badge({ children, active }: { children: ReactNode; active?: boolean }) {
  return <span className={`badge ${active ? 'ready' : ''}`}>{children}</span>;
}
