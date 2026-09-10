import { describe, expect, test } from 'vitest'
import { observeOperation } from './observeOperation'
import { subscribeOperationResults, type OperationResult } from './operationBus'

describe('business operation observation', () => {
  test('reports a resolved negative result as failure without changing the API response', async () => {
    const results: OperationResult[] = []
    const stop = subscribeOperationResults(result => results.push(result))
    try {
      const response = { status: 'failed', path: '/private/workspace', error: 'sensitive' }
      await expect(
        observeOperation(
          'smart_app.verify',
          async () => response,
          value => value.status === 'passed'
        )
      ).resolves.toBe(response)
      expect(results).toEqual([
        { key: 'smart_app.verify', outcome: 'failed', failureStage: 'confirm' },
      ])
    } finally {
      stop()
    }
  })

  test('preserves the original exception and isolates observer failures', async () => {
    const failure = new Error('private diagnostic')
    const results: OperationResult[] = []
    const stopBroken = subscribeOperationResults(() => {
      throw new Error('broken observer')
    })
    const stop = subscribeOperationResults(result => results.push(result))
    try {
      await expect(
        observeOperation('plugin.share', async () => {
          throw failure
        })
      ).rejects.toBe(failure)
      await expect(observeOperation('plugin.share', async () => 'saved')).resolves.toBe('saved')
      expect(results).toEqual([
        { key: 'plugin.share', outcome: 'failed', failureStage: 'request' },
        { key: 'plugin.share', outcome: 'succeeded' },
      ])
    } finally {
      stopBroken()
      stop()
    }
  })
})
