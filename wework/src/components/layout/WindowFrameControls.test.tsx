import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { WindowFrameControls } from './WindowFrameControls'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn().mockResolvedValue({ maximized: false }),
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

test('restores neutral Wework controls without overriding the native red close control', () => {
  render(<WindowFrameControls />)
  for (const id of ['window-minimize-button', 'window-maximize-button']) {
    expect(screen.getByTestId(id)).toHaveClass('wework:hover:bg-black/[0.08]')
  }
  expect(screen.getByTestId('window-close-button')).toHaveClass('hover:bg-[#e81123]')
  expect(screen.getByTestId('window-close-button')).not.toHaveClass(
    'wework:hover:bg-black/[0.08]',
    'wework:active:bg-black/[0.12]'
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(invokeDesktopHost).mockReset().mockResolvedValue({ maximized: false })
})

function prepareFrame() {
  let callback: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (next: FrameRequestCallback) => {
    callback = next
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return () => callback?.(0)
}

test('reads initial window state on the first frame and refreshes after native maximize', async () => {
  const frame = prepareFrame()
  vi.mocked(invokeDesktopHost)
    .mockReset()
    .mockResolvedValueOnce({ maximized: true })
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ maximized: false })
  const view = render(<WindowFrameControls />)
  expect(invokeDesktopHost).not.toHaveBeenCalled()
  await act(async () => {
    frame()
  })
  const button = screen.getByTestId('window-maximize-button')
  expect(button).toHaveAccessibleName('common.window.restore')
  await act(async () => {
    fireEvent.click(button)
  })
  expect(invokeDesktopHost).toHaveBeenCalledWith('window.toggleMaximize')
  expect(button).toHaveAccessibleName('common.window.maximize')
  view.unmount()
  expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
})

test('ignores out-of-order native reads and releases the resize subscription', async () => {
  const frame = prepareFrame()
  let finishOld!: (state: { maximized: boolean }) => void
  vi.mocked(invokeDesktopHost)
    .mockReset()
    .mockResolvedValueOnce({ maximized: false })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOld = resolve
        })
    )
    .mockResolvedValue({ maximized: true })
  const view = render(<WindowFrameControls />)
  await act(async () => {
    frame()
  })
  act(() => window.dispatchEvent(new Event('resize')))
  await act(async () => {
    window.dispatchEvent(new Event('resize'))
  })
  expect(screen.getByTestId('window-maximize-button')).toHaveAccessibleName('common.window.restore')
  await act(async () => {
    finishOld({ maximized: false })
  })
  expect(screen.getByTestId('window-maximize-button')).toHaveAccessibleName('common.window.restore')
  view.unmount()
  window.dispatchEvent(new Event('resize'))
  expect(invokeDesktopHost).toHaveBeenCalledTimes(3)
})
