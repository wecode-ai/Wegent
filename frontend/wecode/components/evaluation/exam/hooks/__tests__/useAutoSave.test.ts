// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { renderHook, act, waitFor } from '@testing-library/react'
import { useAutoSave } from '../useAutoSave'

describe('useAutoSave', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should debounce save calls', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() => useAutoSave({ onSave, delay: 2000 }))

    // Trigger save multiple times
    act(() => {
      result.current.triggerSave({ test: 'data1' })
      result.current.triggerSave({ test: 'data2' })
      result.current.triggerSave({ test: 'data3' })
    })

    // Should not have called save yet
    expect(onSave).not.toHaveBeenCalled()

    // Fast-forward past delay
    act(() => {
      jest.advanceTimersByTime(2000)
    })

    // Should have called save exactly once
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1)
    })
  })

  it('should not save when disabled', () => {
    const onSave = jest.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() => useAutoSave({ onSave, delay: 2000, enabled: false }))

    act(() => {
      result.current.triggerSave({ test: 'data' })
    })

    act(() => {
      jest.advanceTimersByTime(2000)
    })

    expect(onSave).not.toHaveBeenCalled()
  })

  it('should flush pending save immediately', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() => useAutoSave({ onSave, delay: 2000 }))

    act(() => {
      result.current.triggerSave({ test: 'data' })
    })

    // Flush before timer expires
    await act(async () => {
      await result.current.flushSave()
    })

    expect(onSave).toHaveBeenCalledTimes(1)

    // Timer should not trigger another save
    act(() => {
      jest.advanceTimersByTime(2000)
    })

    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
