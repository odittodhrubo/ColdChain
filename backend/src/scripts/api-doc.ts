// npm run docs:api: docs/API.md from the route registry itself (method, path, who may call it, parameters),
// so the reference cannot drift from the code. `--check` exits 1 when the committed file is stale.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { openDb } from '../db';
import { PERMISSIONS } from '../rbac/permissions';
import type { RouteDef } from '../shared/http';

const OUT = path.resolve(__dirname, '../../../docs/API.md');

// any valid configuration builds the registry; nothing is served or stored
const config = loadConfig({
  NODE_ENV: 'test',
  JWT_SECRET: 'x'.repeat(48),
  APP_SECRET_KEY: 'ab'.repeat(32),
  MQTT_URL: 'mqtt://localhost:1883',
  DB_PATH: ':memory:',
});
const routes = createApp(config, openDb(':memory:')).locals.routes as RouteDef[];

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  format?: string;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
}

const typeOf = (s: JsonSchema): string => {
  if (s.enum) return s.enum.map((v) => `\`${String(v)}\``).join(' \\| ');
  if (s.anyOf) return s.anyOf.map(typeOf).join(' \\| ');
  const t = Array.isArray(s.type) ? s.type.join('/') : (s.type ?? 'any');
  const max = s.maximum !== undefined && s.maximum < Number.MAX_SAFE_INTEGER ? s.maximum : undefined;
  const min = s.minimum ?? (s.exclusiveMinimum !== undefined ? `>${s.exclusiveMinimum}` : undefined);
  const range =
    min !== undefined && max !== undefined
      ? ` ${min}..${max}`
      : min !== undefined
        ? ` ≥ ${String(min).replace('>', '')}${String(min).startsWith('>') ? ' (exclusive)' : ''}`
        : max !== undefined
          ? ` ≤ ${max}`
          : s.maxLength !== undefined
            ? ` ≤ ${s.maxLength} chars`
            : '';
  return `${s.format ?? (t === 'array' ? `${typeOf(s.items ?? {})}[]` : t)}${range}`;
};

function fields(schema: unknown): string {
  if (!schema) return '';
  const js = z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  const req = new Set(js.required ?? []);
  return Object.entries(js.properties ?? {})
    .map(([k, v]) => {
      const opt = !req.has(k) || v.default !== undefined;
      const def = v.default !== undefined ? ` = ${JSON.stringify(v.default)}` : '';
      return `\`${k}${opt ? '?' : ''}\`: ${typeOf(v)}${def}`;
    })
    .join('<br>');
}

const who = (r: RouteDef) =>
  r.access === 'public'
    ? 'public'
    : r.access === 'authenticated'
      ? 'any signed-in user'
      : `\`${r.access.permission}\` (${[...PERMISSIONS[r.access.permission]].map((x) => x[0] + x.slice(1).toLowerCase()).join(', ')})`;

const section = (p: string) => p.split('/')[2] ?? 'other';
const groups = new Map<string, RouteDef[]>();
for (const r of routes) groups.set(section(r.path), [...(groups.get(section(r.path)) ?? []), r]);

let md = `# API reference

Generated from the backend's route registry by \`npm --prefix backend run docs:api\`. Do not edit by hand: the
test suite fails when this file is stale.

- Base URL: the backend (\`http://localhost:4000\`). Requests and responses are JSON unless noted.
- Authentication: \`Authorization: Bearer <JWT>\` from \`POST /api/auth/login\` (lifetime \`JWT_EXPIRES_IN\`, default 1 h). Who may call a route is
  enforced on the server; the UI only mirrors it.
- Errors: \`{ "error": { "code", "message", "details"? } }\` with 400 (validation, unknown fields refused),
  401, 403, 404, 409 (state conflicts, e.g. \`FRIDGE_FULL\`, \`PLAN_CHANGED\`), 429 (rate limited), 503.
- Realtime (Socket.IO, same origin, \`auth: {token}\`): \`fridge:update\`, \`fridge:latch\`, \`batch:update\`,
  \`alert:new\`, \`alert:update\`, \`prediction:update\`, \`relocation:update\`, \`security:event\`,
  \`device:status\`, \`device:cmdack\`, \`device:command\`.

${routes.length} routes.
`;
for (const [name, rs] of groups) {
  md += `\n## ${name}\n\n| Method | Path | Who | Path params | Query | Body |\n|---|---|---|---|---|---|\n`;
  for (const r of rs)
    md += `| ${r.method.toUpperCase()} | \`${r.path}\` | ${who(r)} | ${fields(r.params)} | ${fields(r.query)} | ${fields(r.body)} |\n`;
}

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== md) {
    console.error('docs/API.md is stale: run `npm --prefix backend run docs:api`');
    process.exit(1);
  }
  console.log('docs/API.md is up to date');
} else {
  fs.writeFileSync(OUT, md);
  console.log(`wrote ${OUT} (${routes.length} routes)`);
}
