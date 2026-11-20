import { describe, expect, test, vi } from 'vitest'
import {
  createCloudModelCatalogSyncQueue,
  type CloudModelCatalogSyncRequest,
} from './cloudModelCatalogSyncRequest'

function deferred() {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

function request(overrides: Partial<CloudModelCatalogSyncRequest> = {}) {
  return {
    deviceId: 'cloud-device',
    deviceName: 'Cloud Executor',
    modelName: 'Local Responses',
    sync: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('cloud model catalog confirmation ownership', () => {
  test('declines without a host instead of leaving the caller waiting', async () => {
    const queue = createCloudModelCatalogSyncQueue()
    const operation = request()
    await expect(queue.request(operation)).resolves.toBe(false)
    expect(operation.sync).not.toHaveBeenCalled()
    expect(queue.getSnapshot()).toBeNull()
  })

  test('confirms only the reviewed head and preserves FIFO order', async () => {
    const queue = createCloudModelCatalogSyncQueue()
    const stop = queue.subscribe(vi.fn())
    const first = request(),
      second = request({ deviceName: 'Other device' })
    const firstResult = queue.request(first)
    const firstId = queue.getSnapshot()!.id
    const secondResult = queue.request(second)
    await queue.confirm(firstId + 1)
    expect(second.sync).not.toHaveBeenCalled()
    await queue.confirm(firstId)
    await expect(firstResult).resolves.toBe(true)
    expect(first.sync).toHaveBeenCalledTimes(1)
    expect(queue.getSnapshot()?.deviceName).toBe('Other device')
    queue.cancel(firstId)
    expect(queue.getSnapshot()).not.toBeNull()
    queue.cancel(queue.getSnapshot()!.id)
    await expect(secondResult).resolves.toBe(false)
    expect(second.sync).not.toHaveBeenCalled()
    stop()
  })

  test('deduplicates synchronous confirms and refuses cancellation while the confirmed sync runs', async () => {
    const queue = createCloudModelCatalogSyncQueue()
    const stop = queue.subscribe(vi.fn())
    const pending = deferred(),
      operation = request({ sync: vi.fn(() => pending.promise) })
    const result = queue.request(operation)
    const id = queue.getSnapshot()!.id
    const running = queue.confirm(id)
    await queue.confirm(id)
    queue.cancel(id)
    expect(queue.getSnapshot()?.syncing).toBe(true)
    expect(operation.sync).toHaveBeenCalledTimes(1)
    pending.resolve()
    await running
    await expect(result).resolves.toBe(true)
    expect(queue.getSnapshot()).toBeNull()
    stop()
  })

  test('retains failure when another request arrives, then retries only on confirmation', async () => {
    const queue = createCloudModelCatalogSyncQueue()
    const stop = queue.subscribe(vi.fn())
    const cause = new Error('Cloud busy')
    const operation = request({
      sync: vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined),
    })
    const result = queue.request(operation)
    const id = queue.getSnapshot()!.id
    await queue.confirm(id)
    const later = queue.request(request())
    expect(queue.getSnapshot()).toMatchObject({ id, syncing: false, failure: { cause } })
    expect(operation.sync).toHaveBeenCalledTimes(1)
    await queue.confirm(id)
    await expect(result).resolves.toBe(true)
    expect(queue.getSnapshot()?.failure).toBeNull()
    stop()
    await expect(later).resolves.toBe(false)
  })

  test('cancels unconfirmed requests only when the final host detaches', async () => {
    const queue = createCloudModelCatalogSyncQueue()
    const stop = queue.subscribe(vi.fn()),
      stopOther = queue.subscribe(vi.fn())
    const first = request(),
      second = request()
    const one = queue.request(first),
      two = queue.request(second)
    const snapshot = queue.getSnapshot()
    stop()
    expect(queue.getSnapshot()).toBe(snapshot)
    stopOther()
    await expect(one).resolves.toBe(false)
    await expect(two).resolves.toBe(false)
    expect(first.sync).not.toHaveBeenCalled()
    expect(second.sync).not.toHaveBeenCalled()
    expect(queue.getSnapshot()).toBeNull()
  })

  test('finishes an explicitly confirmed sync after host detachment and cancels queued work', async () => {
    const queue = createCloudModelCatalogSyncQueue()
    const stop = queue.subscribe(vi.fn())
    const pending = deferred()
    const result = queue.request(request({ sync: () => pending.promise }))
    const waiting = queue.request(request())
    const running = queue.confirm(queue.getSnapshot()!.id)
    stop()
    await expect(waiting).resolves.toBe(false)
    expect(queue.getSnapshot()?.syncing).toBe(true)
    pending.resolve()
    await running
    await expect(result).resolves.toBe(true)
    expect(queue.getSnapshot()).toBeNull()
  })

  test('settles a failed confirmed sync when no host remains to offer retry', async () => {
    const queue = createCloudModelCatalogSyncQueue()
    const stop = queue.subscribe(vi.fn())
    const pending = deferred()
    const result = queue.request(request({ sync: () => pending.promise }))
    const running = queue.confirm(queue.getSnapshot()!.id)
    stop()
    pending.reject(new Error('Cloud disconnected'))
    await running
    await expect(result).resolves.toBe(false)
    expect(queue.getSnapshot()).toBeNull()
  })

  test('a replacement host observes the same confirmed work and its retryable failure', async () => {
    const queue = createCloudModelCatalogSyncQueue()
    const stop = queue.subscribe(vi.fn())
    const pending = deferred(),
      operation = request({ sync: vi.fn(() => pending.promise) })
    const result = queue.request(operation)
    const id = queue.getSnapshot()!.id
    const running = queue.confirm(id)
    stop()
    const stopNext = queue.subscribe(vi.fn())
    expect(queue.getSnapshot()).toMatchObject({ id, syncing: true })
    pending.reject('Network unavailable')
    await running
    expect(queue.getSnapshot()).toMatchObject({
      id,
      syncing: false,
      failure: { cause: 'Network unavailable' },
    })
    expect(operation.sync).toHaveBeenCalledTimes(1)
    queue.cancel(id)
    await expect(result).resolves.toBe(false)
    stopNext()
  })
})
