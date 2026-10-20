// Broker topic permissions (S4): the same rules as infra/mosquitto/acl, enforced by the dev broker
// (broker.ts) when BROKER_ACCOUNTS is set. HMAC already stops forged data from being *accepted*; these rules
// stop it at the broker and keep a stolen device password to that one device's topics.
//
// Topics are {prefix}/{device_id}/{kind}. Accounts:
//   backend      reads every device's uplink, writes cmd / ack to any device
//   <device id>  writes its own uplink, reads its own cmd / ack (fridge-01 can never speak as fridge-02)
//   coldchain    dev/test tools only (virtual node, attack demos): writes any device's uplink, reads cmd /
//                ack / status. It models a leaked broker credential, so the app-layer checks still get tested.
//   healthcheck  writes {prefix}/healthcheck/ping (a liveness probe; this image withholds $SYS)

export const UPLINK = ['telemetry', 'event', 'sync', 'cmdack', 'status'];
export const DOWNLINK = ['cmd', 'ack'];
export const HEALTH_SUBTOPIC = 'healthcheck/ping'; // relative to the prefix; the container liveness probe

export type Access = 'read' | 'write';

/** May `user` publish (write) to, or subscribe (read) to, `topic`? `topic` may be a subscription filter. */
export function allowed(user: string, access: Access, topic: string, prefix: string): boolean {
  if (user === 'healthcheck') return access === 'write' && topic === `${prefix}/${HEALTH_SUBTOPIC}`;
  if (!topic.startsWith(`${prefix}/`)) return false;
  const rest = topic.slice(prefix.length + 1).split('/');
  if (rest.length !== 2) return false; // no '#', no extra levels
  const [device, kind] = rest;
  if (!device || !kind || kind.includes('+') || kind.includes('#') || device.includes('#')) return false;
  const anyDevice = device === '+';
  if (anyDevice && access === 'write') return false; // a publish names one device

  if (user === 'backend') return access === 'read' ? UPLINK.includes(kind) : DOWNLINK.includes(kind);
  if (user === 'coldchain')
    return access === 'write' ? UPLINK.includes(kind) : [...DOWNLINK, 'status'].includes(kind);
  // a device account: only its own topics
  if (device !== user) return false;
  return access === 'write' ? UPLINK.includes(kind) : DOWNLINK.includes(kind);
}

/** "user:password,user:password" (BROKER_ACCOUNTS) -> Map. Empty -> no accounts (anonymous dev broker). */
export function parseAccounts(spec: string | undefined): Map<string, string> {
  const accounts = new Map<string, string>();
  for (const item of (spec ?? '').split(',').filter(Boolean)) {
    const i = item.indexOf(':');
    if (i <= 0) throw new Error(`BROKER_ACCOUNTS: expected user:password, got "${item}"`);
    accounts.set(item.slice(0, i), item.slice(i + 1));
  }
  return accounts;
}
