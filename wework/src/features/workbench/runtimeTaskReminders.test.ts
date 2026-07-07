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
      currentRuntimeTask: null,
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
      currentRuntimeTask: null,
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
      currentRuntimeTask: null,
      previousRunningTaskKeys: new Set(),
      storedUnreadTaskKeys: new Set(),
    })

    expect(snapshot.runningTaskKeys.has(key)).toBe(true)
    expect(snapshot.completedUnreadItems).toEqual([])
  })

  test('marks the currently selected completed task unread when the window is not focused', () => {
    const completedTask = task({ running: false })
    const taskWorkspace = workspace([completedTask])
    const key = getRuntimeTaskReminderItemKey(taskWorkspace, completedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      currentRuntimeTask: { deviceId: 'local-device', taskId: 'task-1' },
      previousRunningTaskKeys: new Set([key]),
      storedUnreadTaskKeys: new Set(),
      currentRuntimeTaskVisible: false,
    })

    expect(snapshot.unreadTaskKeys.has(key)).toBe(true)
    expect(snapshot.completedUnreadItems.map(item => item.key)).toEqual([key])
  })

  test('treats a focused current task as read when it completes', () => {
    const completedTask = task({ running: false })
    const taskWorkspace = workspace([completedTask])
    const key = getRuntimeTaskReminderItemKey(taskWorkspace, completedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      currentRuntimeTask: { deviceId: 'local-device', taskId: 'task-1' },
      previousRunningTaskKeys: new Set([key]),
      storedUnreadTaskKeys: new Set(),
      currentRuntimeTaskVisible: true,
    })

    expect(snapshot.unreadTaskKeys.has(key)).toBe(false)
    expect(snapshot.completedUnreadItems).toEqual([])
  })

  test('clears stored unread for the focused current task', () => {
    const completedTask = task({ running: false })
    const taskWorkspace = workspace([completedTask])
    const key = getRuntimeTaskReminderItemKey(taskWorkspace, completedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      currentRuntimeTask: { deviceId: 'local-device', taskId: 'task-1' },
      previousRunningTaskKeys: new Set(),
      storedUnreadTaskKeys: new Set([key]),
      currentRuntimeTaskVisible: true,
    })

    expect(snapshot.unreadTaskKeys.has(key)).toBe(false)
  })

  test('prunes unread keys for tasks no longer present', () => {
    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([]),
      currentRuntimeTask: null,
      previousRunningTaskKeys: new Set(),
      storedUnreadTaskKeys: new Set(['local-device\0archived-task']),
    })

    expect(snapshot.unreadTaskKeys.size).toBe(0)
  })
})
