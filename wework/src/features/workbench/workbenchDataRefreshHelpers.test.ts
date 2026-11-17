import type { DeviceInfo, RuntimeProjectWork, RuntimeWorkListResponse } from '@/types/api'
import { getRuntimeProjectSyncTarget } from '@/lib/runtime-project-identity'
import {
  qualifyLocalRuntimeSource,
  qualifyLocalRuntimeWork,
} from '@/lib/local-runtime-sidebar-identity'
import { describe, expect, test } from 'vitest'
import {
  createCloudRuntimeStateWithCache,
  getRuntimeProjectRemovalContext,
  removeRuntimeProject,
  removeRuntimeProjectFromCloudState,
} from './workbenchDataRefreshHelpers'
import {
  EMPTY_CLOUD_RUNTIME_STATE,
  selectCloudWorkStatus,
  startCloudRuntimeSync,
} from './workbenchCloudStatus'

const devices: DeviceInfo[] = ['a', 'b'].map((name, index) => ({
  id: index + 1,
  device_id: `owner-${name}`,
  socket_device_id: `relay-${name}`,
  runtime_instance_id: `runtime-${name}`,
  name,
  status: 'online',
  device_type: 'remote',
  is_default: false,
}))
const workspace = { deviceId: 'owner-a', workspacePath: '/workspace/shared/' }

function project(id: number, key: string, deviceId = 'owner-a'): RuntimeProjectWork {
  return {
    project: { id, key, name: key, source: 'local_project', stateDeviceId: deviceId },
    deviceWorkspaces: [
      {
        deviceId,
        workspacePath: '/workspace/shared',
        available: true,
        mapped: true,
        tasks: [
          {
            taskId: `task-${id}`,
            title: key,
            workspacePath: '/workspace/shared',
            runtime: 'codex',
          },
        ],
      },
    ],
    totalTasks: 1,
  }
}

function list(...projects: RuntimeProjectWork[]): RuntimeWorkListResponse {
  return { projects, chats: [], totalTasks: projects.length }
}

describe('runtime project removal identity', () => {
  test('preserves another Runtime at the same path, including directory and chat projections', () => {
    const removed = project(1, 'removed')
    const independent = project(2, 'independent', 'owner-b')
    independent.project.source = 'legacy_root'
    const runtimeWork = {
      ...list(removed, independent),
      chats: [removed.deviceWorkspaces[0], independent.deviceWorkspaces[0]],
      totalTasks: 4,
    }
    const remaining = removeRuntimeProject(runtimeWork, 1, workspace, { devices })
    expect(remaining.projects).toEqual([independent])
    expect(remaining.chats).toEqual([independent.deviceWorkspaces[0]])
    expect(remaining.totalTasks).toBe(2)
    expect(runtimeWork.projects).toHaveLength(2)
  })

  test('removes the same named project through a legitimate alias of its Runtime', () => {
    const removed = project(1, 'same-project')
    const alias = project(3, 'same-project', 'relay-a')
    const independent = project(2, 'same-project', 'relay-b')
    const remaining = removeRuntimeProject(list(removed, alias, independent), 1, workspace, {
      devices,
    })
    expect(remaining.projects).toEqual([independent])
    expect(remaining.totalTasks).toBe(1)
  })

  test('removes reidentified legacy directory and chat projections only on the same Runtime', () => {
    const directory = project(8, 'old-directory-identity', 'relay-a')
    directory.project.source = 'legacy_root'
    const independent = project(9, 'old-directory-identity', 'relay-b')
    independent.project.source = 'legacy_root'
    const remaining = removeRuntimeProject(
      {
        ...list(directory, independent),
        chats: [directory.deviceWorkspaces[0], independent.deviceWorkspaces[0]],
      },
      1,
      workspace,
      { devices }
    )
    expect(remaining.projects).toEqual([independent])
    expect(remaining.chats).toEqual([independent.deviceWorkspaces[0]])
  })

  test('preserves another named project on the same Runtime sharing the same root', () => {
    const removed = project(1, 'project-a')
    const independent = project(2, 'project-b', 'relay-a')
    const remaining = removeRuntimeProject(list(removed, independent), 1, workspace, { devices })
    expect(remaining.projects).toEqual([independent])
    expect(remaining.totalTasks).toBe(1)
  })

  test('uses the selected project target when cached snapshots have different UI identities', () => {
    const selected = project(1, 'project-a')
    const cached = project(8, 'project-a', 'relay-a')
    const independent = project(2, 'project-b', 'relay-a')
    const remaining = removeRuntimeProject(list(cached, independent), 1, workspace, {
      devices,
      target: getRuntimeProjectSyncTarget(selected),
    })
    expect(remaining.projects).toEqual([independent])
  })

  test('applies the same identity boundary to both current and persisted cloud snapshots', () => {
    const selected = project(1, 'project-a')
    const cached = project(8, 'project-a', 'relay-a')
    const independent = project(2, 'project-a', 'relay-b')
    const state = createCloudRuntimeStateWithCache(list(cached, independent))
    const remaining = removeRuntimeProjectFromCloudState(
      {
        ...state,
        current: state.lastGood,
      },
      1,
      workspace,
      { devices, target: getRuntimeProjectSyncTarget(selected) }
    )
    expect(remaining.current?.runtimeWork.projects).toEqual([independent])
    expect(remaining.lastGood?.runtimeWork.projects).toEqual([independent])
    expect(state.lastGood?.runtimeWork.projects).toHaveLength(2)
  })

  test('does not infer Runtime aliases from a matching path when device evidence is absent', () => {
    const removed = project(1, 'project-a')
    const independent = project(2, 'project-a', 'unresolved-device')
    independent.project.source = 'legacy_root'
    const remaining = removeRuntimeProject(list(removed, independent), 1, workspace)
    expect(remaining.projects).toEqual([independent])
  })

  test('preserves unrelated cached projections with an ambiguous device alias', () => {
    const ambiguousDevices = devices.map(device => ({
      ...device,
      socket_device_id: 'shared-alias',
    }))
    const removed = project(1, 'project-a')
    const ambiguous = project(2, 'project-a', 'shared-alias')
    ambiguous.project.source = 'legacy_root'
    const remaining = removeRuntimeProject(
      { ...list(removed, ambiguous), chats: [ambiguous.deviceWorkspaces[0]] },
      1,
      workspace,
      { devices: ambiguousDevices }
    )
    expect(remaining.projects).toEqual([ambiguous])
    expect(remaining.chats).toEqual([ambiguous.deviceWorkspaces[0]])
  })

  test.each(['project', 'workspace'])('rejects an ambiguous selected %s identity', identity => {
    const ambiguousDevices = devices.map(device => ({
      ...device,
      socket_device_id: 'shared-alias',
    }))
    const removed = project(1, 'project-a', identity === 'project' ? 'shared-alias' : 'owner-a')
    const selectedWorkspace =
      identity === 'workspace' ? { ...workspace, deviceId: 'shared-alias' } : workspace
    expect(() =>
      removeRuntimeProject(list(removed), 1, selectedWorkspace, { devices: ambiguousDevices })
    ).toThrow('ambiguous-executor-identity:shared-alias')
  })

  test.each(['missing', 'ambiguous'])(
    'uses native provenance with a %s device catalog',
    catalog => {
      const identity = {
        deviceId: 'owner-a',
        runtimeInstanceId: 'runtime-a',
        provenance: 'local-ipc' as const,
      }
      const removed = project(1, 'project-a')
      const directory = project(8, 'old-directory')
      directory.project.source = 'legacy_root'
      const qualified = qualifyLocalRuntimeWork(
        { ...list(removed, directory), chats: [removed.deviceWorkspaces[0]] },
        identity
      )
      const context = getRuntimeProjectRemovalContext(qualified, 1, workspace)
      const contextDevices =
        catalog === 'missing'
          ? []
          : [
              { ...devices[0], device_type: 'local' as const },
              { ...devices[1], socket_device_id: 'owner-a' },
            ]
      const cached = { ...qualified, projects: qualified.projects.slice(1) }
      expect(
        removeRuntimeProject(cached, 1, workspace, { ...context, devices: contextDevices })
      ).toMatchObject({ projects: [], chats: [], totalTasks: 0 })
    }
  )

  test('preserves provenance for a standalone native workspace without a project row', () => {
    const identity = {
      deviceId: 'owner-a',
      runtimeInstanceId: 'runtime-a',
      provenance: 'local-ipc' as const,
    }
    const native = qualifyLocalRuntimeSource(project(1, 'project-a').deviceWorkspaces[0], identity)
    const unqualified = JSON.parse(JSON.stringify(native))
    const runtimeWork = { projects: [], chats: [unqualified, native], totalTasks: 2 }
    const context = getRuntimeProjectRemovalContext(runtimeWork, 1, workspace)
    expect(context.localOwnerIdentity).toEqual(identity)
    expect(removeRuntimeProject(runtimeWork, 1, workspace, context).chats).toEqual([unqualified])
  })

  test('does not promote a remote projection with local index provenance to a native owner', () => {
    const identity = {
      deviceId: 'owner-a',
      runtimeInstanceId: 'runtime-a',
      provenance: 'local-ipc' as const,
    }
    const remote = project(1, 'project-a')
    remote.project.source = 'remote_project'
    remote.project = qualifyLocalRuntimeSource(remote.project, identity)
    remote.deviceWorkspaces[0].remoteHostId = 'owner-a'
    const context = getRuntimeProjectRemovalContext(list(remote), 1, workspace)
    expect(context.localOwnerIdentity).toBeUndefined()
    const cachedNative = qualifyLocalRuntimeWork(list(project(1, 'old-native-project')), identity)
    expect(() =>
      removeRuntimeProject(cachedNative, 1, workspace, {
        ...context,
        devices: [devices[0], { ...devices[1], socket_device_id: 'owner-a' }],
      })
    ).toThrow('ambiguous-executor-identity:owner-a')
  })

  test('clears cancelled initial cloud checks without inventing a successful refresh', () => {
    const syncing = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', [
      'teams',
      'devices',
      'runtimeWork',
    ])
    const remaining = removeRuntimeProjectFromCloudState(syncing, 1, workspace)
    expect(remaining.inFlightRevision).toBeNull()
    expect(remaining.availability).toBe('idle')
    expect(remaining.current?.fetchedAt).toBeNull()
    expect(selectCloudWorkStatus(remaining)).toMatchObject({
      availability: 'idle',
      checks: { teams: 'idle', devices: 'idle', runtimeWork: 'idle' },
    })
    expect(syncing.inFlightRevision).not.toBeNull()
  })

  test('restores cached cloud checks and errors after cancellation while removing both projections', () => {
    const cached = createCloudRuntimeStateWithCache(
      list(project(1, 'project-a'), project(2, 'project-b', 'owner-b'))
    )
    cached.lastGood!.checks.teams = {
      status: 'failed',
      error: 'Teams unavailable',
      updatedAt: '2026-11-17T00:00:00Z',
    }
    const syncing = startCloudRuntimeSync(cached, 'manual-refresh', [
      'teams',
      'devices',
      'runtimeWork',
    ])
    const remaining = removeRuntimeProjectFromCloudState(syncing, 1, workspace, { devices })
    expect(remaining.inFlightRevision).toBeNull()
    expect(remaining.availability).toBe('stale')
    expect(remaining.current?.checks).toEqual(cached.lastGood!.checks)
    expect(selectCloudWorkStatus(remaining)).toMatchObject({
      availability: 'unavailable',
      error: 'Teams unavailable',
    })
    expect(remaining.current?.runtimeWork.projects.map(item => item.project.id)).toEqual([2])
    expect(remaining.lastGood?.runtimeWork.projects.map(item => item.project.id)).toEqual([2])
  })
})
