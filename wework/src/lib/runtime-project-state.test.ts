import {
  buildRuntimeRemoteProjectStateId,
  parseRuntimeRemoteProjectStateId,
  getRuntimeProjectSyncTarget,
} from './runtime-project-identity'
import { describe, expect, test } from 'vitest'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import {
  findActiveRuntimeProjectId,
  getLocalRuntimeStateDeviceId,
  getRuntimeProjectActivation,
  getRuntimeProjectReorderRequest,
  getRuntimeRemoteProjectRegistrations,
} from './runtime-project-state'
import { qualifyLocalRuntimeWork } from './local-runtime-sidebar-identity'

const runtimeWork: RuntimeWorkListResponse = {
  projects: [
    {
      project: { key: '/repo/local', id: 1, name: 'Local', active: false },
      deviceWorkspaces: [
        {
          id: null,
          projectId: null,
          deviceId: 'local-device',
          workspacePath: '/repo/local',
          available: true,
          mapped: true,
          tasks: [],
        },
      ],
    },
    {
      project: {
        key: '/srv/remote',
        sidebarStateKey: 'remote-project-id',
        id: 2,
        name: 'Remote',
        kind: 'remote',
        source: 'remote_project',
        active: true,
      },
      deviceWorkspaces: [
        {
          id: null,
          projectId: null,
          deviceId: 'remote-device',
          remoteHostId: 'remote-device',
          workspacePath: '/srv/remote',
          workspaceSource: 'remote',
          available: true,
          mapped: true,
          tasks: [],
        },
      ],
    },
  ],
  chats: [],
  totalTasks: 0,
}

describe('runtime project state', () => {
  test('round-trips a remote project state identity', () => {
    const stateId = buildRuntimeRemoteProjectStateId(
      'remote:device',
      'local:/srv/project with spaces'
    )

    expect(stateId).toBe('wegent-remote:remote%3Adevice:local%3A%2Fsrv%2Fproject%20with%20spaces')
    expect(parseRuntimeRemoteProjectStateId(stateId)).toEqual({
      hostId: 'remote:device',
      projectKey: 'local:/srv/project with spaces',
    })
    expect(parseRuntimeRemoteProjectStateId('wegent-remote:remote-device:%E0%A4%A')).toBeNull()
  })

  test('uses only the local executor as the Codex global state owner', () => {
    expect(
      getLocalRuntimeStateDeviceId([
        {
          id: 2,
          device_id: 'remote-device',
          name: 'Remote',
          status: 'online',
          is_default: true,
          device_type: 'remote',
          bind_shell: 'claudecode',
        },
      ])
    ).toBeNull()
  })

  test('registers remote projects using their Codex sidebar identity', () => {
    expect(getRuntimeRemoteProjectRegistrations(runtimeWork, 'local-device')).toEqual([
      {
        id: 'remote-project-id',
        hostId: 'remote-device',
        remotePath: '/srv/remote',
        label: 'Remote',
        projectKey: '/srv/remote',
        roots: ['/srv/remote'],
        defaultProjectSpace: null,
        aiSettings: null,
      },
    ])
  })

  test('routes remote activation through the local Codex state owner', () => {
    expect(getRuntimeProjectActivation(runtimeWork, 2, 'local-device')).toEqual({
      deviceId: 'local-device',
      projectKey: 'remote-project-id',
      workspacePath: '/srv/remote',
      remoteHostId: 'remote-device',
    })
    expect(findActiveRuntimeProjectId(runtimeWork)).toBe(2)
  })

  test('syncs the full owner metadata with a stable sidebar id and new primary root', () => {
    const work = structuredClone(runtimeWork)
    Object.assign(work.projects[1].project, {
      ownerProjectKey: 'stable-key',
      ownerDeviceId: 'remote-device',
      roots: [
        { kind: 'local', path: '/new' },
        { kind: 'local', path: '/extra' },
      ],
      aiSettings: {
        instructions: 'Test',
        quickPhrases: [
          { id: 'review', title: 'Review', content: 'Review changes', mode: 'normal' },
        ],
      },
      defaultProjectSpace: { projectStore: 'backend', projectId: 'space' },
    })
    expect(getRuntimeRemoteProjectRegistrations(work, 'local-device')).toEqual([
      {
        id: 'remote-project-id',
        hostId: 'remote-device',
        projectKey: 'stable-key',
        remotePath: '/new',
        roots: ['/new', '/extra'],
        label: 'Remote',
        aiSettings: work.projects[1].project.aiSettings,
        defaultProjectSpace: work.projects[1].project.defaultProjectSpace,
      },
    ])
  })

  test('prefers an active remote project over retained local active roots', () => {
    const work = structuredClone(runtimeWork)
    work.projects[0].project.active = true

    expect(findActiveRuntimeProjectId(work)).toBe(2)
  })

  test('reorders remote and local projects through the local Codex state owner', () => {
    expect(
      getRuntimeProjectReorderRequest(
        runtimeWork.projects[1],
        runtimeWork.projects[0],
        'local-device'
      )
    ).toEqual({
      deviceId: 'local-device',
      projectKey: 'remote-project-id',
      beforeProjectKey: '/repo/local',
      insertAtEnd: false,
    })
  })
})

describe('remote project sync identity', () => {
  test.each(['included', 'removed'])(
    'handles a trusted opaque legacy mirror state target when it is %s',
    mode => {
      const identity = {
        deviceId: 'electron-shared',
        runtimeInstanceId: 'current',
        provenance: 'local-ipc' as const,
      }
      const work = structuredClone(runtimeWork)
      work.projects = [work.projects[1]]
      Object.assign(work.projects[0].project, {
        key: 'legacy-mirror-key',
        sidebarStateKey: 'legacy-mirror-key',
        stateDeviceId: identity.deviceId,
        ownerProjectKey: undefined,
      })
      const trusted = qualifyLocalRuntimeWork(work, identity)
      const devices: DeviceInfo[] = [
        {
          id: 0,
          device_id: identity.deviceId,
          runtime_instance_id: identity.runtimeInstanceId,
          device_type: 'local',
          status: 'online',
          name: 'Local',
          is_default: true,
        },
        {
          id: 1,
          device_id: 'history',
          app_device_id: identity.deviceId,
          runtime_instance_id: 'old',
          device_type: 'remote',
          status: 'offline',
          name: 'History',
          is_default: false,
        },
      ]
      const target = getRuntimeProjectSyncTarget(trusted.projects[0])
      const options = {
        devices,
        localSidebarIdentity: identity,
        ...(mode === 'removed' ? { excludedTargets: [target] } : {}),
      }
      const registrations = getRuntimeRemoteProjectRegistrations(
        trusted,
        identity.deviceId,
        options
      )
      expect(registrations).toHaveLength(mode === 'removed' ? 0 : 1)
      if (mode === 'removed') {
        const empty = { projects: [], chats: [], totalTasks: 0 }
        expect(getRuntimeRemoteProjectRegistrations(empty, identity.deviceId, options)).toEqual([])
        expect(() =>
          getRuntimeRemoteProjectRegistrations(empty, identity.deviceId, {
            ...options,
            localSidebarIdentity: { ...identity, runtimeInstanceId: 'replacement' },
          })
        ).toThrow('local-sidebar-runtime-changed')
      }
      if (mode === 'included')
        expect(registrations[0]).toMatchObject({
          id: 'legacy-mirror-key',
          hostId: 'remote-device',
          projectKey: null,
        })
      expect(() =>
        getRuntimeRemoteProjectRegistrations(trusted, identity.deviceId, {
          devices,
          localSidebarIdentity: identity,
          excludedTargets: [{ deviceId: identity.deviceId, projectKey: 'untrusted-owner' }],
        })
      ).toThrow('ambiguous-executor-identity:electron-shared')
      const remoteOwnerWork = structuredClone(work)
      remoteOwnerWork.projects[0].project.ownerProjectKey = 'resolved-remote-key'
      remoteOwnerWork.projects[0].deviceWorkspaces[0].remoteHostId = identity.deviceId
      expect(() =>
        getRuntimeRemoteProjectRegistrations(
          qualifyLocalRuntimeWork(remoteOwnerWork, identity),
          identity.deviceId,
          options
        )
      ).toThrow('ambiguous-executor-identity:electron-shared')
    }
  )
  test.each(['other-runtime', null])(
    'does not treat an untrusted cloud native %s alias as local IPC work',
    runtimeInstanceId => {
      const work = structuredClone(runtimeWork)
      work.projects = [work.projects[0]]
      work.projects[0].project.source = 'local_project'
      work.projects[0].project.stateDeviceId = 'electron-shared'
      work.projects[0].deviceWorkspaces[0].deviceId = 'electron-shared'
      const devices: DeviceInfo[] = [
        {
          id: 0,
          device_id: 'electron-shared',
          runtime_instance_id: 'current-runtime',
          name: 'Local',
          device_type: 'local',
          status: 'online',
          is_default: true,
        },
        {
          id: 9,
          device_id: 'cloud-native',
          app_device_id: 'electron-shared',
          runtime_instance_id: runtimeInstanceId,
          name: 'Cloud native',
          device_type: 'remote',
          status: 'online',
          is_default: false,
        },
      ]
      expect(() =>
        getRuntimeRemoteProjectRegistrations(work, 'electron-shared', {
          devices,
          localSidebarIdentity: {
            deviceId: 'electron-shared',
            runtimeInstanceId: 'current-runtime',
            provenance: 'local-ipc',
          },
        })
      ).toThrow('ambiguous-executor-identity:electron-shared')
    }
  )

  test('rejects an incomplete remote inventory instead of dropping a mirror from the full batch', () => {
    const work = structuredClone(runtimeWork)
    const incomplete = structuredClone(work.projects[1])
    incomplete.project.key = 'missing-workspace'
    incomplete.project.sidebarStateKey = 'keep-missing-mirror'
    incomplete.deviceWorkspaces = []
    work.projects.push(incomplete)
    expect(() => getRuntimeRemoteProjectRegistrations(work, 'local-device')).toThrow(
      'remote-project-workspace-unavailable:missing-workspace'
    )
  })

  test('builds activation with qualified local state ownership while retaining strict remote host resolution', () => {
    const work = structuredClone(runtimeWork)
    work.projects[1].project.stateDeviceId = 'local-device'
    const identity = {
      deviceId: 'local-device',
      runtimeInstanceId: 'current-runtime',
      provenance: 'local-ipc' as const,
    }
    const devices: DeviceInfo[] = [
      {
        id: 0,
        device_id: 'local-device',
        runtime_instance_id: 'current-runtime',
        device_type: 'local',
        status: 'online',
        name: 'Local',
        is_default: true,
      },
      {
        id: 9,
        device_id: 'history',
        app_device_id: 'local-device',
        runtime_instance_id: 'old-runtime',
        device_type: 'remote',
        status: 'offline',
        name: 'History',
        is_default: false,
      },
    ]
    expect(
      getRuntimeProjectActivation(
        qualifyLocalRuntimeWork(work, identity),
        2,
        identity.deviceId,
        devices,
        identity
      )
    ).toEqual({
      deviceId: identity.deviceId,
      projectKey: 'remote-project-id',
      workspacePath: '/srv/remote',
      remoteHostId: 'remote-device',
    })
  })

  test('rejects an inventory from the previous local IPC runtime even when its address is unchanged', () => {
    const work = structuredClone(runtimeWork)
    work.projects[1].project.stateDeviceId = 'local-device'
    const previousIdentity = {
      deviceId: 'local-device',
      runtimeInstanceId: 'previous-runtime',
      provenance: 'local-ipc' as const,
    }
    const snapshot = qualifyLocalRuntimeWork(work, previousIdentity)
    expect(() =>
      getRuntimeRemoteProjectRegistrations(snapshot, 'local-device', {
        localSidebarIdentity: { ...previousIdentity, runtimeInstanceId: 'replacement' },
      })
    ).toThrow('local-sidebar-runtime-changed')
  })

  test.each(['other-runtime', null])(
    'builds the complete mirror with trusted local IPC identity despite an offline %s alias',
    runtimeInstanceId => {
      const work = structuredClone(runtimeWork)
      work.projects[0].deviceWorkspaces[0].deviceId = 'electron-shared'
      const devices: DeviceInfo[] = [
        {
          id: 0,
          device_id: 'electron-shared',
          runtime_instance_id: 'current-runtime',
          name: 'Local',
          device_type: 'local',
          status: 'online',
          is_default: true,
        },
        {
          id: 20,
          device_id: 'historical-relay',
          app_device_id: 'electron-shared',
          runtime_instance_id: runtimeInstanceId,
          name: 'Historical',
          device_type: 'remote',
          status: 'offline',
          is_default: false,
        },
      ]
      expect(
        getRuntimeRemoteProjectRegistrations(
          qualifyLocalRuntimeWork(work, {
            deviceId: 'electron-shared',
            runtimeInstanceId: 'current-runtime',
            provenance: 'local-ipc',
          }),
          'electron-shared',
          {
            devices,
            localSidebarIdentity: {
              deviceId: 'electron-shared',
              runtimeInstanceId: 'current-runtime',
              provenance: 'local-ipc',
            },
          }
        )
      ).toEqual(getRuntimeRemoteProjectRegistrations(runtimeWork, 'local-device'))
    }
  )

  test.each([false, true])(
    'validates explicit owner aliases independently of the canonical workspace host (ambiguous=%s)',
    ambiguous => {
      const work = structuredClone(runtimeWork)
      Object.assign(work.projects[1].project, {
        ownerDeviceId: 'shared-owner',
        ownerProjectKey: 'owner-key',
      })
      Object.assign(work.projects[1].deviceWorkspaces[0], {
        deviceId: 'remote-one',
        remoteHostId: 'remote-one',
      })
      const devices: DeviceInfo[] = ['one', 'two'].map((id, index) => ({
        id: index + 1,
        device_id: `remote-${id}`,
        socket_device_id: index === 0 || ambiguous ? 'shared-owner' : 'separate-owner',
        runtime_instance_id: `runtime-${id}`,
        device_type: 'remote',
        status: 'online',
        name: id,
        is_default: false,
      }))
      const registrations = () =>
        getRuntimeRemoteProjectRegistrations(work, 'local-device', { devices })
      if (ambiguous) {
        expect(registrations).toThrow('ambiguous-executor-identity:shared-owner')
      } else {
        expect(registrations()).toEqual([
          expect.objectContaining({
            id: 'remote-project-id',
            hostId: 'shared-owner',
            projectKey: 'owner-key',
          }),
        ])
      }
    }
  )

  test('still rejects an ambiguous remote owner instead of submitting a partial inventory', () => {
    const work = structuredClone(runtimeWork)
    work.projects[1].deviceWorkspaces[0].remoteHostId = 'shared-owner'
    const devices: DeviceInfo[] = ['one', 'two'].map((id, index) => ({
      id: index + 1,
      device_id: id,
      app_device_id: 'shared-owner',
      runtime_instance_id: id,
      name: id,
      device_type: 'remote',
      status: 'online',
      is_default: false,
    }))
    expect(() =>
      getRuntimeRemoteProjectRegistrations(work, 'local-device', {
        devices,
        localSidebarIdentity: {
          deviceId: 'local-device',
          runtimeInstanceId: 'current-runtime',
          provenance: 'local-ipc',
        },
      })
    ).toThrow('ambiguous-executor-identity:shared-owner')
  })

  test('removing one remote project does not suppress the same path on another device or project', () => {
    const remote = structuredClone(runtimeWork.projects[1])
    remote.project.stateDeviceId = 'viewer'
    const otherDevice = structuredClone(remote)
    otherDevice.project.sidebarStateKey = 'other-device-entry'
    otherDevice.deviceWorkspaces[0].deviceId = 'other-device'
    otherDevice.deviceWorkspaces[0].remoteHostId = 'other-device'
    const otherProject = structuredClone(remote)
    otherProject.project.key = 'another-project'
    otherProject.project.sidebarStateKey = 'another-project-entry'
    const work = { projects: [remote, otherDevice, otherProject], chats: [], totalTasks: 0 }
    const registrations = getRuntimeRemoteProjectRegistrations(work, 'viewer', {
      excludedTargets: [{ deviceId: 'remote-device', projectKey: '/srv/remote' }],
    })
    expect(registrations.map(item => item.id)).toEqual([
      'other-device-entry',
      'another-project-entry',
    ])
    expect(registrations.every(item => item.remotePath === '/srv/remote')).toBe(true)
  })

  test('matches a removed project through a known device alias while preserving the external host value', () => {
    const work = structuredClone(runtimeWork)
    work.projects[1].deviceWorkspaces[0].remoteHostId = 'relay'
    const devices = [
      {
        id: 1,
        device_id: 'remote-device',
        socket_device_id: 'relay',
        status: 'online' as const,
        name: 'Remote',
        is_default: false,
        device_type: 'remote' as const,
      },
    ]
    expect(
      getRuntimeRemoteProjectRegistrations(work, 'local-device', {
        devices,
        excludedTargets: [{ deviceId: 'remote-device', projectKey: '/srv/remote' }],
      })
    ).toEqual([])
    expect(getRuntimeRemoteProjectRegistrations(work, 'local-device', { devices })[0].hostId).toBe(
      'relay'
    )
  })

  test('does not register another connection to the local executor as a remote project', () => {
    const work = structuredClone(runtimeWork)
    work.projects = [work.projects[0]]
    work.projects[0].deviceWorkspaces[0].deviceId = 'local-relay'
    const devices = [
      {
        id: 1,
        device_id: 'local-device',
        socket_device_id: 'local-relay',
        status: 'online' as const,
        name: 'Local',
        is_default: false,
        device_type: 'local' as const,
      },
    ]
    expect(getRuntimeRemoteProjectRegistrations(work, 'local-device', { devices })).toEqual([])
    expect(
      getRuntimeProjectActivation(work, 1, 'local-device', devices)?.remoteHostId
    ).toBeUndefined()
  })
})
