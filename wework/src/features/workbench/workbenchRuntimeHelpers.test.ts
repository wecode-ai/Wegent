import { beforeEach, describe, expect, test } from 'vitest'
import {
  buildRuntimeTaskTitle,
  findRuntimeTaskForPinRequest,
  findProjectDeviceWorkspace,
  getRuntimeTaskThreadId,
  getDefaultProjectDeviceWorkspaceId,
  hydrateRuntimeTaskAddress,
  MAX_RUNTIME_TASK_TITLE_LENGTH,
  mergeRuntimeTaskHandles,
  projectTaskAddresses,
  readLastProjectId,
  removeRuntimeTasks,
  resolveComposerProjectPluginNames,
  truncateRuntimeTaskTitle,
  updateRuntimeWorkTaskPinned,
  updateRuntimeWorkTaskTitle,
  writeLastProjectId,
} from './workbenchRuntimeHelpers'
import type { RuntimeWorkListResponse } from '@/types/api'

describe('workbenchRuntimeHelpers', () => {
  beforeEach(() => {
    localStorage.clear()
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

  test('removes leading plugin mentions from task titles', () => {
    expect(buildRuntimeTaskTitle('[$Sites](plugin://sites) 创建一个 OKR 网站')).toBe(
      '创建一个 OKR 网站'
    )
    expect(
      buildRuntimeTaskTitle(
        '[$Sites](plugin://sites) [@designer](plugin://designer) Build a portal'
      )
    ).toBe('Build a portal')
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

  test('hydrates an inherited task address with its exact worktree path', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: { key: 'local:/workspace/project', name: 'Project' },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
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
        deviceId: 'local-device',
        taskId: 'development-task',
      })
    ).toEqual({
      deviceId: 'local-device',
      taskId: 'development-task',
      runtime: 'codex',
      threadId: 'development-thread',
      workspacePath: '/workspace/worktrees/login',
      runtimeHandle: { threadId: 'development-thread' },
    })
  })

  test('uses project plugins for a new conversation draft without captured task plugins', () => {
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
                  id: 'quality-gate@team-market',
                  pluginName: 'quality-gate',
                  marketplaceId: 'team-market',
                  displayName: 'Quality Gate',
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
                  taskId: 'draft-task',
                  workspacePath: '/workspace/project',
                  title: 'New conversation',
                  runtime: 'codex',
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
        taskId: 'draft-task',
        workspacePath: '/workspace/project',
      })
    ).toEqual(['quality-gate'])
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

  test('merges runtime task handles without dropping existing metadata', () => {
    expect(
      mergeRuntimeTaskHandles(
        {
          modelSelection: {
            modelName: 'local-model:luna',
            modelType: 'runtime',
            options: {},
          },
          threadId: 'pending-thread',
        },
        {
          threadId: 'ready-thread',
          turnId: 'turn-1',
        }
      )
    ).toEqual({
      modelSelection: {
        modelName: 'local-model:luna',
        modelType: 'runtime',
        options: {},
      },
      threadId: 'ready-thread',
      turnId: 'turn-1',
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

  test('stores the last project per user and ignores invalid values', () => {
    writeLastProjectId(7, 42)

    expect(readLastProjectId(7)).toBe(42)
    expect(readLastProjectId(8)).toBeUndefined()

    writeLastProjectId(7, null)
    expect(readLastProjectId(7)).toBeNull()

    localStorage.setItem('wework.lastProjectId.7', 'not-a-project')
    expect(readLastProjectId(7)).toBeUndefined()
  })

  test('selects the primary root for a multi-root local project', () => {
    const runtimeWork: RuntimeWorkListResponse = {
      projects: [
        {
          project: {
            id: 7,
            key: 'product',
            name: 'Product',
            source: 'local_project',
            roots: [
              { kind: 'local', path: '/workspace/web/' },
              { kind: 'local', path: '/workspace/api' },
            ],
          },
          deviceWorkspaces: [
            {
              id: 12,
              deviceId: 'device-1',
              workspacePath: '/workspace/api',
              available: true,
              tasks: [],
            },
            {
              id: 11,
              deviceId: 'device-1',
              workspacePath: '/workspace/web',
              available: true,
              tasks: [],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 0,
    }

    expect(getDefaultProjectDeviceWorkspaceId(runtimeWork, 7)).toBe(11)
    expect(findProjectDeviceWorkspace(runtimeWork, 7, null)?.workspacePath).toBe('/workspace/web')
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
