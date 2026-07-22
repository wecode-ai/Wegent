import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { WindowFrameControls } from './WindowFrameControls'

const mocks = vi.hoisted(() => {
  const unlisten = vi.fn()
  const windowMock = {
    minimize: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    unmaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(unlisten),
  }
  return { unlisten, windowMock }
})

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => mocks.windowMock),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

describe('WindowFrameControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.windowMock.isMaximized.mockResolvedValue(false)
  })

  test('renders minimize, maximize and close buttons', () => {
    render(<WindowFrameControls />)
    expect(screen.getByTestId('window-minimize-button')).toBeInTheDocument()
    expect(screen.getByTestId('window-maximize-button')).toBeInTheDocument()
    expect(screen.getByTestId('window-close-button')).toBeInTheDocument()
  })

  test('minimize button calls window.minimize', async () => {
    render(<WindowFrameControls />)
    fireEvent.click(screen.getByTestId('window-minimize-button'))
    await waitFor(() => expect(mocks.windowMock.minimize).toHaveBeenCalledTimes(1))
  })

  test('maximize button calls window.maximize when not maximized', async () => {
    render(<WindowFrameControls />)
    fireEvent.click(screen.getByTestId('window-maximize-button'))
    await waitFor(() => expect(mocks.windowMock.maximize).toHaveBeenCalledTimes(1))
    expect(mocks.windowMock.unmaximize).not.toHaveBeenCalled()
  })

  test('maximize button calls window.unmaximize when already maximized', async () => {
    let capturedHandler: (() => void) | undefined
    mocks.windowMock.onResized.mockImplementationOnce((handler: () => void) => {
      capturedHandler = handler
      return Promise.resolve(mocks.unlisten)
    })
    mocks.windowMock.isMaximized.mockResolvedValue(true)

    render(<WindowFrameControls />)
    capturedHandler?.()
    await waitFor(() => expect(mocks.windowMock.isMaximized).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('window-maximize-button'))
    await waitFor(() => expect(mocks.windowMock.unmaximize).toHaveBeenCalledTimes(1))
    expect(mocks.windowMock.maximize).not.toHaveBeenCalled()
  })

  test('close button invokes close_main_window_to_tray command', async () => {
    render(<WindowFrameControls />)
    fireEvent.click(screen.getByTestId('window-close-button'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_main_window_to_tray'))
  })

  test('falls back to window.close when close_main_window_to_tray command fails', async () => {
    const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>
    invokeMock.mockRejectedValueOnce(new Error('command unavailable'))

    render(<WindowFrameControls />)
    fireEvent.click(screen.getByTestId('window-close-button'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('close_main_window_to_tray'))
    await waitFor(() => expect(mocks.windowMock.close).toHaveBeenCalledTimes(1))
  })

  test('subscribes to resize events to update maximized state', async () => {
    render(<WindowFrameControls />)
    expect(mocks.windowMock.onResized).toHaveBeenCalled()
  })

  test('updates maximized state on resize', async () => {
    let capturedHandler: (() => void) | undefined
    mocks.windowMock.onResized.mockImplementationOnce((handler: () => void) => {
      capturedHandler = handler
      return Promise.resolve(mocks.unlisten)
    })
    mocks.windowMock.isMaximized.mockResolvedValue(true)

    render(<WindowFrameControls />)
    expect(mocks.windowMock.onResized).toHaveBeenCalled()
    expect(capturedHandler).toBeDefined()
    capturedHandler?.()

    await waitFor(() => expect(mocks.windowMock.isMaximized).toHaveBeenCalled())
  })
})
