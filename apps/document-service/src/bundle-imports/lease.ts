import type { Actor } from '../auth/guards.js';
import { assertActorCurrent } from '../auth/guards.js';
import type { Database } from '../db/database.js';
import { conflict, lockImport } from './repository.js';

export function maintainLease(db: Database, actor: Actor, id: string, epoch: string, controller: AbortController) {
  let pending: Promise<void> | undefined;
  const interval = setInterval(() => {
    if (pending || controller.signal.aborted) return;
    pending = db.transaction(async client => {
      await assertActorCurrent(client, actor);
      await lockImport(client, actor.userId, id, epoch);
      const result = await client.query(`UPDATE bundle_imports SET heartbeat_at=now(),updated_at=now()
        WHERE owner_id=$1 AND id=$2 AND epoch=$3 AND status IN ('receiving','validating')
        AND heartbeat_at >= now() - interval '15 minutes' RETURNING id`, [actor.userId, id, epoch]);
      if (!result.rowCount) throw conflict('BUNDLE_IMPORT_SUPERSEDED');
    }).catch(error => { controller.abort(error); }).finally(() => { pending = undefined; });
  }, 500);
  interval.unref();
  return async () => { clearInterval(interval); await pending; };
}
