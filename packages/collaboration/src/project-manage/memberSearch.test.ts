// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemberSearchResource, filterMemberSearchResults } from './memberSearch'

const stops: Array<() => void> = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  stops.splice(0).forEach(stop => stop())
  vi.useRealTimers()
})

it('cancels a debounced read when its query is detached before the delay', async () => {
  const search = vi.fn(async () => ({ users: [{ id: 1 }] }))
  const resource = createMemberSearchResource('query:Ada', 'Ada', search)
  const stop = resource.subscribe(() => {})
  stops.push(stop)
  await vi.advanceTimersByTimeAsync(249)
  expect(search).not.toHaveBeenCalled()
  stop()
  await vi.advanceTimersByTimeAsync(1)
  expect(search).not.toHaveBeenCalled()
  expect(resource.getSnapshot().data).toBeUndefined()
})

it('exposes an active failure with no stale results', async () => {
  const cause = new Error('search unavailable')
  const resource = createMemberSearchResource('query:Ada', 'Ada', vi.fn().mockRejectedValue(cause))
  stops.push(resource.subscribe(() => {}))
  await vi.advanceTimersByTimeAsync(250)
  expect(resource.getSnapshot().status).toBe('error')
  expect(resource.getSnapshot().error).toBe(cause)
  expect(resource.getSnapshot().data).toBeUndefined()
})

it('ignores a failure after a request loses its last subscriber', async () => {
  let fail!: (cause: Error) => void
  const search = vi.fn(
    () =>
      new Promise<{ users: { id: number }[] }>((_resolve, reject) => {
        fail = reject
      })
  )
  const resource = createMemberSearchResource('query:Ada', 'Ada', search)
  const changed = vi.fn()
  const stop = resource.subscribe(changed)
  stops.push(stop)
  await vi.advanceTimersByTimeAsync(250)
  stop()
  const calls = changed.mock.calls.length
  fail(new Error('late failure'))
  await vi.advanceTimersByTimeAsync(0)
  expect(resource.getSnapshot().error).toBeUndefined()
  expect(changed).toHaveBeenCalledTimes(calls)
})

it('filters the current roster from successful results without repeating the search', async () => {
  const search = vi.fn(async () => ({
    users: [
      { id: 1, name: 'Existing' },
      { id: 2, name: 'Ada' },
    ],
  }))
  const resource = createMemberSearchResource('query:Ada', 'Ada', search)
  stops.push(resource.subscribe(() => {}))
  await vi.advanceTimersByTimeAsync(250)
  const results = resource.getSnapshot().data!
  expect(filterMemberSearchResults(results, [{ user_id: 1 }])).toEqual([{ id: 2, name: 'Ada' }])
  expect(filterMemberSearchResults(results, [{ user_id: 1 }, { user_id: 2 }])).toEqual([])
  expect(search).toHaveBeenCalledExactlyOnceWith('Ada')
})
