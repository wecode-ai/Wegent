import { describe, expect, test } from 'vitest'
import type { DeviceInfo, RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'
import {
  EMPTY_CLOUD_RUNTIME_STATE,
  finishCloudRuntimeSync,
  mergeRuntimeWorkLists,
  selectCloudWorkStatus,
  selectProjectCreatableDevices,
  selectRuntimeWorkView,
  selectVisibleDevices,
  startCloudRuntimeSync,
} from './workbenchCloudStatus'

function workspace(
  deviceId: string,
  tasks: Array<{ taskId: string; title?: string }> = [{ taskId: 'task-1' }]
): RuntimeDeviceWorkspace {
  return {
    deviceId,
    deviceName: deviceId,
    deviceStatus: 'online',
    available: true,
    mapped: true,
    workspacePath: '/workspace/repo',
    workspaceKind: 'workspace',
    projectId: 7,
    tasks: tasks.map(task => ({
      taskId: task.taskId,
      workspacePath: '/workspace/repo',
      workspaceKind: 'workspace',
      title: task.title ?? task.taskId,
      runtime: 'codex',
    })),
  }
}

function runtimeWork(deviceId: string): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 7, name: 'Repo' },
        deviceWorkspaces: [workspace(deviceId)],
        totalTasks: 1,
      },
    ],
    chats: [],
    totalTasks: 1,
  }
}

describe('mergeRuntimeWorkLists', () => {
  test('is idempotent when the same cloud snapshot is merged repeatedly', () => {
    const localWork = runtimeWork('local-device')
    const cloudWork = runtimeWork('remote-device')

    const once = mergeRuntimeWorkLists(localWork, cloudWork)
    const twice = mergeRuntimeWorkLists(once, cloudWork)

    expect(once.totalTasks).toBe(1)
    expect(twice.totalTasks).toBe(1)
    expect(twice.projects).toHaveLength(1)
    expect(twice.projects[0].deviceWorkspaces).toHaveLength(1)
    expect(twice.projects[0].deviceWorkspaces[0].tasks.map(task => task.taskId)).toEqual(['task-1'])
  })

  test('keeps distinct tasks from different devices in the same project', () => {
    const localWork = {
      ...runtimeWork('local-device'),
      projects: [
        {
          project: { id: 7, name: 'Repo' },
          deviceWorkspaces: [workspace('local-device', [{ taskId: 'task-local' }])],
          totalTasks: 1,
        },
      ],
    }
    const cloudWork = {
      ...runtimeWork('remote-device'),
      projects: [
        {
          project: { id: 7, name: 'Repo' },
          deviceWorkspaces: [workspace('remote-device', [{ taskId: 'task-remote' }])],
          totalTasks: 1,
        },
      ],
    }

    const merged = mergeRuntimeWorkLists(localWork, cloudWork)

    expect(merged.totalTasks).toBe(2)
    expect(merged.projects).toHaveLength(1)
    expect(merged.projects[0].deviceWorkspaces).toHaveLength(2)
    expect(
      merged.projects[0].deviceWorkspaces.flatMap(deviceWorkspace =>
        deviceWorkspace.tasks.map(task => task.taskId)
      )
    ).toEqual(['task-local', 'task-remote'])
  })

  test('keeps mapped project workspaces without tasks so the first task has a target', () => {
    const localWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { id: 7, name: 'Repo' },
          deviceWorkspaces: [workspace('local-device', [])],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    const cloudWork: RuntimeWorkListResponse = {
      projects: [],
      chats: [],
      totalTasks: 0,
    }

    const merged = mergeRuntimeWorkLists(localWork, cloudWork)

    expect(merged.projects[0].deviceWorkspaces).toEqual([
      expect.objectContaining({
        deviceId: 'local-device',
        workspacePath: '/workspace/repo',
        mapped: true,
        available: true,
        tasks: [],
      }),
    ])
  })

  test('drops unmapped empty chat workspaces during runtime work merge', () => {
    const localWork: RuntimeWorkListResponse = {
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          deviceName: 'local-device',
          deviceStatus: 'online',
          available: true,
          mapped: false,
          workspacePath: '/workspace/empty-chat',
          workspaceKind: 'chat',
          tasks: [],
        },
      ],
      totalTasks: 0,
    }
    const cloudWork: RuntimeWorkListResponse = {
      projects: [],
      chats: [],
      totalTasks: 0,
    }

    expect(mergeRuntimeWorkLists(localWork, cloudWork).chats).toEqual([])
  })
})

function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'cloud-device',
    name: 'Cloud Device',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

describe('cloud runtime sync state', () => {
  test('keeps last good devices when a later sync fails', () => {
    const started = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', ['devices'])
    const ready = finishCloudRuntimeSync(started, started.inFlightRevision ?? 0, {
      devices: { status: 'fulfilled', value: [device()] },
    })
    const retry = startCloudRuntimeSync(ready, 'manual-refresh', ['devices'])
    const failed = finishCloudRuntimeSync(retry, retry.inFlightRevision ?? 0, {
      devices: { status: 'rejected', reason: new Error('network down') },
    })

    expect(selectVisibleDevices([], failed).map(item => item.device_id)).toEqual(['cloud-device'])
    expect(failed.availability).toBe('partial')
    expect(failed.current?.checks.devices.status).toBe('failed')
  })

  test('merges local and cloud routes for the same runtime identity with local as primary', () => {
    const started = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', ['devices'])
    const ready = finishCloudRuntimeSync(started, started.inFlightRevision ?? 0, {
      devices: {
        status: 'fulfilled',
        value: [
          device({
            device_id: 'cloud-device',
            app_device_id: 'local-device',
            device_type: 'cloud',
          }),
        ],
      },
    })

    const visibleDevices = selectVisibleDevices(
      [
        device({
          device_id: 'local-device',
          name: 'Local Executor',
          device_type: 'local',
        }),
      ],
      ready
    )

    expect(visibleDevices).toHaveLength(1)
    expect(visibleDevices[0]).toMatchObject({
      device_id: 'local-device',
      device_type: 'local',
      app_device_id: 'local-device',
    })
    expect(visibleDevices[0].runtime_routes?.map(route => route.kind)).toEqual([
      'local-ipc',
      'cloud-relay',
    ])
    expect(visibleDevices[0].runtime_routes?.map(route => route.device_id)).toEqual([
      'local-device',
      'cloud-device',
    ])
  })

  test('excludes remote routes that resolve to the local runtime from remote project creation', () => {
    const started = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', ['devices'])
    const ready = finishCloudRuntimeSync(started, started.inFlightRevision ?? 0, {
      devices: {
        status: 'fulfilled',
        value: [
          device({
            device_id: 'remote-device',
            name: 'Remote route',
            device_type: 'remote',
            runtime_instance_id: 'runtime-local',
          }),
        ],
      },
    })

    const localDevices = [
      device({
        device_id: 'app-device',
        name: 'Local Executor',
        device_type: 'app',
        runtime_instance_id: 'runtime-local',
      }),
    ]
    const visibleDevices = selectVisibleDevices(localDevices, ready)

    expect(visibleDevices).toHaveLength(1)
    expect(visibleDevices[0]).toMatchObject({
      device_id: 'app-device',
      device_type: 'app',
      runtime_instance_id: 'runtime-local',
    })
    expect(visibleDevices[0].runtime_routes?.map(route => route.kind)).toEqual([
      'app-ipc',
      'remote-relay',
    ])
    expect(selectProjectCreatableDevices(localDevices, ready)).toEqual([])
  })

  test('drops stale revisions that complete after a newer sync starts', () => {
    const first = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', ['devices'])
    const second = startCloudRuntimeSync(first, 'manual-refresh', ['devices'])
    const stale = finishCloudRuntimeSync(second, first.inFlightRevision ?? 0, {
      devices: { status: 'fulfilled', value: [device({ device_id: 'stale-device' })] },
    })

    expect(stale).toBe(second)
    expect(selectVisibleDevices([], stale)).toEqual([])
  })

  test('keeps sidebar cloud work status stable during a background refresh', () => {
    const started = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', ['devices'])
    const ready = finishCloudRuntimeSync(started, started.inFlightRevision ?? 0, {
      devices: { status: 'fulfilled', value: [device()] },
    })
    const refreshing = startCloudRuntimeSync(ready, 'poll', ['devices'])

    expect(selectCloudWorkStatus(refreshing).availability).toBe('available')
    expect(selectCloudWorkStatus(refreshing).checks.devices).toBe('available')
  })

  test('derives runtime work from last good cloud snapshot without duplicating tasks', () => {
    const started = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', ['runtimeWork'])
    const ready = finishCloudRuntimeSync(started, started.inFlightRevision ?? 0, {
      runtimeWork: { status: 'fulfilled', value: runtimeWork('remote-device') },
    })
    const once = selectRuntimeWorkView(runtimeWork('local-device'), ready)
    const twice = selectRuntimeWorkView(once, ready)

    expect(once.totalTasks).toBe(1)
    expect(twice.totalTasks).toBe(1)
  })

  test('canonicalizes cloud runtime workspaces to the local route for the same runtime', () => {
    const localDevice = device({
      device_id: 'local-device',
      name: 'Local Executor',
      device_type: 'local',
    })
    const cloudDevice = device({
      device_id: 'cloud-device',
      app_device_id: 'local-device',
      device_type: 'cloud',
    })
    const localWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { id: 7, name: 'Repo' },
          deviceWorkspaces: [workspace('local-device', [])],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    const cloudWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { id: 7, name: 'Repo' },
          deviceWorkspaces: [workspace('cloud-device', [{ taskId: 'task-cloud' }])],
          totalTasks: 1,
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const started = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', [
      'devices',
      'runtimeWork',
    ])
    const ready = finishCloudRuntimeSync(started, started.inFlightRevision ?? 0, {
      devices: { status: 'fulfilled', value: [cloudDevice] },
      runtimeWork: { status: 'fulfilled', value: cloudWork },
    })

    const visibleDevices = selectVisibleDevices([localDevice], ready)
    const runtimeView = selectRuntimeWorkView(localWork, ready, visibleDevices)

    expect(runtimeView.projects).toHaveLength(1)
    expect(runtimeView.projects[0].deviceWorkspaces).toEqual([
      expect.objectContaining({
        deviceId: 'local-device',
        deviceName: 'Local Executor',
        workspacePath: '/workspace/repo',
        tasks: [
          expect.objectContaining({
            taskId: 'task-cloud',
          }),
        ],
      }),
    ])
    expect(runtimeView.totalTasks).toBe(1)
  })

  test('merges duplicate route workspaces that share a device workspace mapping id', () => {
    const localWorkspace = {
      ...workspace('local-device', []),
      id: 101,
      deviceName: 'Local Executor',
    }
    const cloudWorkspace = {
      ...workspace('cloud-device', [{ taskId: 'task-cloud' }]),
      id: 101,
      deviceName: 'hongyu9-remote',
    }
    const merged = mergeRuntimeWorkLists(
      {
        projects: [
          {
            project: { id: 7, name: 'Repo' },
            deviceWorkspaces: [localWorkspace],
            totalTasks: 0,
          },
        ],
        chats: [],
        totalTasks: 0,
      },
      {
        projects: [
          {
            project: { id: 7, name: 'Repo' },
            deviceWorkspaces: [cloudWorkspace],
            totalTasks: 1,
          },
        ],
        chats: [],
        totalTasks: 1,
      }
    )

    expect(merged.projects[0].deviceWorkspaces).toEqual([
      expect.objectContaining({
        id: 101,
        deviceId: 'local-device',
        deviceName: 'Local Executor',
        workspacePath: '/workspace/repo',
        tasks: [expect.objectContaining({ taskId: 'task-cloud' })],
      }),
    ])
  })

  test('merges runtime projects with different route keys when their canonical workspace matches', () => {
    const localDevice = device({
      device_id: 'local-device',
      name: 'Local Executor',
      device_type: 'local',
    })
    const cloudDevice = device({
      device_id: 'cloud-device',
      app_device_id: 'local-device',
      device_type: 'cloud',
    })
    const localWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'local:/workspace/repo', name: 'Repo' },
          deviceWorkspaces: [workspace('local-device', [])],
          totalTasks: 0,
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    const cloudWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'cloud:/workspace/repo', name: 'Repo' },
          deviceWorkspaces: [workspace('cloud-device', [{ taskId: 'task-cloud' }])],
          totalTasks: 1,
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const started = startCloudRuntimeSync(EMPTY_CLOUD_RUNTIME_STATE, 'bootstrap', [
      'devices',
      'runtimeWork',
    ])
    const ready = finishCloudRuntimeSync(started, started.inFlightRevision ?? 0, {
      devices: { status: 'fulfilled', value: [cloudDevice] },
      runtimeWork: { status: 'fulfilled', value: cloudWork },
    })

    const visibleDevices = selectVisibleDevices([localDevice], ready)
    const runtimeView = selectRuntimeWorkView(localWork, ready, visibleDevices)

    expect(runtimeView.projects).toHaveLength(1)
    expect(runtimeView.projects[0].project.key).toBe('local:/workspace/repo')
    expect(runtimeView.projects[0].deviceWorkspaces).toHaveLength(1)
    expect(runtimeView.projects[0].deviceWorkspaces[0]).toMatchObject({
      deviceId: 'local-device',
      workspacePath: '/workspace/repo',
    })
    expect(runtimeView.projects[0].deviceWorkspaces[0].tasks.map(task => task.taskId)).toEqual([
      'task-cloud',
    ])
  })

  test('merges a local Codex remote descriptor with its remote executor project in global order', () => {
    const remoteWorkspace = {
      ...workspace('remote-device', []),
      workspacePath: '/srv/repo',
      workspaceSource: 'remote',
      remoteHostId: 'remote-device',
      available: false,
    }
    const localWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: '/local/a', name: 'Local A' },
          deviceWorkspaces: [{ ...workspace('local-device', []), workspacePath: '/local/a' }],
        },
        {
          project: {
            key: 'remote-project-id',
            sidebarStateKey: 'remote-project-id',
            name: 'Remote',
            kind: 'remote',
            source: 'remote_project',
            stateDeviceId: 'local-device',
            pinned: true,
            pinnedOrder: 0,
            active: true,
          },
          deviceWorkspaces: [remoteWorkspace],
        },
        {
          project: { key: '/local/b', name: 'Local B' },
          deviceWorkspaces: [{ ...workspace('local-device', []), workspacePath: '/local/b' }],
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    const remoteWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: '/srv/repo', name: 'Remote executor project' },
          deviceWorkspaces: [
            {
              ...remoteWorkspace,
              workspaceSource: 'local',
              remoteHostId: undefined,
              available: true,
              tasks: [{ taskId: 'remote-task', title: 'Remote task' }],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }

    const merged = mergeRuntimeWorkLists(localWork, remoteWork, {
      devices: [device({ device_id: 'remote-device', device_type: 'remote' })],
    })

    expect(merged.projects.map(project => project.project.name)).toEqual([
      'Local A',
      'Remote',
      'Local B',
    ])
    expect(merged.projects[1].project).toMatchObject({
      key: '/srv/repo',
      sidebarStateKey: 'remote-project-id',
      stateDeviceId: 'local-device',
      pinned: true,
      pinnedOrder: 0,
      active: true,
    })
    expect(merged.projects[1].deviceWorkspaces).toEqual([
      expect.objectContaining({
        deviceId: 'remote-device',
        workspacePath: '/srv/repo',
        workspaceSource: 'remote',
        remoteHostId: 'remote-device',
        tasks: [expect.objectContaining({ taskId: 'remote-task' })],
      }),
    ])
  })
})
