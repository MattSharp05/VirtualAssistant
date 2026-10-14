// Device keys for JARVIS Desk (ADR 0002). Each Mac pairs once from the dashboard and gets a random key,
// shown once. Only its SHA-256 is stored, so the devices file never holds a usable key.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DeviceInfo } from "@jarvis/shared";
import { JsonFile } from "../storage.js";

interface StoredDevice extends DeviceInfo {
  hash: string;
}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export class DeviceStore {
  private readonly file: JsonFile<{ devices: StoredDevice[] }>;
  private lastSeenWrite = new Map<string, number>();

  constructor(dataDir: string) {
    this.file = new JsonFile(dataDir, "devices", { devices: [] });
  }

  list(): DeviceInfo[] {
    return this.file.get().devices.map(({ hash: _hash, ...info }) => info);
  }

  /** Creates a device and returns its key. The key is never stored or shown again. */
  async pair(name: string): Promise<{ device: DeviceInfo; key: string }> {
    const clean = name.trim().slice(0, 60) || "Mac";
    const key = `jd_${randomBytes(32).toString("base64url")}`;
    const device: StoredDevice = { id: randomUUID(), name: clean, createdAt: new Date().toISOString(), hash: hash(key) };
    await this.file.update((v) => ({ devices: [...v.devices, device] }));
    const { hash: _hash, ...info } = device;
    return { device: info, key };
  }

  async revoke(id: string): Promise<boolean> {
    const before = this.file.get().devices.length;
    await this.file.update((v) => ({ devices: v.devices.filter((d) => d.id !== id) }));
    return this.file.get().devices.length < before;
  }

  /** The device for an `Authorization: Bearer <key>` header, or undefined. Updates lastSeen (at most once a minute). */
  verify(authorization: string | undefined): DeviceInfo | undefined {
    const m = /^Bearer\s+(\S+)$/.exec(authorization ?? "");
    if (!m) return undefined;
    const h = Buffer.from(hash(m[1]), "hex");
    const device = this.file.get().devices.find((d) => {
      const stored = Buffer.from(d.hash, "hex");
      return stored.length === h.length && timingSafeEqual(stored, h);
    });
    if (!device) return undefined;
    const now = Date.now();
    if (now - (this.lastSeenWrite.get(device.id) ?? 0) > 60_000) {
      this.lastSeenWrite.set(device.id, now);
      const at = new Date(now).toISOString();
      void this.file.update((v) => ({ devices: v.devices.map((d) => (d.id === device.id ? { ...d, lastSeen: at } : d)) }));
    }
    const { hash: _hash, ...info } = device;
    return info;
  }
}
