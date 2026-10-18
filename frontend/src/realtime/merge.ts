import type { QueryClient } from '@tanstack/react-query';

// Server push -> query cache. One place decides how each Socket.IO event changes the data pages already hold,
// so a page never subscribes to the socket itself (no duplicate listeners, no double updates).
//
// Query keys (shared by every page):
//   ['fridges']                 { fridges: Fridge[] }            each with id and live
//   ['fridge', id]              { fridge: Fridge, ... }
//   ['batches', filters?]       { batches: Batch[], ... }
//   ['batch', id]               { batch: Batch, ... }
//   ['alerts', ...]             alert lists and the top-bar summary
//   ['predictions', fridgeId], ['relocations'], ['health']

export const REALTIME_EVENTS = [
  'fridge:update',
  'fridge:latch',
  'batch:update',
  'alert:new',
  'alert:update',
  'prediction:update',
  'relocation:update',
] as const;
export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];

/** Keys refreshed every 5 s while the socket is down (polling fallback). */
export const POLLED_KEYS = [
  'fridges',
  'fridge',
  'batches',
  'batch',
  'alerts',
  'predictions',
  'relocations',
  'health',
];

interface WithId {
  id: number | string;
}
type ListOf<K extends string, T> = Record<K, T[]> & Record<string, unknown>;

function patchList<K extends string, T extends WithId>(
  qc: QueryClient,
  root: string,
  listKey: K,
  id: T['id'],
  patch: (item: T) => T | null, // null removes the item
) {
  let missing = false;
  qc.setQueriesData<ListOf<K, T>>({ queryKey: [root] }, (old) => {
    if (!old || !Array.isArray(old[listKey])) return old;
    const list = old[listKey];
    if (!list.some((x) => x.id === id)) {
      missing = true;
      return old;
    }
    const next = list.flatMap((x) => {
      if (x.id !== id) return [x];
      const p = patch(x);
      return p ? [p] : [];
    });
    return { ...old, [listKey]: next };
  });
  return missing;
}

export function applyRealtimeEvent(qc: QueryClient, event: string, data: unknown) {
  switch (event) {
    case 'fridge:update': {
      const live = data as { fridge_id: string };
      patchList<'fridges', WithId & { live?: object | null }>(
        qc,
        'fridges',
        'fridges',
        live.fridge_id,
        (f) => ({
          ...f,
          live: { ...(f.live ?? {}), ...live },
        }),
      );
      qc.setQueryData<{ fridge: { live?: object | null } }>(['fridge', live.fridge_id], (old) =>
        old ? { ...old, fridge: { ...old.fridge, live: { ...(old.fridge.live ?? {}), ...live } } } : old,
      );
      break;
    }
    case 'fridge:latch': {
      const { fridge_id } = data as { fridge_id: string };
      void qc.invalidateQueries({ queryKey: ['fridges'] });
      void qc.invalidateQueries({ queryKey: ['fridge', fridge_id] });
      break;
    }
    case 'batch:update': {
      const b = data as WithId & { deleted?: boolean };
      const missing = patchList<'batches', WithId>(qc, 'batches', 'batches', b.id, (x) =>
        b.deleted ? null : { ...x, ...b },
      );
      if (missing && !b.deleted) void qc.invalidateQueries({ queryKey: ['batches'] }); // new batch: filters decide
      qc.setQueryData<{ batch: object }>(['batch', b.id], (old) =>
        old && !b.deleted ? { ...old, batch: { ...old.batch, ...b } } : old,
      );
      if (b.deleted) qc.removeQueries({ queryKey: ['batch', b.id] });
      break;
    }
    case 'alert:new':
    case 'alert:update':
      void qc.invalidateQueries({ queryKey: ['alerts'] }); // lists are filtered server side
      break;
    case 'prediction:update':
      void qc.invalidateQueries({ queryKey: ['predictions'] });
      break;
    case 'relocation:update':
      void qc.invalidateQueries({ queryKey: ['relocations'] });
      break;
  }
}
