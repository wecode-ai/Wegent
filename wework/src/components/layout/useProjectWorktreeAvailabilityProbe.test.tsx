import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeWorktreeCapabilitiesResponse,
} from '@/types/api'
import type { ProjectWorktreeAvailabilityApi } from '@/lib/worktree-availability'
import { useProjectWorktreeAvailabilityProbe } from './useProjectWorktreeAvailabilityProbe'

function createProject(): ProjectWithTasks {
  return {
    id: 1,
    name: 'Wegent',
    config: { mode: 'workspace' },
  }
}

function createWorkspace(): RuntimeDeviceWorkspace {
  return {
    id: 10,
    projectId: 1,
    deviceId: 'cloud-device',
    deviceStatus: 'online',
    available: true,
    workspacePath: '/workspace/wegent',
    workspaceKind: 'workspace',
    workspaceSource: 'remote',
    repoRootFingerprint: 'repo-fingerprint',
    tasks: [],
  }
}

function createDevice(): DeviceInfo {
  return {
    id: 2,
    device_id: 'cloud-device',
    name: 'Cloud Executor',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    runtime_features: {
      schemaVersion: 1,
      worktrees: {
        version: 1,
        managed: true,
        deferredPrepare: true,
        snapshots: true,
        restore: true,
        preflight: true,
        persistentStorageVerified: true,
      },
    },
  }
}

describe('useProjectWorktreeAvailabilityProbe', () => {
  test('keeps an in-flight probe when runtime polling replaces equivalent objects', async () => {
    let resolveCapabilities: ((response: RuntimeWorktreeCapabilitiesResponse) => void) | undefined
    const capabilities = new Promise<RuntimeWorktreeCapabilitiesResponse>(resolve => {
      resolveCapabilities = resolve
    })
    const api: ProjectWorktreeAvailabilityApi = {
      getWorktreeCapabilities: vi.fn().mockReturnValue(capabilities),
      preflightWorktree: vi.fn().mockResolvedValue({
        success: true,
        deviceId: 'cloud-device',
        supported: true,
        sourcePath: '/workspace/wegent',
        sourceExists: true,
        sourceDirectory: true,
        gitRepository: true,
        gitCommonDirValid: true,
        gitCommonDirWritable: true,
        writable: true,
        repoRoot: '/workspace/wegent',
        repoRootFingerprint: 'repo-fingerprint',
        resolvedWorktreeRoot: '/executor/workspace/worktrees',
      }),
    }
    const project = createProject()
    const workspace = createWorkspace()
    const device = createDevice()
    const { result, rerender } = renderHook(props => useProjectWorktreeAvailabilityProbe(props), {
      initialProps: {
        api,
        device,
        enabled: true,
        key: 'stable-probe',
        project,
        ref: null,
        workspace,
      },
    })

    await waitFor(() => expect(api.getWorktreeCapabilities).toHaveBeenCalledTimes(1))

    rerender({
      api,
      device: { ...device },
      enabled: true,
      key: 'stable-probe',
      project: { ...project },
      ref: null,
      workspace: { ...workspace },
    })

    await act(async () => {
      resolveCapabilities?.({
        success: true,
        deviceId: 'cloud-device',
        runtimeWorktrees: device.runtime_features?.worktrees ?? null,
      })
      await capabilities
    })

    await waitFor(() => expect(result.current?.availability.reason).toBe('available'))
    expect(api.getWorktreeCapabilities).toHaveBeenCalledTimes(1)
    expect(api.preflightWorktree).toHaveBeenCalledTimes(1)
  })
})
