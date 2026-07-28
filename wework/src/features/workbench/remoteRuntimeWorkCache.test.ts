import { beforeEach, describe, expect, test } from 'vitest'
import type { DeviceInfo, RuntimeDeviceWorkspace, RuntimeWorkListResponse } from '@/types/api'
import { mergeRuntimeWorkLists } from './workbenchCloudStatus'
import {
  createRemoteRuntimeWorkCacheSnapshot,
  readCachedRemoteRuntimeWork,
  reconcileCachedRemoteRuntimeWork,
  writeCachedRemoteRuntimeWork,
} from './remoteRuntimeWorkCache'

function workspace(
  deviceId: string,
  taskId: string,
  overrides: Partial<RuntimeDeviceWorkspace> = {}
): RuntimeDeviceWorkspace {
  return {
    deviceId,
    deviceName: deviceId,
    deviceStatus: 'online',
    available: true,
    workspacePath: `/srv/${deviceId}`,
    workspaceKind: 'workspace',
    workspaceSource: 'local',
    mapped: true,
    tasks: [
      {
        taskId,
        threadId: `thread-${taskId}`,
        workspacePath: `/srv/${deviceId}`,
        title: taskId,
        runtime: 'codex',
        updatedAt: '2026-07-17T00:00:00Z',
        running: true,
      },
    ],
    ...overrides,
  }
}

function runtimeWork(...workspaces: RuntimeDeviceWorkspace[]): RuntimeWorkListResponse {
  const projects = workspaces.map((deviceWorkspace, index) => ({
    project: {
      key: deviceWorkspace.workspacePath,
      name: `Remote ${index + 1}`,
    },
    deviceWorkspaces: [deviceWorkspace],
    totalTasks: deviceWorkspace.tasks.length,
  }))
  return {
    projects,
    chats: [],
    totalTasks: projects.reduce((total, project) => total + (project.totalTasks ?? 0), 0),
  }
}

function device(
  deviceId: string,
  status: DeviceInfo['status'],
  overrides: Partial<DeviceInfo> = {}
): DeviceInfo {
  return {
    id: deviceId === 'remote-a' ? 1 : 2,
    device_id: deviceId,
    name: deviceId,
    status,
    is_default: false,
    device_type: 'remote',
    bind_shell: 'claudecode',
    ...overrides,
  }
}

describe('remote runtime work cache', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('persists only sidebar summary fields and restores them as unavailable', () => {
    const input = runtimeWork(
      workspace('remote-a', 'task-a', {
        repoUrl: 'git@example.com:team/repo.git',
        tasks: [
          {
            taskId: 'task-a',
            threadId: 'thread-a',
            workspacePath: '/srv/remote-a',
            title: 'Cached task',
            runtime: 'codex',
            updatedAt: '2026-07-17T00:00:00Z',
            running: true,
            pinned: true,
            gitInfo: {
              branch: 'feature/offline-cache',
              secret: 'must-not-persist',
            },
            runtimeHandle: { threadId: 'thread-a', transcript: 'full conversation' },
            modelSelection: { modelName: 'gpt-5', options: { reasoningEffort: 'high' } },
            parent: { taskId: 'parent' },
            children: [{ taskId: 'child' }],
          },
        ],
      })
    )

    writeCachedRemoteRuntimeWork(7, input, [
      device('remote-a', 'online', { client_ip: '10.201.3.200' }),
    ])
    const restored = readCachedRemoteRuntimeWork(7)
    const restoredWorkspace = restored.projects[0].deviceWorkspaces[0]
    const restoredTask = restoredWorkspace.tasks[0]

    expect(restoredWorkspace).toMatchObject({
      deviceId: 'remote-a',
      deviceName: '10.201.3.200',
      deviceStatus: 'offline',
      available: false,
      workspaceSource: 'remote',
      remoteHostId: 'remote-a',
      repoUrl: 'git@example.com:team/repo.git',
    })
    expect(restoredTask).toMatchObject({
      taskId: 'task-a',
      threadId: 'thread-a',
      title: 'Cached task',
      runtime: 'codex',
      running: false,
      pinned: true,
      gitInfo: { branch: 'feature/offline-cache' },
    })
    expect(restoredTask).not.toHaveProperty('runtimeHandle')
    expect(restoredTask).not.toHaveProperty('modelSelection')
    expect(restoredTask).not.toHaveProperty('parent')
    expect(restoredTask).not.toHaveProperty('children')
    expect(localStorage.getItem('wework.workbench.remoteRuntimeWork.v1.7')).not.toContain(
      'must-not-persist'
    )
    expect(localStorage.getItem('wework.workbench.remoteRuntimeWork.v1.7')).not.toContain(
      'full conversation'
    )
  })

  test('isolates cache entries by user and ignores malformed data', () => {
    writeCachedRemoteRuntimeWork(7, runtimeWork(workspace('remote-a', 'task-a')))

    expect(readCachedRemoteRuntimeWork(8)).toEqual({
      projects: [],
      chats: [],
      totalTasks: 0,
    })

    localStorage.setItem('wework.workbench.remoteRuntimeWork.v1.7', '{')
    expect(readCachedRemoteRuntimeWork(7)).toEqual({
      projects: [],
      chats: [],
      totalTasks: 0,
    })
  })

  test('preserves offline hosts while replacing an online host with live tasks', () => {
    const cached = createRemoteRuntimeWorkCacheSnapshot(
      runtimeWork(workspace('remote-a', 'cached-a'), workspace('remote-b', 'stale-b'))
    )
    const live = runtimeWork(workspace('remote-b', 'fresh-b'))

    const reconciled = reconcileCachedRemoteRuntimeWork(cached, live, [
      device('remote-a', 'offline'),
      device('remote-b', 'online'),
    ])

    expect(
      reconciled.projects.flatMap(project =>
        project.deviceWorkspaces.flatMap(deviceWorkspace =>
          deviceWorkspace.tasks.map(task => task.taskId)
        )
      )
    ).toEqual(['cached-a', 'fresh-b'])
    expect(
      reconciled.projects
        .flatMap(project => project.deviceWorkspaces)
        .find(deviceWorkspace => deviceWorkspace.deviceId === 'remote-a')
    ).toMatchObject({ available: false, deviceStatus: 'offline' })
    expect(
      reconciled.projects
        .flatMap(project => project.deviceWorkspaces)
        .find(deviceWorkspace => deviceWorkspace.deviceId === 'remote-b')?.tasks[0]
    ).toMatchObject({ running: true })
  })

  test('cleans tasks for online or deleted devices after a successful full refresh', () => {
    const cached = createRemoteRuntimeWorkCacheSnapshot(
      runtimeWork(workspace('remote-a', 'deleted-a'), workspace('remote-b', 'deleted-b'))
    )

    const reconciled = reconcileCachedRemoteRuntimeWork(cached, runtimeWork(), [
      device('remote-b', 'online'),
    ])

    expect(reconciled).toEqual({ projects: [], chats: [], totalTasks: 0 })
  })

  test('keeps cached tasks when device discovery is unavailable', () => {
    const cached = createRemoteRuntimeWorkCacheSnapshot(
      runtimeWork(workspace('remote-a', 'cached-a'))
    )

    const reconciled = reconcileCachedRemoteRuntimeWork(cached, runtimeWork())

    expect(reconciled.projects[0].deviceWorkspaces[0].tasks[0].taskId).toBe('cached-a')
  })

  test('groups a cached task under the locally persisted remote project descriptor', () => {
    const localDescriptor: RuntimeWorkListResponse = {
      projects: [
        {
          project: {
            key: 'remote-project-id',
            sidebarStateKey: 'remote-project-id',
            name: 'Remote repository',
            kind: 'remote',
            source: 'remote_project',
            stateDeviceId: 'local-device',
          },
          deviceWorkspaces: [
            {
              deviceId: 'remote-a',
              deviceName: '10.201.3.200',
              deviceStatus: 'offline',
              available: false,
              workspacePath: '/srv/remote-a',
              workspaceSource: 'remote',
              remoteHostId: 'remote-a',
              mapped: true,
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    }
    const cached = createRemoteRuntimeWorkCacheSnapshot(
      runtimeWork(workspace('remote-a', 'cached-a'))
    )

    const merged = mergeRuntimeWorkLists(localDescriptor, cached)

    expect(merged.projects).toHaveLength(1)
    expect(merged.projects[0].project).toMatchObject({
      name: 'Remote repository',
      sidebarStateKey: 'remote-project-id',
    })
    expect(merged.projects[0].deviceWorkspaces[0].tasks[0].taskId).toBe('cached-a')
  })
})
