import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useIsMobile } from './useIsMobile'

const runtime = vi.hoisted(() => ({ electron: false }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => runtime.electron }))
afterEach(() => {
  runtime.electron = false
  vi.unstubAllGlobals()
})

test('tracks viewport transitions and releases its media subscription', () => {
  let changed: (() => void) | undefined
  const removeEventListener = vi.fn()
  vi.stubGlobal('innerWidth', 767)
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: (_event: string, listener: () => void) => {
        changed = listener
      },
      removeEventListener,
    }))
  )
  const { result, unmount } = renderHook(useIsMobile)
  expect(result.current).toBe(true)
  act(() => {
    vi.stubGlobal('innerWidth', 768)
    changed?.()
  })
  expect(result.current).toBe(false)
  act(() => {
    vi.stubGlobal('innerWidth', 767)
    changed?.()
  })
  expect(result.current).toBe(true)
  unmount()
  expect(removeEventListener).toHaveBeenCalledWith('change', changed)
})

test('Electron remains in desktop mode at mobile widths without matchMedia', () => {
  runtime.electron = true
  vi.stubGlobal('innerWidth', 320)
  vi.stubGlobal('matchMedia', undefined)
  expect(renderHook(useIsMobile).result.current).toBe(false)
})
