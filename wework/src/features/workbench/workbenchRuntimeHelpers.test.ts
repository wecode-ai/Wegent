import type { RuntimeWorkListResponse } from '@/types/api'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  buildRuntimeTaskTitle,
  findProjectDeviceWorkspace,
  findRuntimeTaskForPinRequest,
  getDefaultProjectDeviceWorkspaceId,
  getRuntimeTaskThreadId,
  hydrateRuntimeTaskAddress,
  MAX_RUNTIME_TASK_TITLE_LENGTH,
  projectTaskAddresses,
  readLastProjectId,
  removeRuntimeTasks,
  resolveComposerProjectPluginNames,
  truncateRuntimeTaskTitle,
  updateRuntimeWorkTask,
  updateRuntimeWorkTaskPinned,
  updateRuntimeWorkTaskTitle,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'

describe('workbenchRuntimeHelpers', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('preserves a non-null runtime list when an update has no matching task', () => {
    const runtimeWork: RuntimeWorkListResponse = { projects: [], chats: [], totalTasks: 0 }
    const updated: RuntimeWorkListResponse = updateRuntimeWorkTask(
      runtimeWork,
      { deviceId: 'device-1', taskId: 'missing' },
      { supervisor: null }
    )

    expect(updated).toEqual(runtimeWork)
  })

  test.each([null])('does not create a runtime list from %s', runtimeWork => {
    expect(
      updateRuntimeWorkTask(runtimeWork, { deviceId: 'device-1', taskId: 'missing' }, {})
    ).toBeNull()
  })

  test('builds readable titles from structured plugin mentions', () => {
    expect(buildRuntimeTaskTitle('[$linear](/tmp/linear/SKILL.md) ')).toBe('$linear')
    expect(buildRuntimeTaskTitle('Use [$calendar](app://calendar) today')).toBe(
      'Use $calendar today'
    )
    expect(buildRuntimeTaskTitle('Ask [@sample](plugin://sample@local) to help')).toBe(
      'Ask @sample to help'
    )
  })

  test('limits runtime task titles for compact display and terminal context', () => {
    const title = 'a'.repeat(MAX_RUNTIME_TASK_TITLE_LENGTH + 1)

    expect(truncateRuntimeTaskTitle(title)).toBe(
      `${'a'.repeat(MAX_RUNTIME_TASK_TITLE_LENGTH - 1)}…`
    )
    expect(buildRuntimeTaskTitle(title)).toBe(`${'a'.repeat(MAX_RUNTIME_TASK_TITLE_LENGTH - 1)}…`)
  })

  test('carries runtime handles into project task addresses', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'legacy:7', id: 7, name: 'Wegent' },
          totalTasks: 1,
          deviceWorkspaces: [
            {
              id: 22,
              projectId: 7,
              deviceId: 'device-1',
              deviceName: 'Project Device',
              deviceStatus: 'online',
              workspacePath: '/workspace/project-alpha',
              mapped: true,
              available: true,
              tasks: [
                {
                  taskId: 'local-visible-task',
                  threadId: 'direct-thread-id',
                  workspacePath: '/workspace/project-alpha',
                  title: 'Fix guidance',
                  runtime: 'codex',
                  runtimeHandle: {
                    threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
                  },
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }

    expect(projectTaskAddresses(runtimeWork, ['legacy:7'])).toEqual([
      {
        deviceId: 'device-1',
        workspacePath: '/workspace/project-alpha',
        taskId: 'local-visible-task',
        threadId: 'direct-thread-id',
        runtimeHandle: {
          threadId: '019ee7f6-456a-78a1-96b1-66451afc310e',
        },
      },
    ])
  })

  test('keeps an existing task pinned to its captured project plugins', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: {
            id: 7,
            key: 'local:/workspace/project',
            name: 'Project',
            source: 'local_project',
            aiSettings: {
              plugins: [
                {
                  id: 'current-plugin@team-market',
                  pluginName: 'current-plugin',
                  marketplaceId: 'team-market',
                  displayName: 'Current Plugin',
                },
              ],
            },
          },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              available: true,
              mapped: true,
              workspacePath: '/workspace/project',
              tasks: [
                {
                  taskId: 'existing-task',
                  workspacePath: '/workspace/project',
                  title: 'Existing conversation',
                  runtime: 'codex',
                  projectPluginIds: ['captured-plugin@personal'],
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }

    expect(
      resolveComposerProjectPluginNames(runtimeWork, 7, {
        deviceId: 'local-device',
        taskId: 'existing-task',
        workspacePath: '/workspace/project',
      })
    ).toEqual(['captured-plugin'])
  })

  test('hydrates inherited worktree details through the remote host identity', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'local:/workspace/project', name: 'Project' },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              remoteHostId: 'device-1',
              available: true,
              workspacePath: '/workspace/worktrees/login',
              workspaceKind: 'worktree',
              worktreeId: 'login',
              tasks: [
                {
                  taskId: 'development-task',
                  threadId: 'development-thread',
                  workspacePath: '/workspace/worktrees/login',
                  title: 'Develop login',
                  runtime: 'codex',
                  runtimeHandle: { threadId: 'development-thread' },
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }

    expect(
      hydrateRuntimeTaskAddress(runtimeWork, {
        deviceId: 'device-1',
        taskId: 'development-task',
      })
    ).toMatchObject({
      workspacePath: '/workspace/worktrees/login',
      threadId: 'development-thread',
      runtimeHandle: { threadId: 'development-thread' },
    })
  })

  test('updates a project task pin through the project state device identity', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: {
            key: 'local:/workspace/project',
            name: 'Project',
            stateDeviceId: 'state-device',
          },
          deviceWorkspaces: [
            {
              deviceId: 'runtime-device',
              available: true,
              workspacePath: '/workspace/project',
              tasks: [
                {
                  taskId: 'task-1',
                  threadId: 'thread-1',
                  workspacePath: '/workspace/project',
                  title: 'Pinned automation target',
                  runtime: 'codex',
                  pinned: false,
                  pinnedOrder: 4,
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const request = {
      deviceId: 'state-device',
      threadId: 'thread-1',
      pinned: true,
    }

    expect(findRuntimeTaskForPinRequest(runtimeWork, request)?.taskId).toBe('task-1')
    expect(
      updateRuntimeWorkTaskPinned(runtimeWork, request)?.projects[0].deviceWorkspaces[0].tasks[0]
        .pinned
    ).toBe(true)
    expect(runtimeWork.projects[0].deviceWorkspaces[0].tasks[0].pinned).toBe(false)
  })

  test('uses a persisted Codex task id as the pin thread fallback', () => {
    expect(
      getRuntimeTaskThreadId({
        taskId: 'persisted-thread',
        title: 'Legacy Codex task',
        runtime: 'codex',
      })
    ).toBe('persisted-thread')
    expect(
      getRuntimeTaskThreadId({
        taskId: 'optimistic-task',
        title: 'Pending Codex task',
        runtime: 'codex',
        optimistic: true,
      })
    ).toBeNull()
  })

  test('removes an archived device task even when its workspace path was normalized', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [],
      chats: [
        {
          deviceId: 'device-1',
          workspacePath: '/home/user/Documents/Codex/task',
          available: true,
          tasks: [
            {
              taskId: 'standalone-chat',
              workspacePath: '/home/user/Documents/Codex/task',
              title: 'Standalone chat',
              runtime: 'codex',
            },
          ],
        },
      ],
      totalTasks: 1,
    }

    expect(
      removeRuntimeTasks(runtimeWork, [
        {
          deviceId: 'device-1',
          taskId: 'standalone-chat',
          workspacePath: '/workspace/repository',
        },
      ]).totalTasks
    ).toBe(0)
  })

  test('updates a runtime task title through its remote host identity', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          remoteHostId: 'device-1',
          workspacePath: '/workspace/project-alpha',
          available: true,
          tasks: [
            {
              taskId: 'runtime-a',
              workspacePath: '/workspace/project-alpha',
              title: '解决冲突',
              runtime: 'codex',
            },
            {
              taskId: 'runtime-b',
              workspacePath: '/workspace/project-alpha',
              title: '未修改',
              runtime: 'codex',
            },
          ],
        },
      ],
      totalTasks: 2,
    }

    const updated = updateRuntimeWorkTaskTitle(
      runtimeWork,
      { deviceId: 'device-1', taskId: 'runtime-a' },
      '解决分支冲突'
    )

    expect(updated?.chats[0]?.tasks.map(task => task.title)).toEqual(['解决分支冲突', '未修改'])
  })

  test('stores the last project per backend and owner and ignores invalid values', () => {
    const owner = JSON.stringify(['https://first.example/api', 7])
    const otherBackend = JSON.stringify(['https://second.example/api', 7])
    const otherUser = JSON.stringify(['https://first.example/api', 8])
    writeLastProjectId(owner, 42)

    expect(readLastProjectId(owner)).toBe(42)
    expect(readLastProjectId(otherBackend)).toBeUndefined()
    expect(readLastProjectId(otherUser)).toBeUndefined()

    writeLastProjectId(owner, null)
    expect(readLastProjectId(owner)).toBeNull()

    localStorage.setItem(`wework.lastProjectId.${owner}`, 'not-a-project')
    expect(readLastProjectId(owner)).toBeUndefined()
  })

  test('keeps multi-location non-local projects explicit', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { id: 7, key: 'remote-product', name: 'Product', source: 'remote_project' },
          deviceWorkspaces: ['/workspace/web', '/workspace/api'].map((workspacePath, index) => ({
            id: 11 + index,
            deviceId: `device-${index + 1}`,
            workspacePath,
            available: true,
            tasks: [],
          })),
        },
      ],
      chats: [],
      totalTasks: 0,
    }

    expect(getDefaultProjectDeviceWorkspaceId(runtimeWork, 7)).toBeNull()
    expect(findProjectDeviceWorkspace(runtimeWork, 7, null)).toBeNull()
  })
})
