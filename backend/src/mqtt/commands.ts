import { randomUUID } from 'node:crypto';
import { TOPICS } from '../shared/constants';
import { logger } from '../shared/logger';
import type { DeviceRegistry } from './devices';
import { buildEnvelope } from './envelope';

export type Publish = (topic: string, payload: string) => void;
export type CommandType = 'RESET_LATCH' | 'SET_LATCH' | 'BUZZER_TEST' | 'SYNC_REQUEST';

export const topicFor = (prefix: string, deviceId: string, kind: keyof typeof TOPICS) =>
  TOPICS[kind].replace('{prefix}', prefix).replace('{device_id}', deviceId);

/** Signed server -> device messages: commands and sync acks, each with a fresh server nonce and current ts. */
export class DeviceSender {
  constructor(
    private readonly prefix: string,
    private readonly devices: DeviceRegistry,
    private publish: Publish,
  ) {}

  setPublisher(publish: Publish) {
    this.publish = publish;
  }

  command(deviceId: string, type: CommandType, args: Record<string, unknown> = {}): string | null {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    const cmdId = randomUUID();
    const body = JSON.stringify({ cmd_id: cmdId, type, args });
    this.publish(topicFor(this.prefix, deviceId, 'cmd'), buildEnvelope(device.secret, deviceId, 'cmd', body));
    logger.info({ deviceId, type, cmdId }, 'command sent');
    return cmdId;
  }

  ack(deviceId: string, seqUpto: number): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    const body = JSON.stringify({ seq_upto: seqUpto });
    this.publish(topicFor(this.prefix, deviceId, 'ack'), buildEnvelope(device.secret, deviceId, 'ack', body));
  }
}
