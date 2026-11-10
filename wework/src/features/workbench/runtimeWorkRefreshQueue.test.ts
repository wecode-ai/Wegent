import { describe, expect, test, vi } from 'vitest'
import { createRuntimeWorkRefreshQueue } from './workbenchDataRefreshHelpers'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('runtime work refresh queue', () => {
  test('keeps one read in flight and one trailing invalidation without losing later changes', async () => {
    const first = deferred()
    const second = deferred()
    const read = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(undefined)
    const queue = createRuntimeWorkRefreshQueue(read)
    const pending = queue.refresh()
    for (let index = 0; index < 20; index++) expect(queue.refresh()).toBe(pending)
    await Promise.resolve()
    expect(read).toHaveBeenCalledOnce()
    first.resolve()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    queue.refresh()
    second.resolve()
    await pending
    expect(read).toHaveBeenCalledTimes(3)
    await queue.refresh()
    expect(read).toHaveBeenCalledTimes(4)
  })

  test('propagates failures and allows the next event to recover', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const queue = createRuntimeWorkRefreshQueue(read)
    await expect(queue.refresh()).rejects.toThrow('offline')
    await queue.refresh()
    expect(read).toHaveBeenCalledTimes(2)
  })

  test('disposal drops trailing invalidations without cancelling an accepted read', async () => {
    const first = deferred()
    const read = vi.fn().mockReturnValue(first.promise)
    const queue = createRuntimeWorkRefreshQueue(read)
    const pending = queue.refresh()
    queue.refresh()
    queue.dispose()
    first.resolve()
    await pending
    await queue.refresh()
    expect(read).toHaveBeenCalledOnce()
  })
})
