import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
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
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.desktopInvoke.mockImplementation((capability: string) => {
      if (capability === 'window.getState') return Promise.resolve({ maximized: false })
      return Promise.resolve(undefined)
    })
  })

  test('renders minimize, maximize and close buttons', () => {
    render(<WindowFrameControls />)
    expect(screen.getByTestId('window-minimize-button')).toBeInTheDocument()
    expect(screen.getByTestId('window-maximize-button')).toBeInTheDocument()
    expect(screen.getByTestId('window-close-button')).toBeInTheDocument()
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
      expect(screen.getByTestId('window-maximize-button')).toHaveAttribute(
        'aria-label',
        'window.restore'
      )
    )
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
