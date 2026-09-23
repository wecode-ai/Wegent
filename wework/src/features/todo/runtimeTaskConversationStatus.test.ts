import { describe, expect, it } from 'vitest'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import { runtimeTaskConversationStatusesByAddress } from './runtimeTaskConversationStatus'

function task(overrides: Partial<RuntimeTaskSummary>): RuntimeTaskSummary {
  return {
    taskId: 'task',
    workspacePath: '/repo',
    title: 'Task',
    runtime: 'codex',
    ...overrides,
  }
}

function runtimeWork(tasks: RuntimeTaskSummary[]): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 1, key: 'project', name: 'Project' },
        deviceWorkspaces: [
          {
            deviceId: 'device',
            workspacePath: '/repo',
            available: true,
            tasks,
          },
        ],
      },
    ],
    chats: [],
    totalTasks: tasks.length,
  }
}

describe('runtimeTaskConversationStatusesByAddress', () => {
  it('projects running, completed, and failed runtime summaries', () => {
    const statuses = runtimeTaskConversationStatusesByAddress(
      runtimeWork([
        task({ taskId: 'running', running: true }),
        task({ taskId: 'completed', status: 'done', running: false }),
        task({ taskId: 'failed', status: 'failed', running: false }),
      ])
    )

    expect(statuses.get('device:running')).toBe('running')
    expect(statuses.get('device:completed')).toBe('succeeded')
    expect(statuses.get('device:failed')).toBe('failed')
  })

  it('lets the live lifecycle override a stale runtime summary', () => {
    const failedTask = task({ status: 'failed', running: false })
    const lifecycle = {
      version: 1,
      tasks: new Map([
        [
          'device\0task',
          {
            key: 'device\0task',
            address: { deviceId: 'device', taskId: 'task' },
            task: failedTask,
            execution: { phase: 'idle', known: true, running: false },
            turn: { phase: 'idle', active: false, id: null, outcome: 'failed' },
            goalStatus: null,
            continuable: true,
            unread: false,
            derived: {
              executionKnown: true,
              isRunning: false,
              isQueued: false,
              isTurnActive: false,
              isThinking: false,
              isBusy: false,
              canSend: true,
              canQueue: false,
              shouldShowSidebarRunning: false,
              shouldShowUnread: false,
            },
          },
        ],
      ]),
      runningTaskKeys: new Set(),
      queuedTaskKeys: new Set(),
      unreadTaskKeys: new Set(),
    } as RuntimeTaskLifecycleStoreSnapshot

    const statuses = runtimeTaskConversationStatusesByAddress(
      runtimeWork([task({ status: 'done', running: false })]),
      lifecycle
    )

    expect(statuses.get('device:task')).toBe('failed')
  })
})
