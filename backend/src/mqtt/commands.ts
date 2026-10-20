import { randomUUID } from 'node:crypto';
import type { Db } from '../db';
import type { Realtime } from '../realtime';
import { TOPICS } from '../shared/constants';
import { logger } from '../shared/logger';
import type { DeviceRegistry } from './devices';
import { buildEnvelope } from './envelope';

export type Publish = (topic: string, payload: string) => void;
export type CommandType =
  | 'RESET_LATCH'
  | 'SET_LATCH'
  | 'BUZZER_TEST'
  | 'SYNC_REQUEST'
  | 'ROTATE_SECRET'
  | 'SET_CALIBRATION';

export const topicFor = (prefix: string, deviceId: string, kind: keyof typeof TOPICS) =>
  TOPICS[kind].replace('{prefix}', prefix).replace('{device_id}', deviceId);

/** Signed server -> device messages: commands and sync acks, each with a fresh server nonce and current ts. */
export interface SentCommand {
  cmdId: string;
  deviceId: string;
  type: CommandType;
  args: Record<string, unknown>;
}

export class DeviceSender {
  onCommand?: (c: SentCommand) => void; // command tracking (P12) records every command sent

  constructor(
    private readonly prefix: string,
    private readonly devices: DeviceRegistry,
    private publish: Publish,
  ) {}

  setPublisher(publish: Publish) {
    this.publish = publish;
  }

  /** Each call is a new signed envelope (fresh nonce and ts); a retry passes the same cmdId. */
  command(
    deviceId: string,
    type: CommandType,
    args: Record<string, unknown> = {},
    cmdId: string = randomUUID(),
  ): string | null {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    const body = JSON.stringify({ cmd_id: cmdId, type, args });
    this.publish(topicFor(this.prefix, deviceId, 'cmd'), buildEnvelope(device.secret, deviceId, 'cmd', body));
    logger.info({ deviceId, type, cmdId }, 'command sent');
    this.onCommand?.({ cmdId, deviceId, type, args });
    return cmdId;
  }

  ack(deviceId: string, seqUpto: number): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    const body = JSON.stringify({ seq_upto: seqUpto });
    this.publish(topicFor(this.prefix, deviceId, 'ack'), buildEnvelope(device.secret, deviceId, 'ack', body));
  }
}

export const CMD_RETRY_MS = 5000;
export const CMD_ATTEMPTS = 3;
export const CMD_STALE_MS = 60_000; // commands sent outside send() (heat engine, sync requests) time out here

export type CommandStatus = 'PENDING' | 'ACKED' | 'FAILED' | 'TIMEOUT';

export interface CommandRow {
  cmd_id: string;
  device_id: string;
  type: CommandType;
  args: Record<string, unknown>;
  status: CommandStatus;
  attempts: number;
  detail: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Command publisher (P12): every signed command is recorded in pending_commands (whoever sent it) and closed by
 * the device's signed cmdack. Commands sent through send() are retried with the same cmd_id and a fresh
 * envelope every 5 s, 3 attempts in all, then marked TIMEOUT.
 */
export class CommandTracker {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly sql;

  constructor(
    db: Db,
    private readonly sender: DeviceSender,
    private readonly realtime: Realtime,
    private readonly opts = { retryMs: CMD_RETRY_MS, attempts: CMD_ATTEMPTS },
  ) {
    this.sql = {
      record: db.prepare(
        `INSERT INTO pending_commands (cmd_id, device_id, type, args, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (cmd_id) DO UPDATE SET attempts = attempts + 1, updated_at = excluded.updated_at`,
      ),
      get: db.prepare('SELECT * FROM pending_commands WHERE cmd_id = ?'),
      close: db.prepare(
        "UPDATE pending_commands SET status = ?, detail = ?, updated_at = ? WHERE cmd_id = ? AND device_id = ? AND status = 'PENDING'",
      ),
      timeout: db.prepare(
        "UPDATE pending_commands SET status = 'TIMEOUT', updated_at = ? WHERE cmd_id = ? AND status = 'PENDING'",
      ),
      stale: db.prepare(
        "UPDATE pending_commands SET status = 'TIMEOUT', updated_at = ? WHERE status = 'PENDING' AND updated_at < ?",
      ),
    };
    sender.onCommand = (c) =>
      this.sql.record.run(c.cmdId, c.deviceId, c.type, JSON.stringify(c.args), Date.now(), Date.now());
  }

  get(cmdId: string): CommandRow | null {
    const row = this.sql.get.get(cmdId) as (Omit<CommandRow, 'args'> & { args: string }) | undefined;
    return row ? { ...row, args: JSON.parse(row.args) } : null;
  }

  send(deviceId: string, type: CommandType, args: Record<string, unknown> = {}): string | null {
    const cmdId = this.sender.command(deviceId, type, args);
    if (cmdId) this.schedule(cmdId, deviceId, type, args, 1);
    return cmdId;
  }

  private schedule(
    cmdId: string,
    deviceId: string,
    type: CommandType,
    args: Record<string, unknown>,
    attempt: number,
  ) {
    const timer = setTimeout(() => {
      this.timers.delete(cmdId);
      if ((this.sql.get.get(cmdId) as { status: CommandStatus } | undefined)?.status !== 'PENDING') return;
      if (attempt < this.opts.attempts) {
        this.sender.command(deviceId, type, args, cmdId); // same cmd_id, fresh nonce and ts
        this.schedule(cmdId, deviceId, type, args, attempt + 1);
      } else {
        this.sql.timeout.run(Date.now(), cmdId);
        this.realtime.emit('device:command', this.get(cmdId));
      }
    }, this.opts.retryMs);
    timer.unref?.();
    this.timers.set(cmdId, timer);
  }

  /** Ingest hook: the device's signed cmdack closes the command. */
  onAck(deviceId: string, ack: { cmd_id: string; ok: boolean; detail: string }) {
    if (
      this.sql.close.run(ack.ok ? 'ACKED' : 'FAILED', ack.detail, Date.now(), ack.cmd_id, deviceId).changes
    ) {
      clearTimeout(this.timers.get(ack.cmd_id));
      this.timers.delete(ack.cmd_id);
      this.realtime.emit('device:command', this.get(ack.cmd_id));
    }
  }

  sweep(nowMs = Date.now()) {
    return this.sql.stale.run(nowMs, nowMs - CMD_STALE_MS).changes;
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
