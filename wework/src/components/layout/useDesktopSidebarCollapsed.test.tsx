import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  requestDesktopSidebarToggle,
  useDesktopSidebarCollapsed,
  useDesktopSidebarToggleRequest,
} from './useDesktopSidebarCollapsed'

test('shares sidebar state and retains it when persistence fails', () => {
  localStorage.clear()
  const first = renderHook(useDesktopSidebarCollapsed)
  const second = renderHook(useDesktopSidebarCollapsed)
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Unavailable')
  })
  try {
    act(() => first.result.current.setSidebarCollapsed(true))
    expect(first.result.current.sidebarCollapsed).toBe(true)
    expect(second.result.current.sidebarCollapsed).toBe(true)
    write.mockRestore()
    localStorage.setItem('wework.desktop.sidebar.collapsed', 'false')
    act(() => window.dispatchEvent(new Event('storage')))
    expect(first.result.current.sidebarCollapsed).toBe(false)
    expect(second.result.current.sidebarCollapsed).toBe(false)
  } finally {
    write.mockRestore()
    first.unmount()
    second.unmount()
  }
})

test('uses the current toggle handler and releases the native request listener', () => {
  const first = vi.fn(),
    second = vi.fn()
  const view = renderHook(({ handler }) => useDesktopSidebarToggleRequest(handler), {
    initialProps: { handler: first },
  })
  expect(requestDesktopSidebarToggle()).toBe(true)
  expect(first).toHaveBeenCalledOnce()
  view.rerender({ handler: second })
  expect(requestDesktopSidebarToggle()).toBe(true)
  expect(second).toHaveBeenCalledOnce()
  view.unmount()
  expect(requestDesktopSidebarToggle()).toBe(false)
})
