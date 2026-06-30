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
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
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

  test('keeps narrow Tauri desktop windows in desktop mode', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 500,
    })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    const { result } = renderHook(() => useIsMobile())

    expect(result.current).toBe(false)
  })
})
