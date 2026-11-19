import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRuntimeFailures } from './useRuntimeFailures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
function deferred() {
  let resolve!: () => void
  let reject!: (cause: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
describe('source-owned avatar retries', () => {
  let state: ReturnType<typeof useRuntimeFailures>
  let renderer: ReactTestRenderer
  function Harness() {
    state = useRuntimeFailures()
    return null
  }
  beforeEach(async () => {
    await act(() => {
      renderer = create(<Harness />)
    })
  })
  afterEach(async () => {
    await act(() => renderer.unmount())
  })
  const failure = (id: string, retry: () => Promise<void>, phoneOwned = true) => ({
    id,
    label: id,
    error: 'unavailable',
    phoneOwned,
    retry,
  })
  it('deduplicates immediate repeated taps while independent sources run concurrently', async () => {
    const phone = deferred()
    const cloud = deferred()
    const phoneRetry = vi.fn(() => phone.promise)
    const cloudRetry = vi.fn(() => cloud.promise)
    await act(() => {
      state.reportFailure(failure('phone', phoneRetry))
      state.reportFailure(failure('cloud', cloudRetry, false))
    })
    let pending!: Promise<void>[]
    await act(() => {
      const [a, b] = state.failures
      pending = [state.retryFailure(a!), state.retryFailure(a!), state.retryFailure(b!)]
    })
    expect(phoneRetry).toHaveBeenCalledOnce()
    expect(cloudRetry).toHaveBeenCalledOnce()
    expect(state.failures.every(item => item.retrying)).toBe(true)
    await act(async () => {
      phone.resolve()
      await pending[0]
    })
    expect(state.failures.find(item => item.id === 'cloud')?.retrying).toBe(true)
    // A resolved operation must not erase a failure unless its owner confirmed success.
    expect(state.failures).toHaveLength(2)
    await act(async () => {
      cloud.resolve()
      await Promise.all(pending)
    })
    expect(state.failures.every(item => !item.retrying)).toBe(true)
  })
  it('does not let an old account retry change a new account failure with the same id', async () => {
    const old = deferred()
    await act(() => state.reportFailure(failure('cloud', () => old.promise, false)))
    let pending!: Promise<void>
    await act(() => {
      pending = state.retryFailure(state.failures[0]!)
    })
    await act(() => {
      state.clearRemoteFailures()
      state.reportFailure({
        ...failure(
          'cloud',
          vi.fn(async () => {}),
          false
        ),
        error: 'new account',
      })
    })
    await act(async () => {
      old.reject(new Error('old account'))
      await pending
    })
    expect(state.failures[0]?.error).toBe('new account')
    expect(state.failures[0]?.retrying).toBe(false)
  })
  it('ignores obsolete menu entries and preserves phone retries when the cloud account changes', async () => {
    const pending = deferred()
    const retry = vi.fn(() => pending.promise)
    await act(() => state.reportFailure(failure('phone', retry)))
    const obsolete = state.failures[0]!
    await act(() => state.reportFailure(failure('phone', retry)))
    await act(() => state.retryFailure(obsolete))
    expect(retry).not.toHaveBeenCalled()
    let attempt!: Promise<void>
    await act(() => {
      attempt = state.retryFailure(state.failures[0]!)
      state.clearRemoteFailures()
    })
    expect(state.failures[0]?.retrying).toBe(true)
    await act(async () => {
      state.clearFailure('phone')
      pending.resolve()
      await attempt
    })
    expect(state.failures).toEqual([])
  })
})
