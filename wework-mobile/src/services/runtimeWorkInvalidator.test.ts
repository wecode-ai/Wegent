import { describe, expect, it, vi } from 'vitest'

import { RuntimeWorkInvalidator } from './runtimeWorkInvalidator'

describe('RuntimeWorkInvalidator', () => {
  it('coalesces an event burst into the active refresh and one trailing refresh', async () => {
    let releaseFirst!: () => void
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            releaseFirst = resolve
          })
      )
      .mockResolvedValue(undefined)
    const invalidator = new RuntimeWorkInvalidator(refresh)

    const first = invalidator.invalidate()
    const second = invalidator.invalidate()
    const third = invalidator.invalidate()
    releaseFirst()
    await Promise.all([first, second, third])

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('can refresh again after a failed cycle', async () => {
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const invalidator = new RuntimeWorkInvalidator(refresh)

    await expect(invalidator.invalidate()).rejects.toThrow('offline')
    await expect(invalidator.invalidate()).resolves.toBeUndefined()
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
