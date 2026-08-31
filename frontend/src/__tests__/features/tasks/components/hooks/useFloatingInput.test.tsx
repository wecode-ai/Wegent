// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'
import { useFloatingInput } from '@/features/tasks/components/hooks/useFloatingInput'

describe('useFloatingInput', () => {
  const originalResizeObserver = global.ResizeObserver

  beforeEach(() => {
    global.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })

  afterEach(() => {
    global.ResizeObserver = originalResizeObserver
  })

  it('measures the mounted floating input element', async () => {
    const input = document.createElement('div')
    Object.defineProperty(input, 'offsetHeight', {
      configurable: true,
      value: 178,
    })
    const { result } = renderHook(() => useFloatingInput({ hasMessages: true }))

    act(() => {
      result.current.floatingInputRef(input)
    })

    await waitFor(() => expect(result.current.inputHeight).toBe(178))
  })

  it('clears the measured height when the floating input unmounts', async () => {
    const input = document.createElement('div')
    Object.defineProperty(input, 'offsetHeight', {
      configurable: true,
      value: 178,
    })
    const { result } = renderHook(() => useFloatingInput({ hasMessages: true }))

    act(() => {
      result.current.floatingInputRef(input)
    })
    await waitFor(() => expect(result.current.inputHeight).toBe(178))

    act(() => {
      result.current.floatingInputRef(null)
    })

    await waitFor(() => expect(result.current.inputHeight).toBe(0))
  })

  it('measures a fixed input while its empty state is visible', async () => {
    const input = document.createElement('div')
    Object.defineProperty(input, 'offsetHeight', {
      configurable: true,
      value: 216,
    })
    const { result } = renderHook(() =>
      useFloatingInput({ hasMessages: false, inputAlwaysAtBottom: true })
    )

    act(() => {
      result.current.floatingInputRef(input)
    })

    await waitFor(() => expect(result.current.inputHeight).toBe(216))
  })
})
