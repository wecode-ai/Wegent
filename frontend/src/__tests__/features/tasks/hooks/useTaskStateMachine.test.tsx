// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { useTaskStateMachine } from '@/features/tasks/hooks/useTaskStateMachine'
import { taskStateManager } from '@/features/tasks/state'

function Probe({
  taskId,
  onRender,
}: {
  taskId: number
  onRender: (isInitialized: boolean) => void
}) {
  const { isInitialized } = useTaskStateMachine(taskId)

  onRender(isInitialized)

  return null
}

function RuntimeProbe({
  taskId,
  onRender,
}: {
  taskId: number
  onRender: (phase: string | null, blocksQueuedDispatch: boolean | null) => void
}) {
  const { runtime, derived } = useTaskStateMachine(taskId)

  onRender(runtime?.phase ?? null, derived?.blocksQueuedDispatch ?? null)

  return null
}

describe('useTaskStateMachine', () => {
  afterEach(() => {
    act(() => {
      taskStateManager.cleanupAll()
    })
  })

  it('reacts when TaskStateManager is initialized after the first render', async () => {
    const onRender = jest.fn()
    const taskId = 4201

    render(<Probe taskId={taskId} onRender={onRender} />)

    act(() => {
      taskStateManager.initialize({
        joinTask: jest.fn().mockResolvedValue({ subtasks: [] }),
        isConnected: () => true,
      })
    })

    await waitFor(() => {
      expect(onRender).toHaveBeenLastCalledWith(true)
    })
  })

  it('exposes runtime and derived state from the task state machine', async () => {
    const onRender = jest.fn()
    const taskId = 4202

    act(() => {
      taskStateManager.initialize({
        joinTask: jest.fn().mockResolvedValue({ subtasks: [] }),
        isConnected: () => true,
      })
    })

    render(<RuntimeProbe taskId={taskId} onRender={onRender} />)

    act(() => {
      taskStateManager.handleTaskStatus(taskId, 'RUNNING', '2026-05-31T10:00:00.000Z')
    })

    await waitFor(() => {
      expect(onRender).toHaveBeenLastCalledWith('running', true)
    })
  })
})
