import { describe, expect, test } from 'vitest'
import { shouldUseMobileWorkbenchLayout } from '@/lib/workbench-layout-mode'

describe('shouldUseMobileWorkbenchLayout', () => {
  test('keeps the desktop workbench in a narrow Tauri window', () => {
    expect(
      shouldUseMobileWorkbenchLayout({
        isMobileViewport: true,
        isTauri: true,
      })
    ).toBe(false)
  })

  test('uses the mobile workbench for a narrow browser viewport', () => {
    expect(
      shouldUseMobileWorkbenchLayout({
        isMobileViewport: true,
        isTauri: false,
      })
    ).toBe(true)
  })
})
