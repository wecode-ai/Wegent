import { describe, expect, test } from 'vitest'
import {
  desktopMediaQuery,
  isDesktopViewport,
  isMobileViewport,
  mobileMediaQuery,
  RESPONSIVE_BREAKPOINTS,
} from './responsive'

describe('responsive breakpoints', () => {
  test('uses one shared mobile-to-desktop boundary', () => {
    expect(RESPONSIVE_BREAKPOINTS.mobileMax).toBe(767)
    expect(RESPONSIVE_BREAKPOINTS.desktopMin).toBe(768)
    expect(isMobileViewport(767)).toBe(true)
    expect(isMobileViewport(768)).toBe(false)
    expect(isDesktopViewport(767)).toBe(false)
    expect(isDesktopViewport(768)).toBe(true)
  })

  test('derives media queries from the shared boundary', () => {
    expect(mobileMediaQuery()).toBe('(max-width: 767px)')
    expect(desktopMediaQuery()).toBe('(min-width: 768px)')
  })
})
