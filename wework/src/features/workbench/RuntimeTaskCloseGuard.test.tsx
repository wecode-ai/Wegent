import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { RuntimeTaskCloseGuard } from './RuntimeTaskCloseGuard'

const mocks = vi.hoisted(() => ({
  closeRequestHandler: undefined as (() => void) | undefined,
  installRuntimeTaskCloseGuard: vi.fn(),
  closeMainWindowToTray: vi.fn(),
  unlisten: vi.fn(),
}))

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

vi.mock('@/tauri/runtimeTaskCloseGuard', () => ({
  closeMainWindowToTray: mocks.closeMainWindowToTray,
  installRuntimeTaskCloseGuard: mocks.installRuntimeTaskCloseGuard,
}))

describe('RuntimeTaskCloseGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.closeMainWindowToTray.mockResolvedValue(undefined)
    mocks.closeRequestHandler = undefined
    mocks.installRuntimeTaskCloseGuard.mockImplementation(async handler => {
      mocks.closeRequestHandler = handler
      return mocks.unlisten
    })
  })

  test('shows the close-to-tray prompt for every intercepted first close request', async () => {
    render(<RuntimeTaskCloseGuard />)

    await waitFor(() => expect(mocks.closeRequestHandler).toBeDefined())
    act(() => {
      mocks.closeRequestHandler?.()
    })

    expect(screen.getByTestId('runtime-task-close-confirm-overlay')).toBeInTheDocument()
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
