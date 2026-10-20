// npm run broker: a local MQTT broker for development, demos and the scenario tests, when neither Docker
// (mosquitto in infra/docker-compose.yml) nor a hosted broker is at hand. Plain TCP on 127.0.0.1, retained
// messages and last wills like mosquitto. Not for production.
//
// Accounts, any one of:
//   none                              anonymous, every topic (the default dev setup)
//   MQTT_USERNAME / MQTT_PASSWORD     one shared account, every topic
//   BROKER_ACCOUNTS=user:pw,...       per-account topic rules (broker-acl.ts, the same as infra/mosquitto/acl)
import { createServer } from 'node:net';
import { type Client, createBroker } from 'aedes';
import { allowed, parseAccounts } from './broker-acl';

const port = Number(process.env.BROKER_PORT ?? 1883);
const prefix = process.env.MQTT_TOPIC_PREFIX || 'coldchain/v1';
const accounts = parseAccounts(process.env.BROKER_ACCOUNTS);
const shared = accounts.size ? undefined : process.env.MQTT_USERNAME || undefined;
const sharedPass = process.env.MQTT_PASSWORD || '';

const broker = createBroker();
const users = new WeakMap<Client, string>();

if (accounts.size) {
  broker.authenticate = (client, username, password, done) => {
    const ok = !!username && accounts.get(username) === password?.toString();
    if (ok) users.set(client, username!);
    done(null, ok);
  };
  broker.authorizePublish = (client, packet, done) => {
    const user = client ? users.get(client) : undefined;
    // client is null for the broker's own messages ($SYS); a will is published on the client's behalf
    if (!client || (user && allowed(user, 'write', packet.topic, prefix))) return done(null);
    done(new Error(`${user ?? '?'} may not publish to ${packet.topic}`));
  };
  broker.authorizeSubscribe = (client, sub, done) => {
    const user = users.get(client);
    done(null, user && allowed(user, 'read', sub.topic, prefix) ? sub : null); // null: SUBACK 0x80 (refused)
  };
} else if (shared) {
  broker.authenticate = (_client, username, password, done) =>
    done(null, username === shared && password?.toString() === sharedPass);
}

const server = createServer(broker.handle);
server.listen(port, '127.0.0.1', () => {
  const mode = accounts.size ? ` (ACL, ${accounts.size} accounts)` : shared ? ' (auth on)' : '';
  console.log(`mqtt broker on mqtt://127.0.0.1:${port}${mode}`);
});
const stop = () => broker.close(() => server.close(() => process.exit(0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
