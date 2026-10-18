// Starts the real ML service for the Playwright run, with the repo venv's Python (Windows or POSIX layout).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '../..');
const python =
  [path.join(root, '.venv/Scripts/python.exe'), path.join(root, '.venv/bin/python')].find(existsSync) ??
  'python';
const port = process.env.ML_PORT ?? '8310';
const child = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', port], {
  cwd: path.join(root, 'ml'),
  stdio: 'inherit',
});
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
