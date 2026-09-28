import { describe, expect, test } from 'vitest'
import { pluginOperationNoticeAutoDismissDelay } from './pluginOperationNoticePolicy'

describe('pluginOperationNoticeAutoDismissDelay', () => {
  test('automatically dismisses reconciliation failures after a bounded delay', () => {
    expect(
      pluginOperationNoticeAutoDismissDelay({
        id: 'plugin-reconciliation-error',
        kind: 'error',
        message: 'failed',
      })
    ).toBe(8_000)
  })

  test('automatically dismisses non-actionable operation failures', () => {
    expect(
      pluginOperationNoticeAutoDismissDelay({
        id: 'install-failed',
        kind: 'error',
        message: 'failed',
      })
    ).toBe(8_000)
  })

  test('keeps actionable notices visible', () => {
    expect(
      pluginOperationNoticeAutoDismissDelay({
        id: 'install-failed',
        kind: 'error',
        message: 'failed',
        actionLabel: 'Retry',
        onAction: () => undefined,
      })
    ).toBeNull()
    expect(
      pluginOperationNoticeAutoDismissDelay({
        id: 'install-complete',
        kind: 'success',
        message: 'installed',
        actionLabel: 'Open',
        onAction: () => undefined,
      })
    ).toBeNull()
  })
})
