// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { useTaskStateMachine } from '@/features/tasks/hooks/useTaskStateMachine'
import { taskStateManager } from '@/features/tasks/state'

function Probe({ onRender }: { onRender: (isInitialized: boolean) => void }) {
  const { isInitialized } = useTaskStateMachine(42)

  onRender(isInitialized)

  return null
}

describe('useTaskStateMachine', () => {
  it('reacts when TaskStateManager is initialized after the first render', async () => {
    const onRender = jest.fn()

    render(<Probe onRender={onRender} />)

    expect(onRender).toHaveBeenLastCalledWith(false)

    act(() => {
      taskStateManager.initialize({
        joinTask: jest.fn(),
        isConnected: () => true,
      })
    })

    await waitFor(() => {
      expect(onRender).toHaveBeenLastCalledWith(true)
    })
  })
})
