import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.restoreAllMocks())

it('does not persist dismissal before its history lock is acquired', async () => {
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const item = context!.pending[0]
  const historyKey = 'wework.interactions:test:1:history'
  const acceptanceKey = `wework.interactions:test:1:accepted:${item.id}`
  let release!: () => void
  harness.locks.set(historyKey, new Promise<void>(resolve => (release = resolve)))
  const request = vi.spyOn(navigator.locks, 'request')
  let completion!: Promise<void>
  await act(async () => {
    completion = context!.dismiss(item)
  })
  expect(request).toHaveBeenCalledWith(historyKey, expect.any(Function))
  expect(localStorage.getItem(acceptanceKey)).toBeNull()
  expect(context!.history).toHaveLength(0)
  expect(context!.pending).toHaveLength(1)
  expect(context!.busy.has(item.id)).toBe(true)

  const setItem = Storage.prototype.setItem
  let historyAtAcceptance: unknown
  const persist = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === acceptanceKey) {
      historyAtAcceptance = JSON.parse(localStorage.getItem(historyKey) || 'null')
    }
    setItem.call(this, key, value)
  })
  await act(async () => {
    release()
    await completion
  })
  expect(persist).toHaveBeenCalledWith(acceptanceKey, 'true')
  expect(historyAtAcceptance).toEqual([expect.objectContaining({ id: item.id })])
  expect(localStorage.getItem(acceptanceKey)).toBe('true')
  expect(context!.history[0].id).toBe(item.id)
  expect(context!.pending).toHaveLength(0)
  expect(context!.busy.size).toBe(0)
  expect(harness.send).not.toHaveBeenCalled()
})
