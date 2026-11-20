// @vitest-environment node

import type { RuntimeDeviceWorkspace } from '@/types/api'
import { describe, expect, test } from 'vitest'
import {
  getRuntimeSidebarTaskItems,
  getNextRuntimeSidebarTaskVisibleLimit,
  getVisibleRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
  sortRuntimeTaskItems,
} from './runtimeTaskSidebarHelpers'

describe('runtimeTaskSidebarHelpers', () => {
  test.each([
    ['missing', [undefined, 0, 1]],
    ['present', [9, 0, 1]],
  ])('ignores %s sidebarOrder values when sorting ordinary tasks', (_label, sidebarOrders) => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        ...Array.from({ length: 3 }, (_, index) => ({
          taskId: `task-${index + 1}`,
          workspacePath: '/workspace/repo',
          title: `Task ${index + 1}`,
          runtime: 'codex' as const,
          ...(sidebarOrders[index] === undefined ? {} : { sidebarOrder: sidebarOrders[index] }),
          updatedAt: `2026-08-18T0${index + 1}:00:00.000Z`,
          recencyAt: `2026-08-18T0${index + 1}:00:00.000Z`,
        })),
      ],
    }

    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'task-3',
      'task-2',
      'task-1',
    ])
  })

  test('reports only unpinned tasks that are absent from the rendered task list', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: Array.from({ length: RUNTIME_PROJECT_TASK_PREVIEW_LIMIT + 1 }, (_, index) => ({
        taskId: `task-${index + 1}`,
        workspacePath: '/workspace/repo',
        title: `Task ${index + 1}`,
        runtime: 'codex',
        updatedAt: `2026-08-18T0${RUNTIME_PROJECT_TASK_PREVIEW_LIMIT + 1 - index}:00:00.000Z`,
        recencyAt: `2026-08-18T0${RUNTIME_PROJECT_TASK_PREVIEW_LIMIT + 1 - index}:00:00.000Z`,
      })),
    }
    const items = getRuntimeSidebarTaskItems([workspace])

    const visibleItems = getVisibleRuntimeSidebarTaskItems(items)
    expect(visibleItems).toHaveLength(RUNTIME_PROJECT_TASK_PREVIEW_LIMIT)
    expect(hasHiddenRuntimeSidebarTaskItems(items, visibleItems)).toBe(true)

    const queuedItems = items.map(item => ({
      ...item,
      task: { ...item.task, status: 'queued' },
    }))
    const visibleQueuedItems = getVisibleRuntimeSidebarTaskItems(queuedItems)
    expect(visibleQueuedItems).toHaveLength(items.length)
    expect(hasHiddenRuntimeSidebarTaskItems(queuedItems, visibleQueuedItems)).toBe(false)

    const visibleAlwaysVisibleItems = getVisibleRuntimeSidebarTaskItems(
      items,
      RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
      undefined,
      () => true
    )
    expect(visibleAlwaysVisibleItems).toHaveLength(items.length)
    expect(hasHiddenRuntimeSidebarTaskItems(items, visibleAlwaysVisibleItems)).toBe(false)

    const visibleItemsWithCurrentTask = getVisibleRuntimeSidebarTaskItems(
      items,
      RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
      items.at(-1)?.task.taskId
    )
    expect(visibleItemsWithCurrentTask).toHaveLength(items.length)
    expect(hasHiddenRuntimeSidebarTaskItems(items, visibleItemsWithCurrentTask)).toBe(false)
  })

  test('keeps recency order when queued runtime tasks change execution position', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        {
          taskId: 'recent-queued',
          workspacePath: '/workspace/repo',
          title: 'Queued second',
          runtime: 'codex',
          running: false,
          status: 'queued',
          queuePosition: 2,
          updatedAt: '2026-08-12T03:00:00.000Z',
          recencyAt: '2026-08-12T03:00:00.000Z',
        },
        {
          taskId: 'older-queued',
          workspacePath: '/workspace/repo',
          title: 'Queued first',
          runtime: 'codex',
          running: false,
          status: 'queued',
          queuePosition: 1,
          updatedAt: '2026-08-12T02:00:00.000Z',
          recencyAt: '2026-08-12T02:00:00.000Z',
        },
      ],
    }

    const initialOrder = getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)
    expect(initialOrder).toEqual(['recent-queued', 'older-queued'])

    workspace.tasks[0].queuePosition = 1
    workspace.tasks[1].queuePosition = 2
    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual(
      initialOrder
    )
  })

  test('does not use completion time as a sidebar sort field', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        {
          taskId: 'first',
          workspacePath: '/workspace/repo',
          title: 'First',
          runtime: 'codex',
          createdAt: '2026-08-12T02:00:00.000Z',
          completedAt: '2026-08-12T02:00:00.000Z',
        },
        {
          taskId: 'second',
          workspacePath: '/workspace/repo',
          title: 'Second',
          runtime: 'codex',
          createdAt: '2026-08-12T02:00:00.000Z',
          completedAt: '2026-08-12T05:00:00.000Z',
        },
      ],
    }

    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'first',
      'second',
    ])
  })

  test('advances Show more past an automatically expanded prefix', () => {
    expect(getNextRuntimeSidebarTaskVisibleLimit(5, 30, 18)).toBe(28)
    expect(getNextRuntimeSidebarTaskVisibleLimit(15, 20, 18)).toBe(20)
  })

  test('sorts across projects by recency regardless of queue and running state', () => {
    const workspaces: RuntimeDeviceWorkspace[] = [
      {
        deviceId: 'device-1',
        workspacePath: '/workspace/one',
        available: true,
        tasks: [
          {
            taskId: 'device-one-recent',
            workspacePath: '/workspace/one',
            title: 'Device one second',
            runtime: 'codex',
            running: false,
            status: 'queued',
            queuePosition: 2,
            updatedAt: '2026-08-12T05:00:00.000Z',
            recencyAt: '2026-08-12T05:00:00.000Z',
          },
          {
            taskId: 'device-one-older',
            workspacePath: '/workspace/one',
            title: 'Device one first',
            runtime: 'codex',
            running: false,
            status: 'queued',
            queuePosition: 1,
            updatedAt: '2026-08-12T02:00:00.000Z',
            recencyAt: '2026-08-12T02:00:00.000Z',
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
            recencyAt: '2026-08-12T04:00:00.000Z',
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
            recencyAt: '2026-08-12T03:00:00.000Z',
          },
        ],
      },
    ]

    expect(getRuntimeSidebarTaskItems(workspaces).map(item => item.task.taskId)).toEqual([
      'device-one-recent',
      'device-two-running',
      'device-two-first',
      'device-one-older',
    ])
  })

  test.each(['current', 'running', 'unread', 'waiting'] as const)(
    'expands the visible recency prefix without moving a deep %s task',
    specialState => {
      const workspace: RuntimeDeviceWorkspace = {
        deviceId: 'device-1',
        workspacePath: '/workspace/repo',
        available: true,
        tasks: Array.from({ length: RUNTIME_PROJECT_TASK_PREVIEW_LIMIT + 4 }, (_, index) => ({
          taskId: `task-${index + 1}`,
          workspacePath: '/workspace/repo',
          title: `Task ${index + 1}`,
          runtime: 'codex' as const,
          recencyAt: `2026-08-18T${String(23 - index).padStart(2, '0')}:00:00.000Z`,
        })),
      }
      const items = getRuntimeSidebarTaskItems([workspace])
      const specialTask = items[RUNTIME_PROJECT_TASK_PREVIEW_LIMIT + 1]!
      const visible = getVisibleRuntimeSidebarTaskItems(
        items,
        RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
        specialState === 'current' ? specialTask.task.taskId : undefined,
        item => specialState !== 'current' && item === specialTask
      )

      expect(visible.map(item => item.task.taskId)).toEqual(
        items.slice(0, RUNTIME_PROJECT_TASK_PREVIEW_LIMIT + 2).map(item => item.task.taskId)
      )
    }
  )

  test('moves a replied conversation to its recency position without a manual order', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/workspace/repo',
      available: true,
      tasks: [
        {
          taskId: 'replied',
          workspacePath: '/workspace/repo',
          title: 'Running',
          runtime: 'codex',
          running: true,
          createdAt: '2026-06-01T00:00:00.000Z',
          completedAt: '2026-06-02T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
          recencyAt: '2026-06-04T00:00:00.000Z',
        },
        {
          taskId: 'older',
          workspacePath: '/workspace/repo',
          title: 'Completed',
          runtime: 'codex',
          running: false,
          createdAt: '2026-06-01T00:00:00.000Z',
          completedAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:00:00.000Z',
          recencyAt: '2026-06-03T00:00:00.000Z',
        },
      ],
    }

    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual([
      'replied',
      'older',
    ])
    workspace.tasks[1].recencyAt = '2026-06-05T00:00:00.000Z'
    const repliedOrder = getRuntimeSidebarTaskItems([workspace])
    expect(repliedOrder.map(item => item.task.taskId)).toEqual(['older', 'replied'])
    expect(sortRuntimeTaskItems(repliedOrder).map(item => item.task.taskId)).toEqual([
      'older',
      'replied',
    ])
  })
})
