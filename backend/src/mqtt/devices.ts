import type { Db } from '../db';
import { decryptSecret } from '../shared/secretbox';

export interface Device {
  deviceId: string;
  fridgeId: string;
  secret: string;
}

/**
 * Known, active devices with their decrypted secrets, cached in memory (decrypting per message would cost a
 * GCM decrypt each time). The cache is short-lived so a disabled device stops being accepted within seconds.
 */
export class DeviceRegistry {
  private cache = new Map<string, { device: Device | null; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly appSecretKey: string,
    private readonly ttlMs = 10_000,
  ) {}

  get(deviceId: string, now = Date.now()): Device | null {
    const hit = this.cache.get(deviceId);
    if (hit && now - hit.at < this.ttlMs) return hit.device;
    const row = this.db
      .prepare('SELECT device_id, fridge_id, secret_enc FROM devices WHERE device_id = ? AND active = 1')
      .get(deviceId) as { device_id: string; fridge_id: string; secret_enc: string } | undefined;
    const device = row
      ? {
          deviceId: row.device_id,
          fridgeId: row.fridge_id,
          secret: decryptSecret(row.secret_enc, this.appSecretKey),
        }
      : null;
    this.cache.set(deviceId, { device, at: now });
    return device;
  }

  invalidate(deviceId?: string) {
    if (deviceId) this.cache.delete(deviceId);
    else this.cache.clear();
  }
}
