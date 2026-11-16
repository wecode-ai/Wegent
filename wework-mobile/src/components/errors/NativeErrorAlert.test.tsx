import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeErrorAlert } from './NativeErrorAlert'
import { showErrorAlert } from '@/services/errorAlerts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cancel = vi.hoisted(() => vi.fn())
vi.mock('@/services/errorAlerts', () => ({ showErrorAlert: vi.fn(() => cancel) }))

describe('state-driven native errors', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    vi.clearAllMocks()
  })

  it('keeps a new failure intact when the older alert is dismissed', async () => {
    const dismiss = vi.fn()
    const retry = vi.fn()
    await act(() => {
      renderer = create(<NativeErrorAlert error={null} onDismiss={dismiss} onRetry={retry} />)
    })
    expect(showErrorAlert).not.toHaveBeenCalled()
    await act(() =>
      renderer.update(<NativeErrorAlert error="old failure" onDismiss={dismiss} onRetry={retry} />)
    )
    const previous = vi.mocked(showErrorAlert).mock.calls[0]![1]!
    await act(() =>
      renderer.update(<NativeErrorAlert error="new failure" onDismiss={dismiss} onRetry={retry} />)
    )
    expect(cancel).toHaveBeenCalledOnce()
    previous.onDismiss?.()
    expect(dismiss).not.toHaveBeenCalled()
    vi.mocked(showErrorAlert).mock.calls[1]![1]!.onDismiss?.()
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('does not reopen unchanged failures when callback identities change', async () => {
    await act(() => {
      renderer = create(<NativeErrorAlert error="failure" onDismiss={vi.fn()} />)
    })
    const latest = vi.fn()
    await act(() => renderer.update(<NativeErrorAlert error="failure" onDismiss={latest} />))
    expect(showErrorAlert).toHaveBeenCalledOnce()
    vi.mocked(showErrorAlert).mock.calls[0]![1]!.onDismiss?.()
    expect(latest).toHaveBeenCalledOnce()
  })
})
