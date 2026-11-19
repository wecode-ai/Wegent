import { fireEvent, render } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ApplicationMenuButton } from './ApplicationMenuButton'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn(async () => {}) }))
vi.mock('@/lib/runtime-environment', () => ({ getDesktopWindowLabel: () => 'main' }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}))

test('opens the native menu via F10 and Alt+F; ignores modified and consumed keys and detaches on unmount', () => {
  const { unmount } = render(<ApplicationMenuButton />)
  fireEvent.keyDown(window, { key: 'F10', ctrlKey: true })
  fireEvent.keyDown(window, { key: 'F10', shiftKey: true })
  fireEvent.keyDown(window, { key: 'F10', metaKey: true })
  const consumed = new KeyboardEvent('keydown', { key: 'F10', cancelable: true })
  consumed.preventDefault()
  window.dispatchEvent(consumed)
  expect(invokeDesktopHost).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: 'F10' })
  fireEvent.keyDown(window, { key: 'f', code: 'KeyF', altKey: true })
  expect(invokeDesktopHost).toHaveBeenCalledTimes(2)
  expect(invokeDesktopHost).toHaveBeenCalledWith('applicationMenu.popup', { windowLabel: 'main' })
  unmount()
  fireEvent.keyDown(window, { key: 'F10' })
  expect(invokeDesktopHost).toHaveBeenCalledTimes(2)
})
