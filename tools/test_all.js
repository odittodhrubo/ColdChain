#!/usr/bin/env node
// Run every test suite in the monorepo and fail if any fails. Used by `make test` / `npm test`.
// A service with zero tests fails too: vitest and pytest both exit non-zero when nothing is collected.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
// Prefer tools from the repo venv (`make setup`), then fall back to PATH.
const venvBin = (name) =>
  [path.join(root, '.venv', 'Scripts', `${name}.exe`), path.join(root, '.venv', 'bin', name)].find((p) =>
    fs.existsSync(p),
  );
const quoted = (p) => p && `"${p}"`;
const has = (cmd) => spawnSync(cmd, ['--version'], { shell: true, stdio: 'ignore' }).status === 0;
const py = quoted(venvBin('python')) ?? (process.platform === 'win32' ? 'python' : 'python3');
const pio = quoted(venvBin('pio')) ?? ['pio', 'platformio'].find(has);

const suites = [
  ['contracts: generated constants fresh', `${py} tools/gen_constants.py --check`, root],
  ['contracts: test vectors fresh', 'node tools/gen_vectors.js --check', root],
  ['backend', 'npm test', path.join(root, 'backend')],
  ['frontend', 'npm test', path.join(root, 'frontend')],
  ['ml', `${py} -m pytest -q`, path.join(root, 'ml')],
  ['tools', `${py} -m pytest -q`, path.join(root, 'tools')],
];
if (pio) suites.push(['firmware (native)', `${pio} test -e native`, path.join(root, 'firmware', 'fridge-node')]);

const results = suites.map(([name, cmd, cwd]) => {
  console.log(`\n=== ${name}: ${cmd}`);
  return [name, spawnSync(cmd, { cwd, shell: true, stdio: 'inherit' }).status === 0];
});

console.log('\n=== summary');
for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
if (!pio) {
  console.log('SKIPPED  firmware (native): PlatformIO CLI not found. Install it to run firmware tests.');
  if (process.argv.includes('--strict')) results.push(['firmware', false]);
}
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
