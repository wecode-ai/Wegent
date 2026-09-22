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

  test('keeps actionable and unrelated errors visible', () => {
    expect(
      pluginOperationNoticeAutoDismissDelay({
        id: 'install-failed',
        kind: 'error',
        message: 'failed',
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
