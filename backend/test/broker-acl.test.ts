import { describe, expect, it } from 'vitest';
import { allowed, parseAccounts } from '../src/scripts/broker-acl';

const P = 'coldchain/v1';
const t = (device: string, kind: string) => `${P}/${device}/${kind}`;

describe('broker ACL (same rules as infra/mosquitto/acl)', () => {
  it('a device publishes only its own uplink and reads only its own commands', () => {
    for (const kind of ['telemetry', 'event', 'sync', 'cmdack', 'status'])
      expect(allowed('fridge-01', 'write', t('fridge-01', kind), P)).toBe(true);
    expect(allowed('fridge-01', 'write', t('fridge-02', 'telemetry'), P)).toBe(false); // speak as another
    expect(allowed('fridge-01', 'write', t('fridge-01', 'cmd'), P)).toBe(false); // forge a command
    expect(allowed('fridge-01', 'read', t('fridge-01', 'cmd'), P)).toBe(true);
    expect(allowed('fridge-01', 'read', t('fridge-01', 'ack'), P)).toBe(true);
    expect(allowed('fridge-01', 'read', t('fridge-02', 'cmd'), P)).toBe(false);
    expect(allowed('fridge-01', 'read', t('+', 'cmd'), P)).toBe(false); // no wildcard snooping
    expect(allowed('fridge-01', 'read', t('fridge-01', 'telemetry'), P)).toBe(false);
  });

  it('the backend reads every uplink and writes commands and acks', () => {
    for (const kind of ['telemetry', 'event', 'sync', 'cmdack', 'status'])
      expect(allowed('backend', 'read', t('+', kind), P)).toBe(true);
    expect(allowed('backend', 'write', t('fridge-02', 'cmd'), P)).toBe(true);
    expect(allowed('backend', 'write', t('fridge-02', 'ack'), P)).toBe(true);
    expect(allowed('backend', 'write', t('fridge-02', 'telemetry'), P)).toBe(false);
    expect(allowed('backend', 'write', t('+', 'cmd'), P)).toBe(false); // a publish names one device
  });

  it('the dev/test account may inject uplink messages but never commands', () => {
    expect(allowed('coldchain', 'write', t('fridge-99', 'telemetry'), P)).toBe(true); // attack demos
    expect(allowed('coldchain', 'write', t('fridge-01', 'cmd'), P)).toBe(false);
    expect(allowed('coldchain', 'read', t('+', 'status'), P)).toBe(true);
    expect(allowed('coldchain', 'read', t('+', 'telemetry'), P)).toBe(false);
  });

  it('refuses other prefixes, multi-level wildcards, extra levels and unknown accounts', () => {
    expect(allowed('backend', 'read', `${P}/#`, P)).toBe(false);
    expect(allowed('backend', 'read', 'other/v1/+/telemetry', P)).toBe(false);
    expect(allowed('backend', 'read', `${P}/+/+`, P)).toBe(false);
    expect(allowed('fridge-01', 'write', `${P}/fridge-01/telemetry/x`, P)).toBe(false);
    expect(allowed('mallory', 'write', t('mallory', 'cmd'), P)).toBe(false);
    expect(allowed('healthcheck', 'write', `${P}/healthcheck/ping`, P)).toBe(true);
    expect(allowed('healthcheck', 'read', `${P}/healthcheck/ping`, P)).toBe(false); // probe only publishes
    expect(allowed('healthcheck', 'write', t('+', 'telemetry'), P)).toBe(false);
  });

  it('works with a deeper topic prefix', () => {
    const deep = 'coldchain/v1/site-a';
    expect(allowed('fridge-01', 'write', `${deep}/fridge-01/telemetry`, deep)).toBe(true);
    expect(allowed('fridge-01', 'write', `${deep}/fridge-01/telemetry`, P)).toBe(false);
  });

  it('parses BROKER_ACCOUNTS', () => {
    expect(parseAccounts(undefined).size).toBe(0);
    expect(parseAccounts('backend:a:b,fridge-01:x')).toEqual(
      new Map([
        ['backend', 'a:b'], // the first colon splits: passwords may contain colons
        ['fridge-01', 'x'],
      ]),
    );
    expect(() => parseAccounts('nopassword')).toThrow(/BROKER_ACCOUNTS/);
  });
});
