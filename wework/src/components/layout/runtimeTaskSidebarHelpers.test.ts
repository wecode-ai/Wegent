import { describe, expect, test } from 'vitest'
import type { RuntimeDeviceWorkspace } from '@/types/api'
import {
  hasExpandedRuntimeSidebarTaskItems,
  getNextRuntimeSidebarTaskVisibleLimit,
  getRuntimeSidebarTaskItems,
  getRuntimeTaskAddress,
  getVisibleRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
} from './runtimeTaskSidebarHelpers'

describe('runtimeTaskSidebarHelpers', () => {
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

  test('does not reorder a running task when streaming updates change updatedAt', () => {
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
      'completed',
      'running',
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
