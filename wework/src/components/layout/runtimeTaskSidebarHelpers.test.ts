import { describe, expect, test } from 'vitest'
import type { RuntimeDeviceWorkspace } from '@/types/api'
import {
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
      localTasks: [
        {
          localTaskId: 'older-running',
          workspacePath: '/workspace/repo',
          title: 'Older running',
          runtime: 'codex',
          running: true,
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
        {
          localTaskId: 'newer-idle',
          workspacePath: '/workspace/repo',
          title: 'Newer idle',
          runtime: 'codex',
          running: false,
          updatedAt: '2026-06-02T00:00:00.000Z',
        },
      ],
    }
    const newWorkspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo/.worktrees/new-task',
      workspaceKind: 'worktree',
      available: true,
      localTasks: [
        {
          localTaskId: 'new-worktree-task',
          workspacePath: '/workspace/repo/.worktrees/new-task',
          title: 'New worktree task',
          runtime: 'codex',
          running: true,
          updatedAt: '2026-06-03T00:00:00.000Z',
        },
      ],
    }

    expect(
      getRuntimeSidebarTaskItems([oldWorkspace, newWorkspace]).map(item => item.task.localTaskId)
    ).toEqual(['new-worktree-task', 'newer-idle', 'older-running'])
  })

  test('carries runtime handle into task addresses when present', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      localTasks: [],
    }
    const address = getRuntimeTaskAddress(workspace, {
      localTaskId: 'local-visible-task',
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
      localTaskId: 'local-visible-task',
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
        localTasks: [],
      },
      task: {
        localTaskId: `task-${index + 1}`,
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
})
