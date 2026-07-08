import { describe, expect, test } from 'vitest'
import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import {
  buildRuntimeTaskReminderSnapshot,
  getRuntimeTaskReminderItemKey,
} from './runtimeTaskReminders'

function task(overrides: Partial<RuntimeTaskSummary>): RuntimeTaskSummary {
  return {
    taskId: 'task-1',
    workspacePath: '/repo/Wegent',
    title: 'Task',
    runtime: 'codex',
    ...overrides,
  }
}

function workspace(tasks: RuntimeTaskSummary[]): RuntimeDeviceWorkspace {
  return {
    deviceId: 'local-device',
    available: true,
    workspacePath: '/repo/Wegent',
    tasks,
  }
}

function runtimeWork(tasks: RuntimeTaskSummary[]): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { key: 'project-1', id: 1, name: 'Wegent' },
        deviceWorkspaces: [workspace(tasks)],
        totalTasks: tasks.length,
      },
    ],
    chats: [],
    totalTasks: tasks.length,
  }
}

describe('runtimeTaskReminders', () => {
  test('marks a previously running completed task unread', () => {
    const completedTask = task({ running: false })
    const key = getRuntimeTaskReminderItemKey(workspace([completedTask]), completedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      previousRunningTaskKeys: new Set([key]),
      storedUnreadTaskKeys: new Set(),
    })

    expect(snapshot.unreadTaskKeys.has(key)).toBe(true)
    expect(snapshot.completedUnreadItems.map(item => item.key)).toEqual([key])
  })

  test('marks a task unread when status changes from active to done', () => {
    const completedTask = task({ running: false, status: 'done' })
    const key = getRuntimeTaskReminderItemKey(workspace([completedTask]), completedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      previousRunningTaskKeys: new Set([key]),
      storedUnreadTaskKeys: new Set(),
    })

    expect(snapshot.unreadTaskKeys.has(key)).toBe(true)
    expect(snapshot.completedUnreadItems.map(item => item.key)).toEqual([key])
  })

  test('keeps active status tasks in the running key set even without running flag', () => {
    const activeTask = task({ running: false, status: 'active' })
    const key = getRuntimeTaskReminderItemKey(workspace([activeTask]), activeTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([activeTask]),
      previousRunningTaskKeys: new Set(),
      storedUnreadTaskKeys: new Set(),
    })

    expect(snapshot.runningTaskKeys.has(key)).toBe(true)
    expect(snapshot.completedUnreadItems).toEqual([])
  })

  test('marks the currently selected completed task unread', () => {
    const completedTask = task({ running: false })
    const taskWorkspace = workspace([completedTask])
    const key = getRuntimeTaskReminderItemKey(taskWorkspace, completedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      previousRunningTaskKeys: new Set([key]),
      storedUnreadTaskKeys: new Set(),
    })

    expect(snapshot.unreadTaskKeys.has(key)).toBe(true)
    expect(snapshot.completedUnreadItems.map(item => item.key)).toEqual([key])
  })

  test('does not auto-clear unread for a completed current task', () => {
    const completedTask = task({ running: false })
    const taskWorkspace = workspace([completedTask])
    const key = getRuntimeTaskReminderItemKey(taskWorkspace, completedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      previousRunningTaskKeys: new Set([key]),
      storedUnreadTaskKeys: new Set(),
    })

    expect(snapshot.unreadTaskKeys.has(key)).toBe(true)
    expect(snapshot.completedUnreadItems.map(item => item.key)).toEqual([key])
  })

  test('keeps stored unread for the current task until explicit read', () => {
    const completedTask = task({ running: false })
    const taskWorkspace = workspace([completedTask])
    const key = getRuntimeTaskReminderItemKey(taskWorkspace, completedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      previousRunningTaskKeys: new Set(),
      storedUnreadTaskKeys: new Set([key]),
    })

    expect(snapshot.unreadTaskKeys.has(key)).toBe(true)
  })

  test('keeps unread keys for tasks that are temporarily missing from runtime work', () => {
    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([]),
      previousRunningTaskKeys: new Set(),
      storedUnreadTaskKeys: new Set(['local-device\0archived-task']),
    })

    expect(snapshot.unreadTaskKeys).toEqual(new Set(['local-device\0archived-task']))
  })
})
