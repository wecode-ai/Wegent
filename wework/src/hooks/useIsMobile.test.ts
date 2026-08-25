import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useIsMobile } from './useIsMobile'

const originalInnerWidth = window.innerWidth

describe('useIsMobile', () => {
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    })
    delete window.__WEWORK_RUNTIME_CONFIG__
    vi.unstubAllGlobals()
  })

  test('treats narrow browser viewports as mobile', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    })

    const { result } = renderHook(() => useIsMobile())

    expect(result.current).toBe(true)
  })

  test('keeps narrow Electron desktop windows in desktop mode', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    })
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }

    const { result } = renderHook(() => useIsMobile())

    expect(result.current).toBe(false)
  })
})
