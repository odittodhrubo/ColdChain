import { SAFE_MAX_C, SAFE_MIN_C } from '../../shared/constants';
import { notFound } from '../../shared/errors';
import type { AppContext } from '../../shared/http';

// Temperature records for inspection (P2, WHO EVM practice): an hourly CSV, a daily min/max/avg summary, every
// excursion above 8 °C with its duration and the batches it touched, door-open and power-failure counts, and the
// audit head hash at generation time (provenance). Excursions use the same threshold as the exposure engine
// (temp > SAFE_MAX_C, or a sensor fault), so the report and the heat budget never disagree.

const ONE_HOUR_S = 3600;
const EXCURSION_GAP_S = 60; // readings more than a minute apart start a new excursion run

export interface HourRow {
  hour: number; // unix s, start of hour
  n: number;
  n_temp: number;
  t_min: number | null;
  t_max: number | null;
  t_avg: number | null;
  n_above_8: number;
  n_door_open: number;
  n_comp_on: number;
  n_battery: number;
}

export interface DaySummary {
  date: string; // YYYY-MM-DD (UTC)
  n: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  above8: number;
}

export interface Excursion {
  start: number; // unix s
  end: number;
  duration_min: number;
  peak: number | null; // highest temperature in the run, null if only sensor faults
  fault: boolean; // the run included a sensor fault (unknown temperature)
  batches: string[]; // batch names assigned to this fridge during the excursion
}

export interface FridgeReport {
  fridge: { id: string; name: string };
  from: number; // unix s
  to: number;
  generated_at: number; // unix ms
  hours: HourRow[];
  days: DaySummary[];
  excursions: Excursion[];
  door_opens: number;
  power_failures: number;
  audit_head: { id: number; hash: string };
}

/** Hourly aggregates from raw readings; hours already retired (R8) come from readings_hourly instead. */
function hourlyRows(ctx: AppContext, fridgeId: string, fromS: number, toS: number): HourRow[] {
  const raw = ctx.db
    .prepare(
      `SELECT (ts / 3600) * 3600 AS hour, COUNT(*) AS n, SUM(temp IS NOT NULL) AS n_temp,
              MIN(temp) AS t_min, MAX(temp) AS t_max, ROUND(AVG(temp), 2) AS t_avg,
              SUM(temp > @max) AS n_above_8, SUM(door) AS n_door_open, SUM(comp) AS n_comp_on,
              SUM(power = 'BATTERY') AS n_battery
       FROM readings WHERE fridge_id = @f AND ts >= @from AND ts <= @to
       GROUP BY ts / 3600 ORDER BY hour`,
    )
    .all({ f: fridgeId, from: fromS, to: toS, max: SAFE_MAX_C }) as HourRow[];

  // Retention leaves only rollups before the oldest raw reading; pull those hours from readings_hourly.
  const oldestRaw = ctx.db
    .prepare('SELECT MIN(ts) FROM readings WHERE fridge_id = ?')
    .pluck()
    .get(fridgeId) as number | null;
  if (oldestRaw === null || fromS < oldestRaw) {
    const boundary = oldestRaw === null ? toS + 1 : Math.floor(oldestRaw / ONE_HOUR_S) * ONE_HOUR_S;
    const rolled = ctx.db
      .prepare(
        `SELECT hour, n, n_temp, t_min, t_max, t_avg, n_above_8, n_door_open, n_comp_on, n_battery
         FROM readings_hourly WHERE fridge_id = ? AND hour >= ? AND hour <= ? AND hour < ?
         ORDER BY hour`,
      )
      .all(fridgeId, fromS, toS, boundary) as HourRow[];
    return [...rolled, ...raw];
  }
  return raw;
}

function daily(hours: HourRow[]): DaySummary[] {
  const byDay = new Map<string, DaySummary>();
  for (const h of hours) {
    const date = new Date(h.hour * 1000).toISOString().slice(0, 10); // shortcut: UTC day, as batch expiry uses
    const d =
      byDay.get(date) ?? { date, n: 0, min: null, max: null, avg: null, above8: 0 };
    d.n += h.n;
    d.above8 += h.n_above_8;
    if (h.t_min !== null) d.min = d.min === null ? h.t_min : Math.min(d.min, h.t_min);
    if (h.t_max !== null) d.max = d.max === null ? h.t_max : Math.max(d.max, h.t_max);
    byDay.set(date, d);
  }
  // Weighted average per day from the hourly averages, weighted by readings that had a temperature.
  const weight = new Map<string, { sum: number; w: number }>();
  for (const h of hours) {
    if (h.t_avg === null || h.n_temp === 0) continue;
    const date = new Date(h.hour * 1000).toISOString().slice(0, 10);
    const acc = weight.get(date) ?? { sum: 0, w: 0 };
    acc.sum += h.t_avg * h.n_temp;
    acc.w += h.n_temp;
    weight.set(date, acc);
  }
  for (const [date, acc] of weight) byDay.get(date)!.avg = acc.w ? Math.round((acc.sum / acc.w) * 100) / 100 : null;
  return [...byDay.values()];
}

/** Excursion runs: consecutive above-8 °C (or faulted) readings, split by gaps over a minute. */
function excursions(ctx: AppContext, fridgeId: string, fromS: number, toS: number): Excursion[] {
  const rows = ctx.db
    .prepare(
      `SELECT ts, temp FROM readings WHERE fridge_id = ? AND ts >= ? AND ts <= ? AND (temp > ? OR temp IS NULL)
       ORDER BY ts`,
    )
    .all(fridgeId, fromS, toS, SAFE_MAX_C) as { ts: number; temp: number | null }[];
  const runs: Excursion[] = [];
  const names = ctx.db.prepare(
    `SELECT DISTINCT b.name FROM batch_assignments a JOIN batches b ON b.id = a.batch_id AND b.deleted_at IS NULL
     WHERE a.fridge_id = ? AND a.from_ts < ? AND (a.to_ts IS NULL OR a.to_ts > ?) ORDER BY b.name`,
  ).pluck();
  let cur: Excursion | null = null;
  const close = (c: Excursion) => {
    c.duration_min = Math.round(((c.end - c.start) / 60) * 10) / 10;
    c.batches = names.all(fridgeId, c.end * 1000, c.start * 1000) as string[];
    runs.push(c);
  };
  for (const r of rows) {
    if (cur && r.ts - cur.end > EXCURSION_GAP_S) {
      close(cur);
      cur = null;
    }
    if (!cur) cur = { start: r.ts, end: r.ts, duration_min: 0, peak: r.temp, fault: r.temp === null, batches: [] };
    cur.end = r.ts;
    if (r.temp === null) cur.fault = true;
    else cur.peak = cur.peak === null ? r.temp : Math.max(cur.peak, r.temp);
  }
  if (cur) close(cur);
  return runs;
}

export function buildReport(ctx: AppContext, fridgeId: string, fromS: number, toS: number): FridgeReport {
  const fridge = ctx.db.prepare('SELECT id, name FROM fridges WHERE id = ?').get(fridgeId) as
    | { id: string; name: string }
    | undefined;
  if (!fridge) throw notFound('Fridge not found');
  const hours = hourlyRows(ctx, fridgeId, fromS, toS);
  const eventCount = (type: string) =>
    ctx.db
      .prepare('SELECT COUNT(*) FROM events WHERE fridge_id = ? AND type = ? AND ts >= ? AND ts <= ?')
      .pluck()
      .get(fridgeId, type, fromS, toS) as number;
  const head = (ctx.db.prepare('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
    | { id: number; hash: string }
    | undefined) ?? { id: 0, hash: '0'.repeat(64) };
  return {
    fridge,
    from: fromS,
    to: toS,
    generated_at: Date.now(),
    hours,
    days: daily(hours),
    excursions: excursions(ctx, fridgeId, fromS, toS),
    door_opens: eventCount('DOOR_OPEN'),
    power_failures: eventCount('POWER_FAIL'),
    audit_head: head,
  };
}

// ---------------------------------------------------------------- rendering

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Hourly rows as CSV (one row per hour, newest aggregates first column is the ISO hour). */
export function reportCsv(r: FridgeReport): string {
  const header = ['hour', 'readings', 'with_temp', 't_min_c', 't_max_c', 't_avg_c', 'above_8c', 'door_open', 'comp_on', 'on_battery'];
  const lines = [header.join(',')];
  for (const h of r.hours)
    lines.push(
      [
        new Date(h.hour * 1000).toISOString(),
        h.n, h.n_temp, h.t_min, h.t_max, h.t_avg, h.n_above_8, h.n_door_open, h.n_comp_on, h.n_battery,
      ].map(csvCell).join(','),
    );
  return lines.join('\n') + '\n';
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const iso = (s: number) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const num = (v: number | null) => (v === null ? '—' : v.toFixed(1));

/** A self-contained, print-ready HTML report. No headless browser, no dependency: the user prints it to PDF. */
export function reportHtml(r: FridgeReport): string {
  const days = r.days
    .map(
      (d) =>
        `<tr><td>${d.date}</td><td>${num(d.min)}</td><td>${num(d.max)}</td><td>${num(d.avg)}</td><td>${d.above8}</td></tr>`,
    )
    .join('');
  const exc = r.excursions.length
    ? r.excursions
        .map(
          (e) =>
            `<tr><td>${iso(e.start)}</td><td>${iso(e.end)}</td><td>${e.duration_min}</td><td>${num(e.peak)}${e.fault ? ' (fault)' : ''}</td><td>${esc(e.batches.join(', ')) || '—'}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5">No excursions above 8 °C in this period.</td></tr>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Temperature record — ${esc(r.fridge.name)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 system-ui, sans-serif; color: #111; margin: 2rem; max-width: 60rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .meta { color: #555; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1.5rem; }
  th, td { border: 1px solid #ccc; padding: .35rem .6rem; text-align: left; }
  th { background: #f3f4f6; }
  .hash { font-family: ui-monospace, monospace; font-size: .8rem; word-break: break-all; }
  @media print { body { margin: 0; } button { display: none; } }
</style></head>
<body>
  <button onclick="print()">Print / Save as PDF</button>
  <h1>Temperature record — ${esc(r.fridge.name)}</h1>
  <p class="meta">Fridge ${esc(r.fridge.id)} · ${iso(r.from)} to ${iso(r.to)} · safe range ${SAFE_MIN_C}–${SAFE_MAX_C} °C
    · generated ${new Date(r.generated_at).toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
  <h2>Daily min / max / average</h2>
  <table><thead><tr><th>Date (UTC)</th><th>Min °C</th><th>Max °C</th><th>Avg °C</th><th>Readings &gt; 8 °C</th></tr></thead>
    <tbody>${days || '<tr><td colspan="5">No data in this period.</td></tr>'}</tbody></table>
  <h2>Excursions above 8 °C</h2>
  <table><thead><tr><th>Start</th><th>End</th><th>Duration (min)</th><th>Peak °C</th><th>Batches affected</th></tr></thead>
    <tbody>${exc}</tbody></table>
  <h2>Events</h2>
  <p>Door opened ${r.door_opens} time(s); power failures ${r.power_failures}.</p>
  <h2>Provenance</h2>
  <p class="hash">Audit head #${r.audit_head.id}: ${r.audit_head.hash}</p>
</body></html>`;
}
