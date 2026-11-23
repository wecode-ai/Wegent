// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest'

import { createVersionMutationQueue } from '../versionMutationQueue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, reject, resolve }
}

describe('project version mutation queue', () => {
  it('serializes concurrent setting categories and passes the previous response version', async () => {
    const firstResponse = deferred<{ version: number }>()
    const update = vi
      .fn<(category: string, version: number) => Promise<{ version: number }>>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce({ version: 7 })
    const queue = createVersionMutationQueue<{ version: number }>(5)

    const visibility = queue.enqueue(
      version => update('visibility', version),
      project => project.version
    )
    const display = queue.enqueue(
      version => update('card_display', version),
      project => project.version
    )

    await Promise.resolve()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenNthCalledWith(1, 'visibility', 5)

    firstResponse.resolve({ version: 6 })
    await expect(visibility).resolves.toEqual({ version: 6 })
    await expect(display).resolves.toEqual({ version: 7 })

    expect(update).toHaveBeenNthCalledWith(2, 'card_display', 6)
  })

  it('continues the queue after a failed mutation without inventing a version', async () => {
    const update = vi
      .fn<(version: number) => Promise<{ version: number }>>()
      .mockRejectedValueOnce(new Error('conflict'))
      .mockResolvedValueOnce({ version: 10 })
    const queue = createVersionMutationQueue<{ version: number }>(9)

    await expect(queue.enqueue(update, project => project.version)).rejects.toThrow('conflict')
    await expect(queue.enqueue(update, project => project.version)).resolves.toEqual({
      version: 10,
    })

    expect(update).toHaveBeenNthCalledWith(1, 9)
    expect(update).toHaveBeenNthCalledWith(2, 9)
  })
})

it('observes authoritative versions and keeps a newer source version while older receipts settle', async () => {
  const queue = createVersionMutationQueue<{ version: number }>(2)
  const snapshots: number[] = []
  const stop = queue.subscribe(() => snapshots.push(queue.getSnapshot()), 3)
  const first = deferred<{ version: number }>()
  const update = vi.fn(async (version: number) => ({ version: version + 1 }))
  const pendingFirst = queue.enqueue(
    () => first.promise,
    project => project.version
  )
  const pendingSecond = queue.enqueue(update, project => project.version)
  queue.synchronize(1)
  expect(snapshots).toEqual([3])
  const refreshed: number[] = []
  const stopRefreshed = queue.subscribe(() => refreshed.push(queue.getSnapshot()), 10)
  first.resolve({ version: 4 })
  await pendingFirst
  await pendingSecond
  expect(update).toHaveBeenCalledExactlyOnceWith(10)
  expect(snapshots).toEqual([3, 10, 11])
  expect(refreshed).toEqual([10, 11])
  stop()
  stopRefreshed()
  queue.synchronize(12)
  expect(queue.getSnapshot()).toBe(12)
  expect(snapshots).toEqual([3, 10, 11])
  expect(refreshed).toEqual([10, 11])
})
