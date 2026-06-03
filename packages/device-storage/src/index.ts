import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DeviceSecretRecord {
  privateKeyPem: string;
  publicKeyPem: string;
  createdAt: string;
}

export interface DeviceStorage {
  readIdentity(): Promise<DeviceSecretRecord | null>;
  writeIdentity(record: DeviceSecretRecord): Promise<void>;
}

export class DevFileDeviceStorage implements DeviceStorage {
  constructor(private readonly filePath: string) {}

  async readIdentity(): Promise<DeviceSecretRecord | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DeviceSecretRecord>;
      if (
        typeof parsed.privateKeyPem !== 'string' ||
        typeof parsed.publicKeyPem !== 'string' ||
        typeof parsed.createdAt !== 'string'
      ) {
        return null;
      }
      return {
        privateKeyPem: parsed.privateKeyPem,
        publicKeyPem: parsed.publicKeyPem,
        createdAt: parsed.createdAt,
      };
    } catch {
      return null;
    }
  }

  async writeIdentity(record: DeviceSecretRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // Dev-only scaffold storage. The production agent should move this
    // into OS keychain / encrypted storage before rollout.
    await writeFile(this.filePath, JSON.stringify(record, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
