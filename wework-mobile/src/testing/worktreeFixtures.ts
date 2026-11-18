import type { DeviceInfo, RuntimeDeviceWorkspace } from '@/types/runtime'
import type { RuntimeWorktreePreflightResponse } from '../../../packages/chat-core/src/worktree-types'
import type { RuntimeWorktreeCapability } from '../../../packages/chat-core/src/execution-project'

export const worktreeCapability: RuntimeWorktreeCapability = {
  version: 1,
  managed: true,
  deferredPrepare: true,
  snapshots: true,
  restore: true,
  preflight: true,
  persistentStorageVerified: true,
}

export const worktreeDevice: DeviceInfo = {
  id: 1,
  device_id: 'cloud',
  name: 'Cloud',
  status: 'online',
  device_type: 'cloud',
  bind_shell: 'claudecode',
  runtime_features: { schemaVersion: 1, worktrees: worktreeCapability },
}

export const worktreeWorkspace: RuntimeDeviceWorkspace = {
  deviceId: 'cloud',
  deviceName: 'Cloud',
  deviceStatus: 'online',
  available: true,
  workspacePath: '/workspace/repo',
  workspaceKind: 'workspace',
  tasks: [],
  repoRootFingerprint: 'repository',
}

export function worktreePreflight(
  overrides: Partial<RuntimeWorktreePreflightResponse> = {}
): RuntimeWorktreePreflightResponse {
  return {
    success: true,
    deviceId: 'cloud',
    supported: true,
    sourcePath: '/workspace/repo',
    sourceExists: true,
    sourceDirectory: true,
    gitRepository: true,
    gitCommonDirValid: true,
    gitCommonDirWritable: true,
    writable: true,
    repoRoot: '/workspace/repo',
    gitCommonDir: '/workspace/repo/.git',
    repoRootFingerprint: 'repository',
    gitRef: null,
    currentBranch: 'main',
    resolvedWorktreeRoot: '/worktrees',
    refValid: true,
    ...overrides,
  }
}
