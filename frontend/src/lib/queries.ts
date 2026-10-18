import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { setServerTime } from './time';
import type { Alert, BatchList, DeviceEvent, Fridge, FridgeList, ReadingRow } from './types';

// One hook per server resource, on the query keys realtime/merge.ts updates.

export function useFridges() {
  return useQuery({
    queryKey: ['fridges'],
    queryFn: async ({ signal }) => {
      const res = await api<FridgeList>('/api/fridges', { signal });
      setServerTime(res.server_time);
      return res;
    },
  });
}

export function useFridge(id: string) {
  return useQuery({
    queryKey: ['fridge', id],
    queryFn: async ({ signal }) => {
      const res = await api<{
        fridge: Fridge;
        events: DeviceEvent[];
        readings: ReadingRow[];
        server_time: number;
      }>(`/api/fridges/${encodeURIComponent(id)}`, { signal });
      setServerTime(res.server_time);
      return res;
    },
  });
}

export interface HistoryPoint {
  ts: number;
  temp: number | null;
  min: number | null;
  max: number | null;
  door: number;
  comp: number;
  battery: number;
  late: number;
}

export function useReadings(id: string, rangeS: number, bucket?: number) {
  return useQuery({
    queryKey: ['fridge', id, 'readings', rangeS],
    queryFn: ({ signal }) => {
      const to = Math.floor(Date.now() / 1000);
      const qs = new URLSearchParams({ from: String(to - rangeS), to: String(to) });
      if (bucket) qs.set('bucket', String(bucket));
      return api<{ points: HistoryPoint[]; events: DeviceEvent[]; bucket: number }>(
        `/api/fridges/${encodeURIComponent(id)}/readings?${qs}`,
        { signal },
      );
    },
    refetchInterval: 15_000, // history is not pushed; new buckets appear every 15 s
  });
}

export function useFridgeBatches(fridgeId: string) {
  return useQuery({
    queryKey: ['batches', { fridge_id: fridgeId }],
    queryFn: ({ signal }) =>
      api<BatchList>(`/api/batches?fridge_id=${encodeURIComponent(fridgeId)}&pageSize=200`, { signal }),
  });
}

export function useActiveAlerts(limit = 8) {
  return useQuery({
    queryKey: ['alerts', 'active', limit],
    queryFn: ({ signal }) =>
      api<{ alerts: Alert[]; total: number }>(`/api/alerts?status=active&pageSize=${limit}`, { signal }),
  });
}
