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

  test('closes the dialog immediately and sends one native close-to-tray command', async () => {
    render(<RuntimeTaskCloseGuard />)

    await waitFor(() => expect(mocks.closeRequestHandler).toBeDefined())
    act(() => {
      mocks.closeRequestHandler?.()
    })

    fireEvent.click(screen.getByTestId('runtime-task-close-confirm-button'))

    await waitFor(() =>
      expect(screen.queryByTestId('runtime-task-close-confirm-overlay')).not.toBeInTheDocument()
    )
    await waitFor(() => expect(mocks.closeMainWindowToTray).toHaveBeenCalledTimes(1))
  })
})
