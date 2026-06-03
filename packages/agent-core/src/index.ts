import type {
  AgentRegistrationStatus,
  AgentMode,
  DeviceCapability,
  DeviceRegistrationSnapshot,
} from '@jade-dev-agent/protocol';

export interface AgentState {
  status: AgentRegistrationStatus;
  mode: AgentMode;
  capabilities: DeviceCapability[];
  setupCodeMasked?: string;
  deviceId?: string;
  message: string;
  updatedAt: string;
}

export function maskSetupCode(setupCode: string): string {
  const trimmed = setupCode.trim();
  if (trimmed.length <= 4) return '••••';
  return `${trimmed.slice(0, 4)}••••`;
}

export function createInitialAgentState(hasLocalIdentity: boolean): AgentState {
  const now = new Date().toISOString();
  if (hasLocalIdentity) {
    return {
      status: 'PENDING_ACTIVATION',
      mode: 'SETUP',
      capabilities: [],
      message: 'Local identity found. Waiting for server activation.',
      updatedAt: now,
    };
  }
  return {
    status: 'UNREGISTERED',
    mode: 'SETUP',
    capabilities: [],
    message: 'Enter a JP Admin setup code to claim this device.',
    updatedAt: now,
  };
}

export function enterSetupCode(
  state: AgentState,
  setupCode: string,
): AgentState {
  const trimmed = setupCode.trim();
  if (!trimmed) {
    return {
      ...state,
      status: 'ERROR',
      message: 'Setup code is required.',
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...state,
    status: 'SETUP_CODE_SUBMITTING',
    setupCodeMasked: maskSetupCode(trimmed),
    message: 'Setup code accepted locally. Claiming requires the future API.',
    updatedAt: new Date().toISOString(),
  };
}

export function mockSubmitSetupCodeForPendingActivation(
  state: AgentState,
  setupCode: string,
): AgentState {
  const entered = enterSetupCode(state, setupCode);
  if (entered.status === 'ERROR') return entered;
  return {
    ...entered,
    status: 'PENDING_ACTIVATION',
    deviceId: `dev-local-${Date.now().toString(36)}`,
    message:
      'DEV ONLY: setup code claim simulated. Waiting for mock activation.',
    updatedAt: new Date().toISOString(),
  };
}

export function mockActivateDevice(
  state: AgentState,
  capabilities: DeviceCapability[] = ['POS_TERMINAL'],
): AgentState {
  if (state.status !== 'PENDING_ACTIVATION') {
    return {
      ...state,
      status: 'ERROR',
      message: 'Device must be pending activation before mock activation.',
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...state,
    status: 'ACTIVE',
    mode: capabilities.includes('SHOP_CHECKPOINT') ? 'CHECKPOINT' : 'POS',
    capabilities,
    message: 'DEV ONLY: device marked active locally.',
    updatedAt: new Date().toISOString(),
  };
}

export function disableDevice(state: AgentState, reason = 'Disabled'): AgentState {
  return {
    ...state,
    status: 'DISABLED',
    message: reason,
    updatedAt: new Date().toISOString(),
  };
}

export function toRegistrationSnapshot(
  state: AgentState,
): DeviceRegistrationSnapshot {
  const snapshot: DeviceRegistrationSnapshot = {
    status: state.status,
    capabilities: [...state.capabilities],
    mode: state.mode,
    message: state.message,
    updatedAt: state.updatedAt,
  };

  if (state.setupCodeMasked !== undefined) {
    snapshot.setupCodeMasked = state.setupCodeMasked;
  }

  if (state.deviceId !== undefined) {
    snapshot.deviceId = state.deviceId;
  }

  return snapshot;
}
