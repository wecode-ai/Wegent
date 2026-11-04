// @vitest-environment node

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
})
