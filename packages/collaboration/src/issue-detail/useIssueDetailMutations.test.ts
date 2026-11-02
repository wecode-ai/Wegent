import { describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue } from '../types'
import { createIssueDetailMutationQueue } from './useIssueDetailMutations'

const issue = {
  id: 'issue-1',
  version: 1,
  title: 'Original',
  description: 'Saved',
  status: 'inbox',
} as CollaborationIssue

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Issue detail mutation queue', () => {
  it('serializes writes against the last response before props catch up', async () => {
    const first = deferred<CollaborationIssue>()
    const publish = vi.fn()
    const queue = createIssueDetailMutationQueue(issue)
    queue.sync(issue, publish)
    const firstWrite = vi.fn(() => first.promise)
    const secondWrite = vi.fn(async (source: CollaborationIssue) => ({
      ...source,
      priority: 'high' as const,
      version: source.version + 1,
    }))
    const a = queue.run(firstWrite)
    const b = queue.run(secondWrite)
    await Promise.resolve()
    expect(firstWrite).toHaveBeenCalledWith(issue)
    expect(secondWrite).not.toHaveBeenCalled()
    const changed = { ...issue, status: 'pending', version: 2 }
    first.resolve(changed)
    await a
    queue.sync(issue, publish)
    await b
    expect(secondWrite).toHaveBeenCalledWith(changed)
    expect(queue.source()).toMatchObject({
      version: 3,
      status: 'pending',
      priority: 'high',
    })
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('continues after a rejected operation without advancing its version', async () => {
    const queue = createIssueDetailMutationQueue(issue)
    const error = new Error('denied')
    const failed = queue.run(async () => {
      throw error
    })
    const next = vi.fn(async (source: CollaborationIssue) => ({
      ...source,
      version: 2,
    }))
    const saved = queue.run(next)
    await expect(failed).rejects.toBe(error)
    await saved
    expect(next).toHaveBeenCalledWith(issue)
  })

  it('retains a committed description when the subsequent assignment fails', async () => {
    const publish = vi.fn()
    const queue = createIssueDetailMutationQueue(issue)
    queue.sync(issue, publish)
    const saved = { ...issue, description: 'New description', version: 2 }
    await expect(
      queue.run(async () => {
        queue.commit(saved)
        throw new Error('assignment denied')
      })
    ).rejects.toThrow('assignment denied')
    expect(publish).toHaveBeenCalledExactlyOnceWith(saved)
    expect(queue.source()).toBe(saved)
    const next = vi.fn(async (source: CollaborationIssue) => source)
    await queue.run(next)
    expect(next).toHaveBeenCalledWith(saved)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('preserves a newer external version when an older response arrives', async () => {
    const pending = deferred<CollaborationIssue>()
    const publish = vi.fn()
    const queue = createIssueDetailMutationQueue(issue)
    queue.sync(issue, publish)
    const request = queue.run(() => pending.promise)
    await Promise.resolve()
    const latest = { ...issue, version: 3, status: 'completed' }
    queue.sync(latest, publish)
    pending.resolve({ ...issue, version: 2, status: 'pending' })
    await expect(request).resolves.toBe(latest)
    expect(publish).not.toHaveBeenCalled()
  })

  it('keeps a non-versioned following update when only the host callback changes', async () => {
    const source = { ...issue, is_following: false }
    const queue = createIssueDetailMutationQueue(source)
    const originalCallback = vi.fn()
    const nextCallback = vi.fn()
    queue.sync(source, originalCallback)
    await queue.run(async current => ({ ...current, is_following: true }))

    queue.sync(source, nextCallback)

    expect(queue.source()).toMatchObject({ version: 1, is_following: true })
    await queue.run(async current => ({
      ...current,
      priority: 'high',
      version: 2,
    }))
    expect(nextCallback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ version: 2, is_following: true })
    )
  })

  it('isolates a departed scope and cancels writes that have not started', async () => {
    const pending = deferred<CollaborationIssue>()
    const publish = vi.fn()
    const queue = createIssueDetailMutationQueue(issue)
    queue.sync(issue, publish)
    const first = queue.run(() => pending.promise)
    const skipped = vi.fn(async (source: CollaborationIssue) => source)
    const second = queue.run(skipped)
    await Promise.resolve()
    queue.setActive(false)
    const reopened = createIssueDetailMutationQueue(issue)
    reopened.sync(issue, publish)
    pending.resolve({ ...issue, version: 2 })
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toBeNull()
    expect(skipped).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    await reopened.run(async source => ({ ...source, version: 3 }))
    expect(publish).toHaveBeenCalledExactlyOnceWith({ ...issue, version: 3 })
  })
})
