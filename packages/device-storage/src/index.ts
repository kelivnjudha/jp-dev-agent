import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  BranchDeviceBranchSummary,
  BranchDeviceStatusValue,
  DeviceCapability,
  PendingDeviceRegistrationState,
} from '@jade-dev-agent/protocol';
import { DEVICE_CAPABILITIES } from '@jade-dev-agent/protocol';

export interface DeviceSecretRecord {
  privateKeyPem: string;
  publicKeyPem: string;
  hardwareFingerprintHash?: string;
  safeHidPrefix?: string;
  createdAt: string;
}

export interface DeviceStorage {
  readIdentity(): Promise<DeviceSecretRecord | null>;
  writeIdentity(record: DeviceSecretRecord): Promise<void>;
  readPendingDevice(): Promise<PendingDeviceRegistrationState | null>;
  writePendingDevice(record: PendingDeviceRegistrationState): Promise<void>;
}

export class DevFileDeviceStorage implements DeviceStorage {
  constructor(
    private readonly filePath: string,
    private readonly pendingFilePath = filePath.replace(/\.json$/i, '.pending.json'),
  ) {}

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
        ...(typeof parsed.hardwareFingerprintHash === 'string'
          ? { hardwareFingerprintHash: parsed.hardwareFingerprintHash }
          : {}),
        ...(typeof parsed.safeHidPrefix === 'string'
          ? { safeHidPrefix: parsed.safeHidPrefix }
          : {}),
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

  async readPendingDevice(): Promise<PendingDeviceRegistrationState | null> {
    try {
      const raw = await readFile(this.pendingFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsePendingDeviceRecord(parsed);
    } catch {
      return null;
    }
  }

  async writePendingDevice(record: PendingDeviceRegistrationState): Promise<void> {
    await mkdir(dirname(this.pendingFilePath), { recursive: true });
    await writeFile(this.pendingFilePath, JSON.stringify(projectPendingDeviceRecord(record), null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

function projectPendingDeviceRecord(
  record: PendingDeviceRegistrationState,
): PendingDeviceRegistrationState {
  const out: PendingDeviceRegistrationState = {
    deviceId: record.deviceId,
    serverStatus: record.serverStatus,
    branch: projectBranchSummary(record.branch),
    allowedCapabilities: record.allowedCapabilities.filter(isDeviceCapability),
    safeHidPrefix: record.safeHidPrefix,
    claimedAt: record.claimedAt,
  };
  if (record.deviceLabel !== undefined) out.deviceLabel = record.deviceLabel;
  return out;
}

function parsePendingDeviceRecord(
  value: Record<string, unknown>,
): PendingDeviceRegistrationState | null {
  if (
    typeof value.deviceId !== 'string' ||
    typeof value.serverStatus !== 'string' ||
    typeof value.safeHidPrefix !== 'string' ||
    typeof value.claimedAt !== 'string' ||
    !Array.isArray(value.allowedCapabilities)
  ) {
    return null;
  }
  const capabilities = value.allowedCapabilities.filter(isDeviceCapability);
  if (capabilities.length !== value.allowedCapabilities.length) return null;

  const out: PendingDeviceRegistrationState = {
    deviceId: value.deviceId,
    serverStatus: value.serverStatus as BranchDeviceStatusValue,
    branch: parseBranchSummary(value.branch),
    allowedCapabilities: capabilities,
    safeHidPrefix: value.safeHidPrefix,
    claimedAt: value.claimedAt,
  };
  if (typeof value.deviceLabel === 'string') out.deviceLabel = value.deviceLabel;
  return out;
}

function projectBranchSummary(
  branch: BranchDeviceBranchSummary | null,
): BranchDeviceBranchSummary | null {
  if (!branch) return null;
  return {
    id: branch.id,
    code: branch.code,
    name: branch.name,
  };
}

function parseBranchSummary(value: unknown): BranchDeviceBranchSummary | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const branch = value as Record<string, unknown>;
  if (typeof branch.id !== 'string') return null;
  return {
    id: branch.id,
    code: typeof branch.code === 'string' ? branch.code : null,
    name: typeof branch.name === 'string' ? branch.name : null,
  };
}

function isDeviceCapability(value: unknown): value is DeviceCapability {
  return typeof value === 'string' && DEVICE_CAPABILITIES.includes(value as DeviceCapability);
}
