import { describe, expect, test } from 'vitest'
import { shouldUseMobileWorkbenchLayout } from '@/lib/workbench-layout-mode'

describe('shouldUseMobileWorkbenchLayout', () => {
  test('keeps the desktop workbench in a narrow Electron window', () => {
    expect(
      shouldUseMobileWorkbenchLayout({
        isMobileViewport: true,
        isDesktop: true,
      })
    ).toBe(false)
  })

  test('uses the mobile workbench for a narrow browser viewport', () => {
    expect(
      shouldUseMobileWorkbenchLayout({
        isMobileViewport: true,
        isDesktop: false,
      })
    ).toBe(true)
  })

  test('keeps a board surface on the board-capable desktop layout in a narrow browser viewport', () => {
    expect(
      shouldUseMobileWorkbenchLayout({
        isMobileViewport: true,
        isDesktop: false,
        surfaceKind: 'board',
      })
    ).toBe(false)
  })
})
