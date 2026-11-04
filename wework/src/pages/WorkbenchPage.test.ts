// @vitest-environment node

import { shouldUseMobileWorkbenchLayout } from '@/lib/workbench-layout-mode'
import { describe, expect, test } from 'vitest'

describe('shouldUseMobileWorkbenchLayout', () => {
  test('keeps the desktop workbench in a narrow Electron window', () => {
    expect(
      shouldUseMobileWorkbenchLayout({
        isMobileViewport: true,
        isDesktop: true,
      })
    ).toBe(false)
  })
})
