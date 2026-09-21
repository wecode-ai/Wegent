import { describe, expect, test, vi } from 'vitest'
import { retryOperation } from './retry-operation.mjs'

describe('retryOperation', () => {
  test('retries failures with linear backoff until the operation succeeds', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue('ready')
    const sleepImpl = vi.fn().mockResolvedValue(undefined)
    const onRetry = vi.fn()

    await expect(
      retryOperation(operation, {
        retryDelayMs: 10,
        sleepImpl,
        onRetry,
      })
    ).resolves.toBe('ready')

    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 10)
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 20)
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  test('rejects with the final error after exhausting attempts', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('final failure'))

    await expect(
      retryOperation(operation, {
        attempts: 2,
        retryDelayMs: 0,
        sleepImpl: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow('final failure')

    expect(operation).toHaveBeenCalledTimes(2)
  })
})
