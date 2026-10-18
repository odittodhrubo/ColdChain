// npm run broker: a local MQTT broker for development, demos and the scenario tests, when neither Docker
// (mosquitto in infra/docker-compose.yml) nor a hosted broker is at hand. Plain TCP, optional username/password
// (MQTT_USERNAME / MQTT_PASSWORD), retained messages and last wills like mosquitto. Not for production.
import { createServer } from 'node:net';
import { createBroker } from 'aedes';

const port = Number(process.env.BROKER_PORT ?? 1883);
const user = process.env.MQTT_USERNAME || '';
const pass = process.env.MQTT_PASSWORD || '';

const broker = createBroker();
if (user)
  broker.authenticate = (_client, username, password, done) =>
    done(null, username === user && password?.toString() === pass);

const server = createServer(broker.handle);
server.listen(port, '127.0.0.1', () =>
  console.log(`mqtt broker on mqtt://127.0.0.1:${port}${user ? ' (auth on)' : ''}`),
);
const stop = () => broker.close(() => server.close(() => process.exit(0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
