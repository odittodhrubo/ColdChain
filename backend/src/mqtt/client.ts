import os from 'node:os';
import mqtt from 'mqtt';
import type { Config } from '../config';
import { logger } from '../shared/logger';
import type { Ingestor } from './ingest';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export interface MqttHandle {
  stop: () => Promise<void>;
  connected: () => boolean;
  publish: (topic: string, payload: string) => void; // raw publish (demo simulation controls, P-sim)
}

/** One backend per client id: a second client with the same id would take the session over. */
export const mqttClientId = (config: Config) =>
  config.MQTT_CLIENT_ID ?? `coldchain-backend-${os.hostname()}-${config.PORT}`;

/** Connection options: a persistent session (clean: false) under a stable client id, so the broker keeps the
 * subscriptions and queues QoS 1 messages for the backend while it restarts. */
export function mqttOptions(config: Config): mqtt.IClientOptions {
  return {
    clientId: mqttClientId(config),
    username: config.MQTT_USERNAME || undefined,
    password: config.MQTT_PASSWORD || undefined,
    reconnectPeriod: BACKOFF_MIN_MS,
    connectTimeout: 10_000,
    clean: false,
  };
}

/**
 * Connects to the broker (TLS for mqtts://), subscribes to every device's data topics and feeds the ingestor.
 * Reconnects with exponential backoff (1 s doubling to 30 s).
 */
export function startMqtt(config: Config, ingest: Ingestor): MqttHandle {
  const prefix = config.MQTT_TOPIC_PREFIX;
  const client = mqtt.connect(config.MQTT_URL, mqttOptions(config));
  ingest.setPublisher((topic, payload) => client.publish(topic, payload, { qos: 1 }));

  client.on('connect', (ack) => {
    client.options.reconnectPeriod = BACKOFF_MIN_MS;
    // A resumed session already has the subscriptions; subscribing again is harmless and covers a broker that
    // lost its state (restart without persistence).
    const topics = ['telemetry', 'event', 'sync', 'cmdack', 'status'].map((k) => `${prefix}/+/${k}`);
    client.subscribe(topics, { qos: 1 }, (err) => {
      if (err) logger.error({ err: err.message }, 'mqtt subscribe failed');
      else
        logger.info(
          { url: config.MQTT_URL.replace(/\/\/[^@]*@/, '//'), prefix, sessionPresent: ack.sessionPresent },
          'mqtt connected',
        );
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

  return {
    stop: () => client.endAsync(),
    connected: () => client.connected,
    publish: (topic, payload) => void client.publish(topic, payload, { qos: 0 }),
  };
}
