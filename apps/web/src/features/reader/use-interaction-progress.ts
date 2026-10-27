import { useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest, apiSessionSignal } from '../../shared/api-client';
import type { InteractionOrigin } from './window-state';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';
/** One mounted identity owns a serial CAS writer. Passive layout never changes its pending position. */
export function useInteractionProgress<Position extends { readerVersionId: string; sourceVersionId: string; parseId: string }>({ path, descriptor, parseProgress, onConflict, onSaved }: {
  path: string; descriptor: { versionId: string; source: { sourceVersionId: string }; parseId: string; progress: { revision: number } | null }; parseProgress: (value: unknown) => { revision: number }; onConflict?: () => void; onSaved?: () => void;
}) {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const state = useRef({ revision: descriptor.progress?.revision ?? 0, position: null as Position | null,
    dirtySince: 0, changedAt: 0, serial: 0, acknowledged: 0, inFlight: false,
    frozen: false, active: true, timer: undefined as ReturnType<typeof setTimeout> | undefined,
    scope: apiSessionSignal(), request: new AbortController() });
  const conflictCallback = useRef(onConflict); conflictCallback.current = onConflict;
  const savedCallback = useRef(onSaved); savedCallback.current = onSaved;
  const cancelTimer = () => { clearTimeout(state.current.timer); state.current.timer = undefined; };
  const schedule = () => {
    const current = state.current; cancelTimer();
    if (!current.active || current.frozen || current.inFlight || current.scope.aborted || current.serial === current.acknowledged) return;
    const delay = Math.max(0, Math.min(current.changedAt + 1500, current.dirtySince + 5000) - Date.now());
    current.timer = setTimeout(() => { void flush(); }, delay);
  };
  const fail = (error: unknown) => {
    const current = state.current;
    if (!current.active || current.scope.aborted || current.request.signal.aborted) return;
    current.frozen = true;
    if (error instanceof ApiError && error.code === 'PROGRESS_CONFLICT') {
      setStatus('conflict'); conflictCallback.current?.();
    } else setStatus('error');
  };
  const flush = async (exit = false) => {
    const current = state.current; cancelTimer();
    if (current.scope.aborted || current.frozen || current.inFlight || !current.position || current.serial === current.acknowledged) return;
    current.inFlight = true; const serial = current.serial; const position = current.position;
    // This snapshot is now in flight. New input starts a separate unsent batch deadline.
    current.dirtySince = 0;
    if (!exit) setStatus('saving');
    try {
      const saved = parseProgress(await apiRequest(path, {
        method: 'PUT', body: { expectedRevision: current.revision, position },
        signal: AbortSignal.any([current.scope, current.request.signal]), keepalive: exit,
      }));
      if (current.scope.aborted || current.request.signal.aborted) return;
      // An exit save can finish after unmount. Notify the captured account's cache,
      // while keeping position/revision updates confined to this mounted writer.
      savedCallback.current?.();
      if (!current.active) return;
      current.revision = saved.revision; current.acknowledged = serial;
      setStatus('saved');
    } catch (error) { fail(error); }
    finally { current.inFlight = false; if (current.active && !current.frozen) schedule(); }
  };
  useEffect(() => {
    const current = state.current; current.active = true;
    const exit = () => { void flush(true); };
    window.addEventListener('pagehide', exit);
    return () => {
      window.removeEventListener('pagehide', exit); cancelTimer();
      // A pending request may already have committed. Never send a second exit write on its behalf.
      if (!current.inFlight) void flush(true);
      else current.request.abort();
      current.active = false;
    };
  }, []);
  const change = (position: Position, origin: InteractionOrigin) => {
    const current = state.current;
    if (origin !== 'user' || !current.active || current.scope.aborted || position.readerVersionId !== descriptor.versionId || position.sourceVersionId !== descriptor.source.sourceVersionId || position.parseId !== descriptor.parseId) return;
    current.position = position; current.serial++; current.changedAt = Date.now();
    if (!current.dirtySince) current.dirtySince = current.changedAt;
    schedule();
  };
  const continueHere = async () => {
    const current = state.current;
    if (!current.active || current.scope.aborted || current.inFlight || !current.position) return;
    current.inFlight = true; setStatus('saving');
    try {
      const value = await apiRequest(path, { signal: AbortSignal.any([current.scope, current.request.signal]) });
      if (!current.active || current.scope.aborted) return;
      current.revision = value === null ? 0 : parseProgress(value).revision;
      current.frozen = false;
    } catch (error) { fail(error); }
    finally { current.inFlight = false; }
    if (current.active && !current.frozen && !current.scope.aborted) await flush();
  };
  return { status, change, continueHere };
}
