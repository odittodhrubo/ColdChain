import type { QueryClient } from '@tanstack/react-query';
import type { HistoryPoint } from '../lib/queries';
import type { DeviceEvent, ReadingRow } from '../lib/types';

// Server push -> query cache. One place decides how each Socket.IO event changes the data pages already hold,
// so a page never subscribes to the socket itself (no duplicate listeners, no double updates).
//
// Query keys (shared by every page):
//   ['fridges']                 { fridges: Fridge[] }            each with id and live
//   ['fridge', id]              { fridge: Fridge, ... }
//   ['batches', filters?]       { batches: Batch[], ... }
//   ['batch', id]               { batch: Batch, ... }
//   ['alerts', ...]             alert lists and the top-bar summary
//   ['predictions', fridgeId, 'latest' | 'health-7d'], ['relocations', status], ['health']
//   ['security', ...]           rejected-message summary and list

export const REALTIME_EVENTS = [
  'fridge:update',
  'fridge:latch',
  'batch:update',
  'alert:new',
  'alert:update',
  'prediction:update',
  'relocation:update',
  'security:event',
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
  'security',
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
      const live = data as {
        fridge_id: string;
        device_id?: string;
        seq?: number;
        ts?: number;
        temp?: number | null;
        ambient?: number | null;
        door?: 0 | 1;
        comp?: 0 | 1;
        power?: 'MAINS' | 'BATTERY';
        batt?: number;
        state?: 'SAFE' | 'WARNING' | 'BREACH';
        exp_s?: number;
        latch?: 0 | 1;
        mode?: 'model' | 'manual';
        last_seen?: number;
      };
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
      qc.setQueryData<{ fridge: { live?: object | null }; readings?: ReadingRow[] }>(
        ['fridge', live.fridge_id],
        (old) => {
          if (!old) return old;
          let readings = old.readings;
          if (readings && live.temp !== undefined && live.temp !== null && live.ts && live.seq) {
            if (!readings.some((r) => r.seq === live.seq)) {
              const newRow: ReadingRow = {
                seq: live.seq,
                ts: live.ts,
                temp: live.temp,
                door: live.door ?? 0,
                comp: live.comp ?? 0,
                power: live.power ?? 'MAINS',
                batt: live.batt ?? 100,
                state: live.state ?? 'SAFE',
                late: 0,
                received_at: live.last_seen ?? Date.now(),
              };
              readings = [newRow, ...readings].slice(0, 100);
            }
          }
          return {
            ...old,
            fridge: { ...old.fridge, live: { ...(old.fridge.live ?? {}), ...live } },
            readings,
          };
        },
      );
      if (live.temp !== undefined && live.temp !== null && live.ts) {
        qc.setQueriesData<{ points: HistoryPoint[]; events: DeviceEvent[]; bucket: number }>(
          { queryKey: ['fridge', live.fridge_id, 'readings'] },
          (old) => {
            if (!old || !Array.isArray(old.points)) return old;
            const bucket = old.bucket || 5;
            const bucketTs = Math.floor(live.ts! / bucket) * bucket;
            const points = [...old.points];
            const lastIdx = points.length - 1;
            const newPt: HistoryPoint = {
              ts: bucketTs,
              temp: live.temp!,
              min: live.temp!,
              max: live.temp!,
              door: live.door ?? 0,
              comp: live.comp ?? 0,
              battery: live.power === 'BATTERY' ? 1 : 0,
              late: 0,
            };
            if (lastIdx >= 0 && points[lastIdx].ts === bucketTs) {
              points[lastIdx] = {
                ...points[lastIdx],
                temp: live.temp!,
                min: Math.min(points[lastIdx].min ?? live.temp!, live.temp!),
                max: Math.max(points[lastIdx].max ?? live.temp!, live.temp!),
                door: live.door ?? points[lastIdx].door,
                comp: live.comp ?? points[lastIdx].comp,
                battery: live.power === 'BATTERY' ? 1 : points[lastIdx].battery,
              };
            } else if (lastIdx >= 0 && points[lastIdx].ts < bucketTs) {
              points.push(newPt);
            } else if (lastIdx < 0) {
              points.push(newPt);
            }
            return { ...old, points };
          },
        );
      }
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
    case 'prediction:update': {
      // the latest forecast is the payload itself; the 7-day health history refreshes on its own schedule
      const p = data as { fridge_id: string };
      const key = ['predictions', p.fridge_id, 'latest'];
      if (qc.getQueryData(key))
        qc.setQueryData<{ predictions: unknown[]; latest: unknown }>(key, (old) =>
          old ? { ...old, latest: p, predictions: [...old.predictions, p].slice(-200) } : old,
        );
      else void qc.invalidateQueries({ queryKey: key });
      break;
    }
    case 'relocation:update':
      void qc.invalidateQueries({ queryKey: ['relocations'] });
      break;
    case 'security:event':
      void qc.invalidateQueries({ queryKey: ['security'] });
      break;
  }
}
