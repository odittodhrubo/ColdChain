import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { applyRealtimeEvent } from './merge';

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('socket events merge into the query cache', () => {
  it('fridge:update patches the live state in the list and the detail', () => {
    const qc = client();
    qc.setQueryData(['fridges'], {
      fridges: [
        { id: 'fridge-01', name: 'A', live: { temp: 4.1, door: 0 } },
        { id: 'fridge-02', name: 'B', live: null },
      ],
    });
    qc.setQueryData(['fridge', 'fridge-01'], { fridge: { id: 'fridge-01', live: { temp: 4.1, door: 0 } } });
    applyRealtimeEvent(qc, 'fridge:update', { fridge_id: 'fridge-01', temp: 9.2, door: 1 });
    const list = qc.getQueryData<{ fridges: { id: string; live: Record<string, unknown> | null }[] }>([
      'fridges',
    ])!;
    expect(list.fridges[0].live).toMatchObject({ temp: 9.2, door: 1 });
    expect(list.fridges[1].live).toBeNull(); // untouched
    expect(qc.getQueryData<{ fridge: { live: object } }>(['fridge', 'fridge-01'])!.fridge.live).toMatchObject(
      {
        temp: 9.2,
      },
    );
  });

  it('batch:update replaces a known batch in every list and detail, removes a deleted one', () => {
    const qc = client();
    qc.setQueryData(['batches', {}], {
      batches: [
        { id: 1, status: 'SAFE' },
        { id: 2, status: 'SAFE' },
      ],
      total: 2,
    });
    qc.setQueryData(['batches', { fridge_id: 'fridge-01' }], {
      batches: [{ id: 1, status: 'SAFE' }],
      total: 1,
    });
    qc.setQueryData(['batch', 1], { batch: { id: 1, status: 'SAFE', name: 'MMR' } });
    applyRealtimeEvent(qc, 'batch:update', { id: 1, status: 'AT_RISK', remaining_pct: 18 });
    expect(qc.getQueryData<{ batches: object[] }>(['batches', {}])!.batches[0]).toEqual({
      id: 1,
      status: 'AT_RISK',
      remaining_pct: 18,
    });
    expect(
      qc.getQueryData<{ batches: object[] }>(['batches', { fridge_id: 'fridge-01' }])!.batches[0],
    ).toMatchObject({
      status: 'AT_RISK',
    });
    expect(qc.getQueryData<{ batch: object }>(['batch', 1])!.batch).toMatchObject({
      name: 'MMR',
      status: 'AT_RISK',
    });
    applyRealtimeEvent(qc, 'batch:update', { id: 2, deleted: true });
    expect(qc.getQueryData<{ batches: { id: number }[] }>(['batches', {}])!.batches.map((b) => b.id)).toEqual(
      [1],
    );
  });

  it('a batch the lists do not hold yet makes them refetch (their filters decide)', () => {
    const qc = client();
    qc.setQueryData(['batches', {}], { batches: [{ id: 1 }] });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyRealtimeEvent(qc, 'batch:update', { id: 9, status: 'SAFE' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['batches'] });
  });

  it('alert, prediction, relocation and security events refresh their queries', () => {
    const qc = client();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyRealtimeEvent(qc, 'alert:new', { id: 1 });
    applyRealtimeEvent(qc, 'prediction:update', { fridge_id: 'fridge-01' });
    applyRealtimeEvent(qc, 'relocation:update', { id: 3 });
    applyRealtimeEvent(qc, 'security:event', { reason: 'BAD_SIG' });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { queryKey: ['alerts'] },
      { queryKey: ['predictions', 'fridge-01', 'latest'] }, // nothing cached yet: fetch it
      { queryKey: ['relocations'] },
      { queryKey: ['security'] },
    ]);
  });

  it('prediction:update replaces the cached latest forecast without a refetch', () => {
    const qc = client();
    qc.setQueryData(['predictions', 'fridge-01', 'latest'], {
      predictions: [],
      latest: null,
      server_time: 1,
    });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    applyRealtimeEvent(qc, 'prediction:update', { fridge_id: 'fridge-01', pred_temp_30: 6.1 });
    expect(spy).not.toHaveBeenCalled();
    expect(
      qc.getQueryData<{ latest: { pred_temp_30: number } }>(['predictions', 'fridge-01', 'latest'])?.latest
        .pred_temp_30,
    ).toBe(6.1);
  });
});
