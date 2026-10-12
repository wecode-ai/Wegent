import { describe, expect, it } from 'vitest'
import { allSettledWithConcurrency } from './promise-concurrency'

describe('allSettledWithConcurrency', () => {
  it('limits concurrent operations and preserves result order', async () => {
    let active = 0
    let maxActive = 0
    const releases: Array<() => void> = []

    const resultsPromise = allSettledWithConcurrency([1, 2, 3, 4], 2, async value => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => {
        releases.push(resolve)
      })
      active -= 1
      if (value === 3) throw new Error('failed')
      return value * 10
    })

    await expect.poll(() => releases.length).toBe(2)
    releases.shift()?.()
    await expect.poll(() => releases.length).toBe(2)
    releases.shift()?.()
    await expect.poll(() => releases.length).toBe(2)
    releases.splice(0).forEach(release => release())

    await expect(resultsPromise).resolves.toEqual([
      { status: 'fulfilled', value: 10 },
      { status: 'fulfilled', value: 20 },
      { status: 'rejected', reason: expect.objectContaining({ message: 'failed' }) },
      { status: 'fulfilled', value: 40 },
    ])
    expect(maxActive).toBe(2)
  })

  it('rejects invalid concurrency', async () => {
    await expect(allSettledWithConcurrency([], 0, async () => undefined)).rejects.toThrow(
      'Concurrency must be a positive integer'
    )
  })
})
