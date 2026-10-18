import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { setServerTime } from '../lib/time';
import type { Prediction, RelocationPlan } from '../lib/types';

// AI resources. Keys match realtime/merge.ts: prediction:update refreshes ['predictions'],
// relocation:update refreshes ['relocations'].

interface PredictionList {
  predictions: Prediction[];
  latest: Prediction | null;
  server_time: number;
}

/** Latest forecast + health of a fridge (and the last hour of predictions). */
export function usePrediction(fridgeId: string) {
  return useQuery({
    queryKey: ['predictions', fridgeId, 'latest'],
    queryFn: async ({ signal }) => {
      const from = Date.now() - 3600_000;
      const res = await api<PredictionList>(
        `/api/ml/predictions/${encodeURIComponent(fridgeId)}?from=${from}&limit=200`,
        { signal },
      );
      setServerTime(res.server_time);
      return res;
    },
    refetchInterval: 30_000, // the scheduler's own pace: covers a missed socket event
  });
}

/** Health scores over the last 7 days for the trend sparkline (thinned to ~150 points). */
export function useHealthHistory(fridgeId: string) {
  return useQuery({
    queryKey: ['predictions', fridgeId, 'health-7d'],
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const from = Date.now() - 7 * 86_400_000;
      const res = await api<PredictionList>(
        `/api/ml/predictions/${encodeURIComponent(fridgeId)}?from=${from}&limit=2000`,
        { signal },
      );
      const points = res.predictions
        .filter((p) => p.health_score !== null && p.source === 'model')
        .map((p) => ({ t: p.created_at, health: p.health_score as number }));
      const step = Math.max(1, Math.ceil(points.length / 150));
      return points.filter((_, i) => i % step === 0 || i === points.length - 1);
    },
  });
}

export function useRelocations(status: 'active' | 'all' = 'active') {
  return useQuery({
    queryKey: ['relocations', status],
    queryFn: async ({ signal }) => {
      const res = await api<{ plans: RelocationPlan[]; server_time: number }>(
        `/api/relocations?status=${status}&limit=30`,
        { signal },
      );
      setServerTime(res.server_time);
      return res.plans;
    },
  });
}
