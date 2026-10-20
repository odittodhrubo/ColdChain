import { describe, expect, it } from 'vitest';
import { CALIBRATION_MAX_C } from '../src/shared/constants';
import { getFridge } from '../src/modules/fridges/service';
import { setup } from './deviceHelpers';
import { addUser, bearer, tokenFor } from './helpers';

describe('sensor calibration (P4)', () => {
  it('sends a signed, bounded SET_CALIBRATION, mirrors the offset, and audits it', async () => {
    const s = setup();
    const admin = bearer(tokenFor(s.t, await addUser(s.t, 'ADMIN')));
    const res = await s.t.http().post('/api/devices/fridge-01/calibrate').set(admin).send({
      offset_c: 1.5,
      reason: 'calibrated against reference thermometer',
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ device_id: 'fridge-01', offset_c: 1.5 });
    expect(res.body.command).toMatchObject({ type: 'SET_CALIBRATION', status: 'PENDING' });

    const sent = s.published.filter((p) => p.topic.endsWith('/cmd')).map((p) => JSON.parse(p.payload));
    const body = JSON.parse(sent.at(-1)!.body);
    expect(body).toMatchObject({ type: 'SET_CALIBRATION', args: { offset_c: 1.5 } });

    expect(getFridge(s.ctx, 'fridge-01').calibration_offset_c).toBe(1.5);
    expect(
      s.t.db.prepare("SELECT payload FROM audit_log WHERE event_type = 'DEVICE_CALIBRATED'").pluck().get(),
    ).toContain('"offset_c":1.5');
    s.ctx.commands.stop();
  });

  it('refuses an offset beyond the bound and an unknown device', async () => {
    const s = setup();
    const admin = bearer(tokenFor(s.t, await addUser(s.t, 'ADMIN')));
    const over = CALIBRATION_MAX_C + 0.5;
    expect(
      (await s.t.http().post('/api/devices/fridge-01/calibrate').set(admin).send({ offset_c: over, reason: 'xxx' }))
        .status,
    ).toBe(400);
    expect(
      (await s.t.http().post('/api/devices/nope/calibrate').set(admin).send({ offset_c: 1, reason: 'xxx' })).status,
    ).toBe(404);
    s.ctx.commands.stop();
  });
});
