import { describe, expect, test } from 'vitest'
import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import {
  buildRuntimeTaskReminderSnapshot,
  getRuntimeTaskReminderItemKey,
  reconcileRuntimeTaskOngoingKeys,
  reconcileRuntimeTaskUnreadKeys,
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
  test('marks a task unread when a background execution settles', () => {
    const settledTask = task({ running: false })
    const key = getRuntimeTaskReminderItemKey(workspace([settledTask]), settledTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([settledTask]),
      previousOngoingTaskKeys: new Set([key]),
      currentRuntimeTask: null,
    })

    expect(snapshot.settledUnreadItems.map(item => item.key)).toEqual([key])
  })

  test('uses the running transition without interpreting task status', () => {
    const settledTask = task({ running: false, status: 'active', turnStatus: 'completed' })
    const key = getRuntimeTaskReminderItemKey(workspace([settledTask]), settledTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([settledTask]),
      previousOngoingTaskKeys: new Set([key]),
      currentRuntimeTask: null,
    })

    expect(snapshot.settledUnreadItems.map(item => item.key)).toEqual([key])
  })

  test('does not treat a continuable idle task as running', () => {
    const activeTask = task({ running: false, status: 'active' })
    const key = getRuntimeTaskReminderItemKey(workspace([activeTask]), activeTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([activeTask]),
      previousOngoingTaskKeys: new Set(),
      currentRuntimeTask: null,
    })

    expect(snapshot.runningTaskKeys.has(key)).toBe(false)
    expect(snapshot.settledUnreadItems).toEqual([])
  })

  test('keeps an executor-owned goal ongoing between automatic turns', () => {
    const goalTask = task({
      running: true,
      status: 'active',
      goalStatus: 'active',
      turnStatus: 'completed',
    })
    const key = getRuntimeTaskReminderItemKey(workspace([goalTask]), goalTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([goalTask]),
      previousOngoingTaskKeys: new Set([key]),
      currentRuntimeTask: null,
    })

    expect(snapshot.runningTaskKeys.has(key)).toBe(true)
    expect(snapshot.settledUnreadItems).toEqual([])
  })

  test('does not treat a persisted active goal as running after executor restart', () => {
    const goalTask = task({
      running: false,
      status: 'active',
      goalStatus: 'active',
      turnStatus: 'completed',
    })
    const key = getRuntimeTaskReminderItemKey(workspace([goalTask]), goalTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([goalTask]),
      previousOngoingTaskKeys: new Set([key]),
      currentRuntimeTask: null,
    })

    expect(snapshot.runningTaskKeys.has(key)).toBe(false)
    expect(snapshot.settledUnreadItems).toEqual([])
  })

  test.each(['paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'] as const)(
    'settles unread when an active goal becomes %s',
    goalStatus => {
      const goalTask = task({ running: false, goalStatus })
      const key = getRuntimeTaskReminderItemKey(workspace([goalTask]), goalTask)

      const snapshot = buildRuntimeTaskReminderSnapshot({
        runtimeWork: runtimeWork([goalTask]),
        previousOngoingTaskKeys: new Set([key]),
        currentRuntimeTask: null,
      })

      expect(snapshot.runningTaskKeys.has(key)).toBe(false)
      expect(snapshot.settledUnreadItems.map(item => item.key)).toEqual([key])
    }
  )

  test('does not mark the currently viewed task unread when it is stopped', () => {
    const stoppedTask = task({
      running: false,
      status: 'cancelled',
      turnStatus: 'interrupted',
    })
    const taskWorkspace = workspace([stoppedTask])
    const key = getRuntimeTaskReminderItemKey(taskWorkspace, stoppedTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([stoppedTask]),
      previousOngoingTaskKeys: new Set([key]),
      currentRuntimeTask: {
        deviceId: taskWorkspace.deviceId,
        workspacePath: taskWorkspace.workspacePath,
        taskId: stoppedTask.taskId,
      },
    })

    expect(snapshot.settledUnreadItems).toEqual([])
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
      previousOngoingTaskKeys: new Set(),
      currentRuntimeTask: {
        deviceId: taskWorkspace.deviceId,
        workspacePath: taskWorkspace.workspacePath,
        taskId: currentTask.taskId,
      },
    })

    expect(snapshot.settledUnreadItems).toEqual([])
  })

  test('keeps unread only for visible idle tasks that are not being viewed', () => {
    const completedTask = task({ running: false, status: 'done' })
    const runningTask = task({ taskId: 'task-2', running: true })
    const taskWorkspace = workspace([completedTask])
    const visibleKey = getRuntimeTaskReminderItemKey(taskWorkspace, completedTask)
    const runningKey = getRuntimeTaskReminderItemKey(workspace([runningTask]), runningTask)

    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask, runningTask]),
      previousOngoingTaskKeys: new Set(),
      currentRuntimeTask: null,
    })
    const nextUnreadTaskKeys = reconcileRuntimeTaskUnreadKeys({
      previousUnreadTaskKeys: new Set(['stale-task-key', visibleKey, runningKey]),
      visibleTaskKeys: snapshot.taskKeys,
      unreadEligibleTaskKeys: snapshot.unreadEligibleTaskKeys,
      runningTaskKeys: snapshot.runningTaskKeys,
      currentTaskKey: snapshot.currentTaskKey,
      settledUnreadItems: snapshot.settledUnreadItems,
    })

    expect([...nextUnreadTaskKeys]).toEqual([visibleKey])
  })

  test('clears unread as soon as a task is viewed', () => {
    const completedTask = task({ running: false, status: 'done' })
    const taskWorkspace = workspace([completedTask])
    const key = getRuntimeTaskReminderItemKey(taskWorkspace, completedTask)
    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([completedTask]),
      previousOngoingTaskKeys: new Set(),
      currentRuntimeTask: {
        deviceId: taskWorkspace.deviceId,
        workspacePath: taskWorkspace.workspacePath,
        taskId: completedTask.taskId,
      },
    })

    const nextUnreadTaskKeys = reconcileRuntimeTaskUnreadKeys({
      previousUnreadTaskKeys: new Set([key]),
      visibleTaskKeys: snapshot.taskKeys,
      unreadEligibleTaskKeys: snapshot.unreadEligibleTaskKeys,
      runningTaskKeys: snapshot.runningTaskKeys,
      currentTaskKey: snapshot.currentTaskKey,
      settledUnreadItems: snapshot.settledUnreadItems,
    })

    expect(nextUnreadTaskKeys).toEqual(new Set())
  })

  test('clears a stale unread marker while a persisted goal is still active', () => {
    const goalTask = task({
      running: false,
      status: 'active',
      goalStatus: 'active',
      turnStatus: 'completed',
    })
    const key = getRuntimeTaskReminderItemKey(workspace([goalTask]), goalTask)
    const snapshot = buildRuntimeTaskReminderSnapshot({
      runtimeWork: runtimeWork([goalTask]),
      previousOngoingTaskKeys: new Set([key]),
      currentRuntimeTask: null,
    })

    const nextUnreadTaskKeys = reconcileRuntimeTaskUnreadKeys({
      previousUnreadTaskKeys: new Set([key]),
      visibleTaskKeys: snapshot.taskKeys,
      unreadEligibleTaskKeys: snapshot.unreadEligibleTaskKeys,
      runningTaskKeys: snapshot.runningTaskKeys,
      currentTaskKey: snapshot.currentTaskKey,
      settledUnreadItems: snapshot.settledUnreadItems,
    })

    expect(nextUnreadTaskKeys).toEqual(new Set())
  })

  test('keeps an observed completion edge until the active Goal snapshot settles', () => {
    const key = 'local-device\0task-1'

    expect(
      reconcileRuntimeTaskOngoingKeys({
        previousOngoingTaskKeys: new Set([key]),
        runningTaskKeys: new Set(),
        activeGoalTaskKeys: new Set([key]),
      })
    ).toEqual(new Set([key]))
  })

  test('does not reconstruct running history after a renderer restart', () => {
    const key = 'local-device\0task-1'

    expect(
      reconcileRuntimeTaskOngoingKeys({
        previousOngoingTaskKeys: new Set(),
        runningTaskKeys: new Set(),
        activeGoalTaskKeys: new Set([key]),
      })
    ).toEqual(new Set())
  })
})
