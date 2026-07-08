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
      currentRuntimeTask: null,
    })

    expect(snapshot.completedUnreadItems.map(item => item.key)).toEqual([key])
  })

  test('marks a task unread when status changes from active to done', () => {
    const completedTask = task({ running: false, status: 'done' })
    const key = getRuntimeTaskReminderItemKey(workspace([completedTask]), completedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      previousRunningTaskKeys: new Set([key]),
      currentRuntimeTask: null,
    })

    expect(snapshot.completedUnreadItems.map(item => item.key)).toEqual([key])
  })

  test('keeps active status tasks in the running key set even without running flag', () => {
    const activeTask = task({ running: false, status: 'active' })
    const key = getRuntimeTaskReminderItemKey(workspace([activeTask]), activeTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([activeTask]),
      previousRunningTaskKeys: new Set(),
      currentRuntimeTask: null,
    })

    expect(snapshot.runningTaskKeys.has(key)).toBe(true)
    expect(snapshot.completedUnreadItems).toEqual([])
  })

  test('does not mark the currently selected completed task unread', () => {
    const completedTask = task({ running: false })
    const taskWorkspace = workspace([completedTask])
    const key = getRuntimeTaskReminderItemKey(taskWorkspace, completedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      previousRunningTaskKeys: new Set([key]),
      currentRuntimeTask: {
        deviceId: taskWorkspace.deviceId,
        workspacePath: taskWorkspace.workspacePath,
        taskId: completedTask.taskId,
      },
    })

    expect(snapshot.completedUnreadItems).toEqual([])
  })

  test('does not complete unread items when the current task changes', () => {
    const currentTask = task({ running: true })
    const previousCompletedTask = task({
      taskId: 'task-2',
      title: 'Previous completed task',
      running: false,
    })
    const taskWorkspace = workspace([currentTask, previousCompletedTask])

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([currentTask, previousCompletedTask]),
      previousRunningTaskKeys: new Set(),
      currentRuntimeTask: {
        deviceId: taskWorkspace.deviceId,
        workspacePath: taskWorkspace.workspacePath,
        taskId: currentTask.taskId,
      },
    })

    expect(snapshot.completedUnreadItems).toEqual([])
  })
})
