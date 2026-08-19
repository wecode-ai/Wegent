import { describe, expect, test } from 'vitest'
import type { RuntimeDeviceWorkspace } from '@/types/api'
import {
  hasExpandedRuntimeSidebarTaskItems,
  getNextRuntimeSidebarTaskVisibleLimit,
  getRuntimeChatSidebarTaskItems,
  getRuntimeSidebarTaskItems,
  getRuntimeTaskAddress,
  getVisibleRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
} from './runtimeTaskSidebarHelpers'

describe('runtimeTaskSidebarHelpers', () => {
  test('uses persisted sidebar order before activity time', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        {
          taskId: 'newer-second',
          workspacePath: '/workspace/repo',
          title: 'Newer second',
          runtime: 'codex',
          sidebarOrder: 1,
          completedAt: '2026-08-12T03:00:00.000Z',
        },
        {
          taskId: 'older-first',
          workspacePath: '/workspace/repo',
          title: 'Older first',
          runtime: 'codex',
          sidebarOrder: 0,
          completedAt: '2026-08-12T02:00:00.000Z',
        },
      ],
    }

    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'older-first',
      'newer-second',
    ])
  })

  test('places a newly created unordered task before manually ordered project tasks', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        ...Array.from({ length: RUNTIME_PROJECT_TASK_PREVIEW_LIMIT + 1 }, (_, index) => ({
          taskId: `ordered-${index + 1}`,
          workspacePath: '/workspace/repo',
          title: `Ordered ${index + 1}`,
          runtime: 'codex' as const,
          sidebarOrder: index,
          updatedAt: `2026-08-18T0${index + 1}:00:00.000Z`,
        })),
        {
          taskId: 'new-task',
          workspacePath: '/workspace/repo',
          title: 'New task',
          runtime: 'codex',
          status: 'creating',
          optimistic: true,
          createdAt: '2026-08-19T01:00:00.000Z',
          updatedAt: '2026-08-19T01:00:00.000Z',
        },
      ],
    }

    const items = getRuntimeSidebarTaskItems([workspace])

    expect(items.map(item => item.task.taskId)).toEqual([
      'new-task',
      'ordered-1',
      'ordered-2',
      'ordered-3',
      'ordered-4',
      'ordered-5',
      'ordered-6',
    ])
    expect(getVisibleRuntimeSidebarTaskItems(items).map(item => item.task.taskId)).toEqual([
      'new-task',
      'ordered-1',
      'ordered-2',
      'ordered-3',
      'ordered-4',
    ])
  })

  test('sorts tasks without manual order by latest activity', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/chats',
      workspaceKind: 'chat',
      available: true,
      tasks: [
        {
          taskId: 'recently-reactivated',
          workspacePath: '/workspace/chats/recently-reactivated',
          workspaceKind: 'chat',
          title: 'Recently reactivated',
          runtime: 'codex',
          createdAt: '2026-08-01T02:00:00.000Z',
          updatedAt: '2026-08-17T02:00:00.000Z',
        },
        {
          taskId: 'previously-first',
          workspacePath: '/workspace/chats/previously-first',
          workspaceKind: 'chat',
          title: 'Previously first',
          runtime: 'codex',
          createdAt: '2026-08-16T02:00:00.000Z',
          updatedAt: '2026-08-16T02:00:00.000Z',
        },
      ],
    }

    expect(getRuntimeChatSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'recently-reactivated',
      'previously-first',
    ])
  })

  test('keeps the current task visible beyond the collapsed ordered task list', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: Array.from({ length: RUNTIME_PROJECT_TASK_PREVIEW_LIMIT + 2 }, (_, index) => ({
        taskId: `ordered-${index + 1}`,
        workspacePath: '/workspace/repo',
        title: `Ordered ${index + 1}`,
        runtime: 'codex' as const,
        sidebarOrder: index,
        completedAt:
          index === RUNTIME_PROJECT_TASK_PREVIEW_LIMIT + 1
            ? '2026-08-11T00:00:00.000Z'
            : `2026-08-12T0${index + 1}:00:00.000Z`,
      })),
    }

    const items = getRuntimeSidebarTaskItems([workspace])

    expect(
      getVisibleRuntimeSidebarTaskItems(
        items,
        RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
        'ordered-6',
        item => item.task.taskId === 'ordered-7'
      ).map(item => item.task.taskId)
    ).toEqual([
      'ordered-1',
      'ordered-2',
      'ordered-3',
      'ordered-4',
      'ordered-5',
      'ordered-6',
      'ordered-7',
    ])
  })

  test('keeps the most recently completed task visible beyond the collapsed ordered task list', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: Array.from({ length: RUNTIME_PROJECT_TASK_PREVIEW_LIMIT + 1 }, (_, index) => ({
        taskId: `ordered-${index + 1}`,
        workspacePath: '/workspace/repo',
        title: `Ordered ${index + 1}`,
        runtime: 'codex' as const,
        sidebarOrder: index,
        completedAt:
          index === RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
            ? '2026-08-14T09:00:00.000Z'
            : `2026-08-12T0${index + 1}:00:00.000Z`,
      })),
    }

    expect(
      getVisibleRuntimeSidebarTaskItems(getRuntimeSidebarTaskItems([workspace])).map(
        item => item.task.taskId
      )
    ).toEqual(['ordered-1', 'ordered-2', 'ordered-3', 'ordered-4', 'ordered-5', 'ordered-6'])
  })

  test('sorts runtime task items newest first across workspaces', () => {
    const oldWorkspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        {
          taskId: 'older-running',
          workspacePath: '/workspace/repo',
          title: 'Older running',
          runtime: 'codex',
          running: true,
          completedAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
        {
          taskId: 'newer-idle',
          workspacePath: '/workspace/repo',
          title: 'Newer idle',
          runtime: 'codex',
          running: false,
          completedAt: '2026-06-02T00:00:00.000Z',
          updatedAt: '2026-06-02T00:00:00.000Z',
        },
      ],
    }
    const newWorkspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo/.worktrees/new-task',
      workspaceKind: 'worktree',
      available: true,
      tasks: [
        {
          taskId: 'new-worktree-task',
          workspacePath: '/workspace/repo/.worktrees/new-task',
          title: 'New worktree task',
          runtime: 'codex',
          running: true,
          completedAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:00:00.000Z',
        },
      ],
    }

    expect(
      getRuntimeSidebarTaskItems([oldWorkspace, newWorkspace]).map(item => item.task.taskId)
    ).toEqual(['new-worktree-task', 'newer-idle', 'older-running'])
  })

  test('hides automation manager sessions only from the standalone task list', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/chats',
      workspaceKind: 'chat',
      available: true,
      tasks: [
        {
          taskId: 'automation-manager',
          workspacePath: '/workspace/chats/automation-manager',
          workspaceKind: 'chat',
          title: 'Automation manager',
          runtime: 'codex',
          runtimeHandle: {
            origin: {
              type: 'project_automation',
              automationRole: 'manager',
              run_id: 'run-1',
            },
          },
        },
        {
          taskId: 'project-robot',
          workspacePath: '/workspace/chats/project-robot',
          workspaceKind: 'chat',
          title: 'Project robot',
          runtime: 'codex',
          runtimeHandle: {
            origin: {
              type: 'project_automation',
              run_id: 'run-1',
            },
          },
        },
        {
          taskId: 'ordinary-task',
          workspacePath: '/workspace/chats/ordinary-task',
          workspaceKind: 'chat',
          title: 'Ordinary task',
          runtime: 'codex',
        },
      ],
    }

    expect(getRuntimeChatSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'project-robot',
      'ordinary-task',
    ])
    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toContain(
      'automation-manager'
    )
  })

  test('sorts queued runtime tasks by their real execution position', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        {
          taskId: 'queued-second',
          workspacePath: '/workspace/repo',
          title: 'Queued second',
          runtime: 'codex',
          running: false,
          status: 'queued',
          queuePosition: 2,
          updatedAt: '2026-08-12T03:00:00.000Z',
        },
        {
          taskId: 'queued-first',
          workspacePath: '/workspace/repo',
          title: 'Queued first',
          runtime: 'codex',
          running: false,
          status: 'queued',
          queuePosition: 1,
          updatedAt: '2026-08-12T02:00:00.000Z',
        },
      ],
    }

    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'queued-first',
      'queued-second',
    ])
  })

  test('preserves recency slots while sorting each device queue independently', () => {
    const workspaces: RuntimeDeviceWorkspace[] = [
      {
        deviceId: 'device-1',
        workspacePath: '/workspace/one',
        available: true,
        tasks: [
          {
            taskId: 'device-one-second',
            workspacePath: '/workspace/one',
            title: 'Device one second',
            runtime: 'codex',
            running: false,
            status: 'queued',
            queuePosition: 2,
            updatedAt: '2026-08-12T05:00:00.000Z',
          },
          {
            taskId: 'device-one-first',
            workspacePath: '/workspace/one',
            title: 'Device one first',
            runtime: 'codex',
            running: false,
            status: 'queued',
            queuePosition: 1,
            updatedAt: '2026-08-12T02:00:00.000Z',
          },
        ],
      },
      {
        deviceId: 'device-2',
        workspacePath: '/workspace/two',
        available: true,
        tasks: [
          {
            taskId: 'device-two-running',
            workspacePath: '/workspace/two',
            title: 'Device two running',
            runtime: 'codex',
            running: true,
            status: 'running',
            updatedAt: '2026-08-12T04:00:00.000Z',
          },
          {
            taskId: 'device-two-first',
            workspacePath: '/workspace/two',
            title: 'Device two first',
            runtime: 'codex',
            running: false,
            status: 'queued',
            queuePosition: 1,
            updatedAt: '2026-08-12T03:00:00.000Z',
          },
        ],
      },
    ]

    expect(getRuntimeSidebarTaskItems(workspaces).map(item => item.task.taskId)).toEqual([
      'device-one-first',
      'device-two-running',
      'device-two-first',
      'device-one-second',
    ])
  })

  test('moves a resumed task to the top while its latest turn is streaming', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        {
          taskId: 'running',
          workspacePath: '/workspace/repo',
          title: 'Running',
          runtime: 'codex',
          running: true,
          createdAt: '2026-06-01T00:00:00.000Z',
          completedAt: '2026-06-02T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        },
        {
          taskId: 'completed',
          workspacePath: '/workspace/repo',
          title: 'Completed',
          runtime: 'codex',
          running: false,
          createdAt: '2026-06-01T00:00:00.000Z',
          completedAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:00:00.000Z',
        },
      ],
    }

    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'running',
      'completed',
    ])
  })

  test('keeps a recently updated task first after its latest turn completes', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        {
          taskId: 'streaming',
          workspacePath: '/workspace/repo',
          title: 'Streaming',
          runtime: 'codex',
          running: true,
          createdAt: '2026-06-01T00:00:00.000Z',
          completedAt: '2026-06-02T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        },
        {
          taskId: 'idle',
          workspacePath: '/workspace/repo',
          title: 'Idle',
          runtime: 'codex',
          running: false,
          createdAt: '2026-06-01T00:00:00.000Z',
          completedAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:00:00.000Z',
        },
      ],
    }

    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'streaming',
      'idle',
    ])

    workspace.tasks[0] = {
      ...workspace.tasks[0],
      running: false,
      completedAt: '2026-06-04T00:00:00.000Z',
    }

    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'streaming',
      'idle',
    ])
  })

  test('carries runtime handle into task addresses when present', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [],
    }
    const address = getRuntimeTaskAddress(workspace, {
      taskId: 'local-visible-task',
      workspacePath: '/workspace/repo',
      title: 'Existing task',
      runtime: 'codex',
      runtimeHandle: {
        threadId: 'provider-session-1',
      },
    })

    expect(address).toEqual({
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      taskId: 'local-visible-task',
      runtimeHandle: {
        threadId: 'provider-session-1',
      },
    })
  })

  test('uses a chat task path when its grouping workspace is a git worktree', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/worktrees/277/repo',
      available: true,
      tasks: [],
    }

    expect(
      getRuntimeTaskAddress(workspace, {
        taskId: 'standalone-chat',
        workspacePath: '/home/user/Documents/Codex/standalone-chat',
        title: 'Standalone chat',
        runtime: 'codex',
      })
    ).toMatchObject({
      deviceId: 'device-1',
      taskId: 'standalone-chat',
      workspacePath: '/home/user/Documents/Codex/standalone-chat',
    })
  })

  test('uses a worktree task path when grouped under its source project', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      workspaceKind: 'worktree',
      worktreeId: 'runtime-1',
      available: true,
      tasks: [],
    }

    expect(
      getRuntimeTaskAddress(workspace, {
        taskId: 'worktree-task',
        workspacePath: '/workspace/worktrees/runtime-1/repo',
        workspaceKind: 'worktree',
        worktreeId: 'runtime-1',
        title: 'Worktree task',
        runtime: 'codex',
      })
    ).toMatchObject({
      deviceId: 'device-1',
      taskId: 'worktree-task',
      workspacePath: '/workspace/worktrees/runtime-1/repo',
    })
  })

  test('reveals project runtime tasks in preview and step increments', () => {
    const items = Array.from({ length: 26 }, (_, index) => ({
      workspace: {
        deviceId: 'device-1',
        workspacePath: '/workspace/repo',
        available: true,
        tasks: [],
      },
      task: {
        taskId: `task-${index + 1}`,
        workspacePath: '/workspace/repo',
        title: `Task ${index + 1}`,
        runtime: 'codex',
      },
    }))

    expect(getVisibleRuntimeSidebarTaskItems(items)).toHaveLength(
      RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
    )
    expect(hasHiddenRuntimeSidebarTaskItems(items)).toBe(true)

    const firstExpandedLimit = getNextRuntimeSidebarTaskVisibleLimit(
      RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
      items.length
    )
    expect(firstExpandedLimit).toBe(15)
    expect(getVisibleRuntimeSidebarTaskItems(items, firstExpandedLimit)).toHaveLength(15)
    expect(hasHiddenRuntimeSidebarTaskItems(items, firstExpandedLimit)).toBe(true)

    const secondExpandedLimit = getNextRuntimeSidebarTaskVisibleLimit(
      firstExpandedLimit,
      items.length
    )
    expect(secondExpandedLimit).toBe(25)
    expect(getVisibleRuntimeSidebarTaskItems(items, secondExpandedLimit)).toHaveLength(25)
    expect(hasHiddenRuntimeSidebarTaskItems(items, secondExpandedLimit)).toBe(true)

    const finalExpandedLimit = getNextRuntimeSidebarTaskVisibleLimit(
      secondExpandedLimit,
      items.length
    )
    expect(finalExpandedLimit).toBe(26)
    expect(getVisibleRuntimeSidebarTaskItems(items, finalExpandedLimit)).toHaveLength(26)
    expect(hasHiddenRuntimeSidebarTaskItems(items, finalExpandedLimit)).toBe(false)
  })

  test('keeps pinned project runtime tasks out of the collapsed task count', () => {
    const items = Array.from({ length: 7 }, (_, index) => ({
      workspace: {
        deviceId: 'device-1',
        workspacePath: '/workspace/repo',
        available: true,
        tasks: [],
      },
      task: {
        taskId: `task-${index + 1}`,
        workspacePath: '/workspace/repo',
        title: `Task ${index + 1}`,
        runtime: 'codex',
      },
      pinned: index < 2,
    }))

    expect(getVisibleRuntimeSidebarTaskItems(items).map(item => item.task.taskId)).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
      'task-5',
      'task-6',
      'task-7',
    ])
    expect(hasHiddenRuntimeSidebarTaskItems(items)).toBe(false)
    expect(hasExpandedRuntimeSidebarTaskItems(items)).toBe(false)
  })
})
