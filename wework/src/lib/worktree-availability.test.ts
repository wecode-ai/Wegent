import { describe, expect, test, vi } from 'vitest'
import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeWorktreeCapabilitiesResponse,
  RuntimeWorktreePreflightResponse,
} from '@/types/api'
import {
  deviceSupportsManagedWorktrees,
  probeProjectWorktreeAvailability,
  resolveProjectWorktreeAvailability,
  worktreeWorkspaceDeviceId,
} from './worktree-availability'

function createProject(overrides: Partial<ProjectWithTasks> = {}): ProjectWithTasks {
  return {
    id: 1,
    name: 'Wegent',
    config: {
      mode: 'workspace',
      execution: {
        targetType: 'cloud',
        deviceId: 'cloud-device',
      },
      workspace: {
        source: 'device_path',
        localPath: '/workspace/wegent',
      },
    },
    ...overrides,
  }
}

function createWorkspace(overrides: Partial<RuntimeDeviceWorkspace> = {}): RuntimeDeviceWorkspace {
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
    ...overrides,
  }
}

function createDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
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
    ...overrides,
  }
}

function createCapabilities(
  overrides: Partial<NonNullable<RuntimeWorktreeCapabilitiesResponse['runtimeWorktrees']>> = {}
): RuntimeWorktreeCapabilitiesResponse {
  return {
    success: true,
    deviceId: 'cloud-device',
    runtimeWorktrees: {
      version: 1,
      managed: true,
      deferredPrepare: true,
      snapshots: true,
      restore: true,
      preflight: true,
      persistentStorageVerified: true,
      ...overrides,
    },
  }
}

function createPreflight(
  overrides: Partial<RuntimeWorktreePreflightResponse> = {}
): RuntimeWorktreePreflightResponse {
  return {
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
    ...overrides,
  }
}

describe('resolveProjectWorktreeAvailability', () => {
  test.each([
    ['supported capability', createDevice(), true],
    [
      'supported capability in a newer runtime feature envelope',
      createDevice({
        runtime_features: {
          ...createDevice().runtime_features!,
          schemaVersion: 2,
        },
      }),
      true,
    ],
    ['missing capability', createDevice({ runtime_features: null }), false],
    [
      'old capability version',
      createDevice({
        runtime_features: {
          schemaVersion: 1,
          worktrees: {
            version: 0,
            managed: true,
            deferredPrepare: true,
            snapshots: true,
            restore: true,
            preflight: true,
          },
        },
      }),
      false,
    ],
    [
      'unmanaged capability',
      createDevice({
        runtime_features: {
          schemaVersion: 1,
          worktrees: {
            version: 1,
            managed: false,
            deferredPrepare: true,
            snapshots: true,
            restore: true,
            preflight: true,
          },
        },
      }),
      false,
    ],
    [
      'capability without preflight',
      createDevice({
        runtime_features: {
          schemaVersion: 1,
          worktrees: {
            version: 1,
            managed: true,
            deferredPrepare: true,
            snapshots: true,
            restore: true,
            preflight: false,
          },
        },
      }),
      false,
    ],
    [
      'cloud capability without verified persistent storage',
      createDevice({
        runtime_features: {
          schemaVersion: 1,
          worktrees: {
            version: 1,
            managed: true,
            deferredPrepare: true,
            snapshots: true,
            restore: true,
            preflight: true,
          },
        },
      }),
      false,
    ],
    [
      'local capability without persistent storage attestation',
      createDevice({
        device_type: 'local',
        runtime_features: {
          schemaVersion: 1,
          worktrees: {
            version: 1,
            managed: true,
            deferredPrepare: true,
            snapshots: true,
            restore: true,
            preflight: true,
          },
        },
      }),
      true,
    ],
    [
      'app capability without persistent storage attestation',
      createDevice({
        device_type: 'app',
        runtime_features: {
          schemaVersion: 1,
          worktrees: {
            version: 1,
            managed: true,
            deferredPrepare: true,
            snapshots: true,
            restore: true,
            preflight: true,
          },
        },
      }),
      true,
    ],
    [
      'unknown device type without persistent storage attestation',
      createDevice({
        device_type: undefined,
        runtime_features: {
          schemaVersion: 1,
          worktrees: {
            version: 1,
            managed: true,
            deferredPrepare: true,
            snapshots: true,
            restore: true,
            preflight: true,
          },
        },
      }),
      false,
    ],
  ] as const)('recognizes a device with %s', (_label, device, expected) => {
    expect(deviceSupportsManagedWorktrees(device)).toBe(expected)
  })

  test('uses one stable target device identity for remote workspaces', () => {
    expect(
      worktreeWorkspaceDeviceId(
        createWorkspace({
          deviceId: 'local-device',
          remoteHostId: 'remote-device',
          workspaceSource: 'remote',
        })
      )
    ).toBe('remote-device')
  })

  test.each([
    ['local', 'local-device'],
    ['cloud', 'cloud-device'],
    ['remote', 'remote-device'],
  ] as const)('allows a supported %s device workspace', (targetType, deviceId) => {
    const workspace = createWorkspace({
      deviceId,
      remoteHostId: targetType === 'remote' ? deviceId : null,
      workspaceSource: targetType === 'local' ? 'local' : 'remote',
    })
    const project = createProject({
      config: {
        mode: 'workspace',
        execution: { targetType, deviceId },
        workspace: { source: 'device_path', localPath: '/workspace/wegent' },
      },
    })
    const device = createDevice({
      device_id: deviceId,
      device_type: targetType,
    })
    const capabilities = {
      ...createCapabilities(),
      deviceId,
    }
    const preflight = {
      ...createPreflight(),
      deviceId,
    }

    expect(
      resolveProjectWorktreeAvailability({
        project,
        workspace,
        device,
        capabilities,
        preflight,
      })
    ).toEqual({
      available: true,
      reason: 'available',
      deviceId,
      sourcePath: '/workspace/wegent',
    })
  })

  test('uses the remote host id as the target device', () => {
    const workspace = createWorkspace({
      deviceId: 'local-device',
      remoteHostId: 'remote-device',
    })

    expect(
      resolveProjectWorktreeAvailability({
        project: createProject(),
        workspace,
        device: createDevice({
          device_id: 'remote-device',
          device_type: 'remote',
        }),
        capabilities: {
          ...createCapabilities(),
          deviceId: 'remote-device',
        },
        preflight: {
          ...createPreflight(),
          deviceId: 'remote-device',
        },
      })
    ).toMatchObject({
      available: true,
      deviceId: 'remote-device',
    })
  })

  test('treats an old executor without Worktree capability as unsupported', () => {
    expect(
      resolveProjectWorktreeAvailability({
        project: createProject(),
        workspace: createWorkspace(),
        device: createDevice({ runtime_features: null }),
        preflight: createPreflight(),
      })
    ).toEqual({
      available: false,
      reason: 'executor_unsupported',
      deviceId: 'cloud-device',
      sourcePath: '/workspace/wegent',
    })
  })

  test.each(['cloud', 'remote'] as const)(
    'requires verified persistent storage for a %s executor',
    deviceType => {
      expect(
        resolveProjectWorktreeAvailability({
          project: createProject(),
          workspace: createWorkspace(),
          device: createDevice({
            device_type: deviceType,
            runtime_features: {
              schemaVersion: 1,
              worktrees: {
                version: 1,
                managed: true,
                deferredPrepare: true,
                snapshots: true,
                restore: true,
                preflight: true,
              },
            },
          }),
          preflight: createPreflight(),
        })
      ).toEqual({
        available: false,
        reason: 'persistent_storage_unverified',
        deviceId: 'cloud-device',
        sourcePath: '/workspace/wegent',
      })
    }
  )

  test('requires verified persistent storage when the device type is missing', () => {
    expect(
      resolveProjectWorktreeAvailability({
        project: createProject(),
        workspace: createWorkspace(),
        device: createDevice({ device_type: undefined }),
        capabilities: createCapabilities({ persistentStorageVerified: undefined }),
        preflight: createPreflight(),
      })
    ).toEqual({
      available: false,
      reason: 'persistent_storage_unverified',
      deviceId: 'cloud-device',
      sourcePath: '/workspace/wegent',
    })
  })

  test.each(['local', 'app'] as const)(
    'keeps the existing capability rules for a %s executor',
    deviceType => {
      expect(
        resolveProjectWorktreeAvailability({
          project: createProject(),
          workspace: createWorkspace(),
          device: createDevice({ device_type: deviceType }),
          capabilities: createCapabilities({ persistentStorageVerified: undefined }),
          preflight: createPreflight(),
        })
      ).toEqual({
        available: true,
        reason: 'available',
        deviceId: 'cloud-device',
        sourcePath: '/workspace/wegent',
      })
    }
  )

  test.each([
    ['offline device', createDevice({ status: 'offline' }), createPreflight(), 'device_offline'],
    ['missing preflight', createDevice(), undefined, 'preflight_pending'],
    ['non Git source', createDevice(), createPreflight({ gitRepository: false }), 'not_git'],
    [
      'unwritable Worktree root',
      createDevice(),
      createPreflight({ writable: false }),
      'worktree_root_unwritable',
    ],
    [
      'repository identity mismatch',
      createDevice(),
      createPreflight({ repoRootFingerprint: 'different-repository' }),
      'workspace_identity_mismatch',
    ],
  ] as const)('returns a stable reason for %s', (_label, device, preflight, reason) => {
    expect(
      resolveProjectWorktreeAvailability({
        project: createProject(),
        workspace: createWorkspace(),
        device,
        capabilities: createCapabilities(),
        preflight,
      })
    ).toMatchObject({
      available: false,
      reason,
      deviceId: 'cloud-device',
      sourcePath: '/workspace/wegent',
    })
  })

  test('does not accept a capability response for another device', () => {
    expect(
      resolveProjectWorktreeAvailability({
        project: createProject(),
        workspace: createWorkspace(),
        device: createDevice(),
        capabilities: {
          ...createCapabilities(),
          deviceId: 'other-device',
        },
        preflight: createPreflight(),
      })
    ).toMatchObject({
      available: false,
      reason: 'device_mismatch',
    })
  })

  test('rejects a socket Runtime id as a logical device identity', () => {
    const device = createDevice({
      socket_device_id: 'cloud-runtime-device',
    })

    expect(
      resolveProjectWorktreeAvailability({
        project: createProject(),
        workspace: createWorkspace(),
        device,
        capabilities: {
          ...createCapabilities(),
          deviceId: 'cloud-runtime-device',
        },
        preflight: {
          ...createPreflight(),
          deviceId: 'cloud-runtime-device',
        },
      })
    ).toMatchObject({
      available: false,
      reason: 'device_mismatch',
      deviceId: 'cloud-device',
    })
  })

  test('accepts an explicit logical route device id alias', () => {
    const device = createDevice({
      runtime_routes: [
        {
          kind: 'cloud-relay',
          device_id: 'cloud-device-alias',
          runtime_device_id: 'cloud-runtime-device',
          device_type: 'cloud',
          status: 'online',
        },
      ],
    })

    expect(
      resolveProjectWorktreeAvailability({
        project: createProject(),
        workspace: createWorkspace(),
        device,
        capabilities: {
          ...createCapabilities(),
          deviceId: 'cloud-device-alias',
        },
        preflight: {
          ...createPreflight(),
          deviceId: 'cloud-device-alias',
        },
      })
    ).toMatchObject({
      available: true,
      reason: 'available',
      deviceId: 'cloud-device',
    })
  })
})

describe('probeProjectWorktreeAvailability', () => {
  test('uses capability and preflight RPC as the send-time authority', async () => {
    const getWorktreeCapabilities = vi.fn(async () => createCapabilities())
    const preflightWorktree = vi.fn(async () => createPreflight())

    await expect(
      probeProjectWorktreeAvailability({
        api: { getWorktreeCapabilities, preflightWorktree },
        project: createProject(),
        workspace: createWorkspace(),
        device: createDevice({ runtime_features: null }),
        ref: 'feature/cloud-worktree',
      })
    ).resolves.toMatchObject({
      available: true,
      reason: 'available',
      deviceId: 'cloud-device',
    })
    expect(preflightWorktree).toHaveBeenCalledWith({
      deviceId: 'cloud-device',
      sourcePath: '/workspace/wegent',
      ref: 'feature/cloud-worktree',
    })
  })

  test('does not let structural probing bypass cloud persistent storage verification', async () => {
    const getWorktreeCapabilities = vi.fn(async () =>
      createCapabilities({ persistentStorageVerified: undefined })
    )
    const preflightWorktree = vi.fn(async () => createPreflight())

    await expect(
      probeProjectWorktreeAvailability({
        api: { getWorktreeCapabilities, preflightWorktree },
        project: createProject(),
        workspace: createWorkspace(),
        device: createDevice(),
      })
    ).resolves.toMatchObject({
      available: false,
      reason: 'persistent_storage_unverified',
      deviceId: 'cloud-device',
    })
    expect(getWorktreeCapabilities).toHaveBeenCalledWith({
      deviceId: 'cloud-device',
    })
    expect(preflightWorktree).not.toHaveBeenCalled()
  })

  test('does not call the Runtime for an offline workspace', async () => {
    const getWorktreeCapabilities = vi.fn()
    const preflightWorktree = vi.fn()

    await expect(
      probeProjectWorktreeAvailability({
        api: { getWorktreeCapabilities, preflightWorktree },
        project: createProject(),
        workspace: createWorkspace(),
        device: createDevice({ status: 'offline' }),
      })
    ).resolves.toMatchObject({
      available: false,
      reason: 'device_offline',
    })
    expect(getWorktreeCapabilities).not.toHaveBeenCalled()
    expect(preflightWorktree).not.toHaveBeenCalled()
  })

  test('reports an RPC failure without opening the Worktree path', async () => {
    await expect(
      probeProjectWorktreeAvailability({
        api: {
          getWorktreeCapabilities: vi.fn(async () => {
            throw new Error('runtime_rpc_timeout')
          }),
          preflightWorktree: vi.fn(),
        },
        project: createProject(),
        workspace: createWorkspace(),
        device: createDevice(),
      })
    ).resolves.toMatchObject({
      available: false,
      reason: 'preflight_failed',
    })
  })
})
