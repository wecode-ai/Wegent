import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { RuntimeTaskCloseGuard } from './RuntimeTaskCloseGuard'

const mocks = vi.hoisted(() => ({
  closeRequestHandler: undefined as (() => void) | undefined,
  cancelMainWindowClose: vi.fn(),
  installRuntimeTaskCloseGuard: vi.fn(),
  closeMainWindowToTray: vi.fn(),
  quitApplication: vi.fn(),
  unlisten: vi.fn(),
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
}))

vi.mock('@/desktop/runtimeTaskCloseGuard', () => ({
  cancelMainWindowClose: mocks.cancelMainWindowClose,
  closeMainWindowToTray: mocks.closeMainWindowToTray,
  installRuntimeTaskCloseGuard: mocks.installRuntimeTaskCloseGuard,
  quitApplication: mocks.quitApplication,
}))

describe('RuntimeTaskCloseGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.cancelMainWindowClose.mockResolvedValue(undefined)
    mocks.closeMainWindowToTray.mockResolvedValue(undefined)
    mocks.quitApplication.mockResolvedValue(undefined)
    mocks.closeRequestHandler = undefined
    mocks.installRuntimeTaskCloseGuard.mockImplementation(async handler => {
      mocks.closeRequestHandler = handler
      return mocks.unlisten
    })
  })

  test('closes the dialog while the native close-to-tray command is pending', async () => {
    let resolveClose: (() => void) | undefined
    mocks.closeMainWindowToTray.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolveClose = resolve
        })
    )
    render(<RuntimeTaskCloseGuard />)

    await waitFor(() => expect(mocks.closeRequestHandler).toBeDefined())
    act(() => {
      mocks.closeRequestHandler?.()
    })

    fireEvent.click(screen.getByTestId('runtime-task-close-confirm-button'))

    expect(screen.queryByTestId('runtime-task-close-confirm-overlay')).not.toBeInTheDocument()
    expect(mocks.closeMainWindowToTray).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveClose?.()
    })
  })

  test('reopens the dialog when quitting completely fails', async () => {
    const error = new Error('native quit failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.quitApplication.mockRejectedValueOnce(error)
    render(<RuntimeTaskCloseGuard />)

    await waitFor(() => expect(mocks.closeRequestHandler).toBeDefined())
    act(() => {
      mocks.closeRequestHandler?.()
    })

    fireEvent.click(screen.getByTestId('runtime-task-close-cancel-button'))

    const quitButton = await screen.findByTestId('runtime-task-close-cancel-button')
    expect(quitButton).toBeEnabled()
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to quit from close-to-tray confirmation:',
      error
    )
  })

  test('reopens the dialog for retry when the native close-to-tray command fails', async () => {
    const error = new Error('native close failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.closeMainWindowToTray.mockRejectedValueOnce(error)
    render(<RuntimeTaskCloseGuard />)

    await waitFor(() => expect(mocks.closeRequestHandler).toBeDefined())
    act(() => {
      mocks.closeRequestHandler?.()
    })

    fireEvent.click(screen.getByTestId('runtime-task-close-confirm-button'))

    const confirmButton = await screen.findByTestId('runtime-task-close-confirm-button')
    expect(confirmButton).toBeEnabled()
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to hide window after close-to-tray hint confirmation:',
      error
    )
  })
})
