import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { WindowFrameControls } from './WindowFrameControls'

const mocks = vi.hoisted(() => {
  return {
    desktopInvoke: vi.fn(),
  }
})

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.desktopInvoke,
}))

describe('WindowFrameControls', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN')
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.desktopInvoke.mockImplementation((capability: string) => {
      if (capability === 'window.getState') return Promise.resolve({ maximized: false })
      return Promise.resolve(undefined)
    })
  })

  test('renders minimize, maximize and close buttons', () => {
    render(<WindowFrameControls />)
    const minimizeButton = screen.getByTestId('window-minimize-button')
    const maximizeButton = screen.getByTestId('window-maximize-button')
    const closeButton = screen.getByTestId('window-close-button')
    expect(minimizeButton).toBeInTheDocument()
    expect(maximizeButton).toBeInTheDocument()
    expect(closeButton).toBeInTheDocument()
    expect(minimizeButton).toHaveAttribute('aria-label', '最小化')
    expect(minimizeButton).toHaveAttribute('title', '最小化')
    expect(maximizeButton).toHaveAttribute('aria-label', '最大化')
    expect(maximizeButton).toHaveAttribute('title', '最大化')
    expect(closeButton).toHaveAttribute('aria-label', '关闭')
    expect(closeButton).toHaveAttribute('title', '关闭')
  })

  test('minimize button calls the Electron host', async () => {
    render(<WindowFrameControls />)
    fireEvent.click(screen.getByTestId('window-minimize-button'))
    await waitFor(() => expect(mocks.desktopInvoke).toHaveBeenCalledWith('window.minimize'))
  })

  test('maximize button toggles the Electron window state', async () => {
    render(<WindowFrameControls />)
    fireEvent.click(screen.getByTestId('window-maximize-button'))
    await waitFor(() => expect(mocks.desktopInvoke).toHaveBeenCalledWith('window.toggleMaximize'))
  })

  test('shows restore semantics when the Electron window is maximized', async () => {
    mocks.desktopInvoke.mockImplementation((capability: string) => {
      if (capability === 'window.getState') return Promise.resolve({ maximized: true })
      return Promise.resolve(undefined)
    })

    render(<WindowFrameControls />)
    await waitFor(() =>
      expect(screen.getByTestId('window-maximize-button')).toHaveAttribute('aria-label', '还原')
    )
    expect(screen.getByTestId('window-maximize-button')).toHaveAttribute('title', '还原')
  })

  test('close button requests the standard window close flow', async () => {
    render(<WindowFrameControls />)
    fireEvent.click(screen.getByTestId('window-close-button'))
    await waitFor(() => expect(mocks.desktopInvoke).toHaveBeenCalledWith('window.close'))
  })

  test('refreshes maximized state after a resize event', async () => {
    render(<WindowFrameControls />)
    await waitFor(() => expect(mocks.desktopInvoke).toHaveBeenCalledWith('window.getState'))
    mocks.desktopInvoke.mockClear()

    fireEvent(window, new Event('resize'))

    await waitFor(() => expect(mocks.desktopInvoke).toHaveBeenCalledWith('window.getState'))
  })
})
