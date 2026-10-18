import { randomBytes } from 'node:crypto';
import mqtt from 'mqtt';
import type { Config } from '../config';
import { logger } from '../shared/logger';
import type { Ingestor } from './ingest';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Connects to the broker (TLS for mqtts://), subscribes to every device's data topics and feeds the ingestor.
 * Reconnects with exponential backoff (1 s doubling to 30 s). Returns a stop function.
 */
export function startMqtt(config: Config, ingest: Ingestor): () => Promise<void> {
  const prefix = config.MQTT_TOPIC_PREFIX;
  const client = mqtt.connect(config.MQTT_URL, {
    clientId: `coldchain-backend-${randomBytes(4).toString('hex')}`,
    username: config.MQTT_USERNAME || undefined,
    password: config.MQTT_PASSWORD || undefined,
    reconnectPeriod: BACKOFF_MIN_MS,
    connectTimeout: 10_000,
    clean: true,
  });
  ingest.setPublisher((topic, payload) => client.publish(topic, payload, { qos: 1 }));

  client.on('connect', () => {
    client.options.reconnectPeriod = BACKOFF_MIN_MS;
    const topics = ['telemetry', 'event', 'sync', 'cmdack', 'status'].map((k) => `${prefix}/+/${k}`);
    client.subscribe(topics, { qos: 1 }, (err) => {
      if (err) logger.error({ err: err.message }, 'mqtt subscribe failed');
      else logger.info({ url: config.MQTT_URL.replace(/\/\/[^@]*@/, '//'), prefix }, 'mqtt connected');
    });
  });
  client.on('close', () => {
    client.options.reconnectPeriod = Math.min(
      (client.options.reconnectPeriod ?? BACKOFF_MIN_MS) * 2,
      BACKOFF_MAX_MS,
    );
  });
  client.on('error', (err) => logger.warn({ err: err.message }, 'mqtt error'));
  client.on('message', (topic, payload) => {
    try {
      ingest.handle(topic, payload);
    } catch (err) {
      logger.error({ err, topic }, 'ingest failed'); // one bad message must never stop the subscription
    }
  });

  return () => client.endAsync();
}
