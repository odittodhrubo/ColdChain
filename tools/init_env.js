#!/usr/bin/env node
// Create .env from .env.example with fresh random JWT_SECRET, APP_SECRET_KEY and device secrets.
// Refuses to overwrite an existing .env unless --force is given.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, '.env');

if (fs.existsSync(target) && !process.argv.includes('--force')) {
  console.error('.env already exists; pass --force to overwrite it.');
  process.exit(1);
}

const env = fs
  .readFileSync(path.join(root, '.env.example'), 'utf8')
  .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${crypto.randomBytes(48).toString('hex')}`)
  .replace(/^APP_SECRET_KEY=.*$/m, `APP_SECRET_KEY=${crypto.randomBytes(32).toString('hex')}`)
  .replace(/^(DEVICE_SECRET_[A-Z0-9_]+)=.*$/gm, (_, k) => `${k}=${crypto.randomBytes(32).toString('hex')}`);

fs.writeFileSync(target, env);
console.log('wrote .env (JWT_SECRET, APP_SECRET_KEY and device secrets generated; fill in MQTT and alert settings)');
