// @vitest-environment node

import type { RuntimeDeviceWorkspace } from '@/types/api'
import { describe, expect, test } from 'vitest'
import {
  getRuntimeSidebarTaskItems,
  getRuntimeChatSidebarTaskItems,
  getVisibleRuntimeSidebarTaskItems,
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
} from './runtimeTaskSidebarHelpers'

describe('runtimeTaskSidebarHelpers', () => {
  test('omits the primary identity without changing stored work or hiding delegated tasks', () => {
    const workspace: RuntimeDeviceWorkspace = {
      deviceId: 'device-1',
      workspacePath: '/chats',
      workspaceKind: 'chat',
      available: true,
      tasks: [
        {
          taskId: 'stand-in-chat-7-primary',
          workspacePath: '/chats',
          title: 'Primary identity',
          runtime: 'codex',
          pinned: true,
          runtimeHandle: {
            origin: { type: 'stand_in_identity', userId: 7, standInId: null },
          },
        },
        {
          taskId: 'delegated-work',
          workspacePath: '/chats',
          title: 'Delegated work',
          runtime: 'codex',
          runtimeHandle: { origin: { type: 'stand_in_task', userId: 7 } },
        },
        {
          taskId: 'ordinary-conversation',
          workspacePath: '/chats',
          title: '我的分身',
          runtime: 'codex',
        },
      ],
    }

    const expected = ['delegated-work', 'ordinary-conversation']
    expect(getRuntimeSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual(expected)
    expect(getRuntimeChatSidebarTaskItems([workspace]).map(item => item.task.taskId)).toEqual(
      expected
    )
    expect(workspace.tasks.map(task => task.taskId)).toEqual([
      'stand-in-chat-7-primary',
      ...expected,
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
          recencyAt: `2026-08-18T0${index + 1}:00:00.000Z`,
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
          recencyAt: '2026-08-19T01:00:00.000Z',
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
          recencyAt: '2026-08-12T03:00:00.000Z',
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
          recencyAt: '2026-08-12T02:00:00.000Z',
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
            recencyAt: '2026-08-12T05:00:00.000Z',
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
          recencyAt: '2026-06-04T00:00:00.000Z',
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
          recencyAt: '2026-06-03T00:00:00.000Z',
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
          recencyAt: '2026-06-04T00:00:00.000Z',
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
          recencyAt: '2026-06-03T00:00:00.000Z',
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
})
