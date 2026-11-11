import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { interactionQuestion } from './runtimeInteractions.fixtures'

it('holds the shared history lock until the renderer write queue is durable', async () => {
  view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const item = context!.pending[0]
  let commit!: () => void
  harness.flushStorage.mockReturnValueOnce(
    new Promise<void>(resolve => {
      commit = resolve
    })
  )
  let dismissal!: Promise<void>
  act(() => {
    dismissal = context!.dismiss(item)
  })
  await waitFor(() => expect(harness.flushStorage).toHaveBeenCalledOnce())
  const nextWindow = vi.fn()
  const nextArchive = navigator.locks.request('wework.interactions:test:1:history', nextWindow)
  await act(async () => {
    await Promise.resolve()
  })
  expect(nextWindow).not.toHaveBeenCalled()
  expect(localStorage.getItem(`wework.interactions:test:1:accepted:${item.id}`)).toBeNull()
  expect(context!.pending).toHaveLength(1)
  await act(async () => {
    commit()
    await dismissal
    await nextArchive
  })
  expect(nextWindow).toHaveBeenCalledOnce()
  expect(context!.pending).toHaveLength(0)
  expect(context!.history[0].id).toBe(item.id)
})

it('does not rewrite history when a transcript repeatedly reports the same answered request', async () => {
  const rendered = view()
  await waitFor(() => expect(context!.pending).toHaveLength(1))
  const item = context!.pending[0]
  await act(async () => {
    await context!.dismiss(item)
  })
  const history = localStorage.getItem('wework.interactions:test:1:history')
  rendered.unmount()
  const write = vi.spyOn(Storage.prototype, 'setItem')
  view({ ...interactionQuestion, interactionStatus: 'answered' })
  await waitFor(() => expect(context!.loading).toBe(false))
  expect(harness.flushStorage).toHaveBeenCalledTimes(2)
  expect(localStorage.getItem('wework.interactions:test:1:history')).toBe(history)
  expect(localStorage.getItem(`wework.interactions:test:1:accepted:${item.id}`)).toBe(
    JSON.stringify('dismissed')
  )
  expect(write.mock.calls.filter(([key]) => key === 'wework.interactions:test:1:history')).toEqual(
    []
  )
})
