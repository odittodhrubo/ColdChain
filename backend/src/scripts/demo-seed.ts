// Demo state (P20), run by `make demo` / `python -m coldchain_tools.stack demo`: a fresh database with the
// users, both fridges and ten batches, five per fridge, in varied states (Safe, one at ~25 % of its heat
// budget, one At risk at ~12 %, one Discard, which latches its fridge). Prints JSON (credentials, batches, QR URLs) on stdout.
//
//   npx tsx src/scripts/demo-seed.ts --reset
import fs from 'node:fs';
import { createApp } from '../app';
import { openDb } from '../db';
import { seed } from '../db/seed';
import { loadEnvOrExit } from '../env';
import { createBatch, getBatch, refreshStatus } from '../modules/batches/service';
import { publicCheckUrl } from '../modules/batches/routes';
import { BUDGET_S } from '../shared/constants';
import type { AppContext } from '../shared/http';

const BATCHES = [
  { fridge: 'fridge-01', name: 'COVID-19 mRNA', maker: 'Pfizer-BioNTech', lot: 'FA4598', left: 100, crit: 3, expiry: '2027-03-31' },
  { fridge: 'fridge-01', name: 'Measles-Rubella', maker: 'Serum Institute', lot: 'MR-2291', left: 72, crit: 3, expiry: '2027-08-15' },
  { fridge: 'fridge-01', name: 'Rotavirus', maker: 'Bharat Biotech', lot: 'RV-7310', left: 25, crit: 2, expiry: '2027-01-20' },
  { fridge: 'fridge-01', name: 'Hepatitis B', maker: 'GSK', lot: 'HB-0419', left: 12, crit: 2, expiry: '2027-06-30' },
  { fridge: 'fridge-01', name: 'Pneumococcal PCV13', maker: 'Pfizer', lot: 'PC-6620', left: 88, crit: 2, expiry: '2027-09-30' },
  { fridge: 'fridge-02', name: 'Polio bOPV', maker: 'Sanofi', lot: 'PV-1180', left: 100, crit: 3, expiry: '2028-02-28' },
  { fridge: 'fridge-02', name: 'Pentavalent', maker: 'Serum Institute', lot: 'PT-5502', left: 91, crit: 2, expiry: '2027-11-30' },
  { fridge: 'fridge-02', name: 'BCG', maker: 'Japan BCG Lab', lot: 'BC-3307', left: 55, crit: 1, expiry: '2027-05-31' },
  { fridge: 'fridge-02', name: 'Insulin glargine', maker: 'Sanofi', lot: 'IG-2040', left: 64, crit: 3, expiry: '2027-04-30' },
  { fridge: 'fridge-02', name: 'Rabies', maker: 'Sanofi', lot: 'RB-3301', left: 0, crit: 2, expiry: '2026-12-31' },
]; // prettier-ignore

async function main() {
  const config = loadEnvOrExit();
  if (process.argv.includes('--reset'))
    for (const f of [config.DB_PATH, `${config.DB_PATH}-wal`, `${config.DB_PATH}-shm`])
      fs.rmSync(f, { force: true });
  const db = openDb(config.DB_PATH);
  const seeded = await seed(db, config);
  const ctx = createApp(config, db).locals.ctx as AppContext;
  const now = Date.now();
  const batches = BATCHES.map((b) => {
    const made = createBatch(
      ctx,
      {
        name: b.name,
        manufacturer: b.maker,
        lot_number: b.lot,
        quantity: 40,
        expiry_date: b.expiry,
        criticality: b.crit,
        fridge_id: b.fridge,
      },
      undefined,
      now,
    );
    const used = Math.round((1 - b.left / 100) * BUDGET_S * 1000);
    db.prepare('UPDATE batches SET exposure_ms = ? WHERE id = ?').run(used, made.id); // exposure only ever grows
    refreshStatus(ctx, made.id, now);
    const v = getBatch(db, made.id, now);
    // As HeatEngine.afterExposure does live: out of budget latches the fridge. The node, once connected and still
    // reporting latch=0, then gets SET_LATCH (checkDeviceLatch) and turns its red LED on.
    if (v.status === 'DISCARD' && v.remaining_pct <= 0)
      db.prepare('UPDATE fridges SET latch_state = 1 WHERE id = ?').run(b.fridge);
    return {
      name: v.name,
      fridge: b.fridge,
      status: v.status,
      remaining_pct: v.remaining_pct,
      public_url: publicCheckUrl(config.PUBLIC_BASE_URL, v.public_token),
    };
  });
  await ctx.alerts.idle();
  ctx.audit.flush();
  db.close();
  console.log(
    JSON.stringify({
      db: config.DB_PATH,
      users: seeded.users,
      devices: seeded.devices.map((d) => d.deviceId),
      batches,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
