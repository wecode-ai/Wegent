// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { taskStateManager } from '@/features/tasks/state'

describe('TaskStateManager runtime health checks', () => {
  afterEach(() => {
    taskStateManager.cleanupAll()
  })

  it('does not auto-recover from task status updates', () => {
    const joinTask = jest.fn().mockResolvedValue({ subtasks: [] })
    const verifyRuntime = jest.fn().mockResolvedValue({
      task_id: 42,
      task_status: 'RUNNING',
      status_updated_at: '2026-06-01T10:00:00',
      active_stream: { subtask_id: 77, cursor: 0, last_activity_at: null },
    })

    taskStateManager.initialize({
      joinTask,
      verifyRuntime,
      isConnected: () => true,
    })

    const state = taskStateManager.handleTaskStatus(42, 'RUNNING', '2026-05-31T10:00:00.000Z')

    expect(state.derived.shouldJoinRoom).toBe(true)
    expect(joinTask).not.toHaveBeenCalled()
    expect(verifyRuntime).not.toHaveBeenCalled()
  })

  it('checks health by delegating to each existing machine', async () => {
    const verifyRuntime = jest.fn().mockResolvedValue({
      task_id: 42,
      task_status: 'COMPLETED',
      status_updated_at: '2026-06-01T10:00:00',
      active_stream: null,
    })

    taskStateManager.initialize({
      joinTask: jest.fn().mockResolvedValue({ subtasks: [] }),
      verifyRuntime,
      isConnected: () => true,
    })

    taskStateManager.getOrCreate(42)
    await taskStateManager.checkHealthAll('page-visible')

    expect(verifyRuntime).toHaveBeenCalledWith(42)
  })

  it('removes temporary task machines after migrating to the server task id', async () => {
    const verifyRuntime = jest.fn().mockResolvedValue({
      task_id: 42,
      task_status: 'COMPLETED',
      status_updated_at: '2026-06-01T10:00:00',
      active_stream: null,
    })

    taskStateManager.initialize({
      joinTask: jest.fn().mockResolvedValue({ subtasks: [] }),
      verifyRuntime,
      isConnected: () => true,
    })

    const tempMachine = taskStateManager.getOrCreate(-1)
    taskStateManager.migrateState(-1, 42)

    expect(taskStateManager.get(-1)).toBeUndefined()
    expect(taskStateManager.get(42)).toBe(tempMachine)
    expect(taskStateManager.get(42)?.getState().taskId).toBe(42)

    await taskStateManager.checkHealthAll('page-visible')

    expect(verifyRuntime).toHaveBeenCalledTimes(1)
    expect(verifyRuntime).toHaveBeenCalledWith(42)
  })
})
