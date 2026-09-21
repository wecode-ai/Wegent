import { describe, expect, test, vi } from 'vitest'
import { beginOperation, subscribeOperationResults } from './operationBus'

describe('operation bus', () => {
  test('publishes only the first terminal result for an attempt', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeOperationResults(listener)
    const attempt = beginOperation('smart_app.install')

    expect(attempt.succeed()).toBe(true)
    expect(attempt.fail('install')).toBe(false)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({
      key: 'smart_app.install',
      outcome: 'succeeded',
    })
    unsubscribe()
  })

  test('does not publish a cancelled attempt', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeOperationResults(listener)
    const attempt = beginOperation('smart_app.zip_import')

    attempt.cancel()
    expect(attempt.succeed()).toBe(false)

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  test('carries stable plugin identity from operation start to completion', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeOperationResults(listener)
    const attempt = beginOperation('plugin.authorize', {
      properties: {
        plugin_distribution: 'official',
        plugin_id: 'openai-curated-remote/gmail',
      },
    })

    attempt.fail('confirm')

    expect(listener).toHaveBeenCalledWith({
      key: 'plugin.authorize',
      outcome: 'failed',
      failureStage: 'confirm',
      properties: {
        plugin_distribution: 'official',
        plugin_id: 'openai-curated-remote/gmail',
      },
    })
    unsubscribe()
  })

  test('rejects unknown operation keys', () => {
    expect(() => beginOperation('smart_app.remove' as 'smart_app.install')).toThrow(
      'Unknown telemetry operation: smart_app.remove'
    )
  })
})
