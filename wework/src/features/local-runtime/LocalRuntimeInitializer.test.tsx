import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ensureLocalExecutorStarted } from '@/tauri/localExecutor'
import { LocalRuntimeInitializer } from './LocalRuntimeInitializer'

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn(),
}))

const ensureMock = vi.mocked(ensureLocalExecutorStarted)

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
}

describe('LocalRuntimeInitializer', () => {
  beforeEach(() => {
    enableTauri()
    ensureMock.mockReset()
  })

  test('holds the app on the initialization screen until executor is ready', async () => {
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(screen.getByTestId('local-runtime-initializer')).toBeInTheDocument()
    expect(screen.queryByTestId('main-app')).not.toBeInTheDocument()

    expect(await screen.findByTestId('main-app')).toBeInTheDocument()
    expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
  })

  test('shows startup error and retries initialization', async () => {
    ensureMock
      .mockRejectedValueOnce(new Error('socket unavailable'))
      .mockResolvedValueOnce({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('local-runtime-error')).toHaveTextContent(
      'socket unavailable'
    )
    expect(screen.getByText('~/.wegent-executor/logs/executor.log')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('local-runtime-retry-button'))

    await waitFor(() => expect(screen.getByTestId('main-app')).toBeInTheDocument())
  })

  test('does not block non-tauri runtimes', () => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(screen.getByTestId('main-app')).toBeInTheDocument()
    expect(ensureMock).not.toHaveBeenCalled()
  })
})
