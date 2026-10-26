import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { PublicUser, SessionView } from '@pagelingo/document-contracts';
import { apiRequest, configureApi, resetApiSession } from '../shared/api-client';
import { queryClient } from './providers';
interface Session {
  user: PublicUser | null;
  loading: boolean;
  epoch: number;
  login: (username: string, password: string) => Promise<void>;
  logout: (allDevices?: boolean) => Promise<void>;
  clear: () => void;
}
const Context = createContext<Session | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<SessionView>({ user: null, csrfToken: null });
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const current = useRef<SessionView>(view);
  const serial = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const apply = useCallback((next: SessionView) => {
    serial.current++;
    resetApiSession(next.csrfToken);
    void queryClient.cancelQueries();
    queryClient.clear();
    current.current = next;
    setView(next);
    setEpoch((value) => value + 1);
    setLoading(false);
  }, []);
  const clear = useCallback(() => apply({ user: null, csrfToken: null }), [apply]);
  useEffect(() => {
    configureApi(clear);
    const refresh = async () => {
      const version = serial.current;
      try {
        const next = await apiRequest<SessionView>('/api/v1/auth/session');
        if (version !== serial.current) return;
        if (
          next.user?.id !== current.current.user?.id ||
          next.csrfToken !== current.current.csrfToken
        )
          apply(next);
        else setLoading(false);
      } catch (error) {
        if (
          !(error instanceof DOMException && error.name === 'AbortError') &&
          version === serial.current
        )
          clear();
      }
    };
    void refresh();
    channel.current = new BroadcastChannel('pgl-session');
    channel.current.onmessage = () => {
      clear();
      void refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      channel.current?.close();
      configureApi(() => {});
      resetApiSession(null);
    };
  }, [apply, clear]);
  return (
    <Context.Provider
      value={{
        user: view.user,
        loading,
        epoch,
        clear,
        login: async (username, password) => {
          // Invalidate all old requests before accepting another identity.
          if (current.current.user) clear();
          else {
            serial.current++;
            resetApiSession(null);
            void queryClient.cancelQueries();
            queryClient.clear();
          }
          const next = await apiRequest<SessionView>('/api/v1/auth/login', {
            method: 'POST',
            body: { username, password },
          });
          apply(next);
          channel.current?.postMessage('changed');
        },
        logout: async (allDevices = false) => {
          await apiRequest('/api/v1/auth/logout', { method: 'POST', body: { allDevices } });
          clear();
          channel.current?.postMessage('changed');
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const session = useContext(Context);
  if (!session) throw new Error('Missing session provider');
  return session;
}
