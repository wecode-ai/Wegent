import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { ensureLocalExecutorStarted } from '@/tauri/localExecutor'
import { LocalRuntimeInitializer } from './LocalRuntimeInitializer'

vi.mock('@/tauri/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn(),
}))

const ensureMock = vi.mocked(ensureLocalExecutorStarted)
const DEV_STARTUP_HOLD_MS = 4800

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
}

describe('LocalRuntimeInitializer', () => {
  beforeEach(() => {
    enableTauri()
    vi.stubEnv('DEV', false)
    ensureMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  test('holds the app on the initialization screen until executor is ready', async () => {
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(screen.getByTestId('local-runtime-initializer')).toBeInTheDocument()
    expect(screen.getByText('正在整理你的工作台')).toBeInTheDocument()
    expect(screen.getByText('铺好工作台中')).toBeInTheDocument()
    expect(screen.queryByText(/执行器|daemon/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('main-app')).not.toBeInTheDocument()

    expect(await screen.findByTestId('main-app')).toBeInTheDocument()
    expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
  })

  test('keeps the startup animation visible for one cycle in dev mode', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-26T00:00:00Z'))
    vi.stubEnv('DEV', true)
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(screen.getByTestId('local-runtime-initializer')).toBeInTheDocument()
    expect(screen.queryByTestId('main-app')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEV_STARTUP_HOLD_MS - 1)
    })
    expect(screen.queryByTestId('main-app')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.getByTestId('main-app')).toBeInTheDocument()
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

    expect(await screen.findByTestId('local-runtime-error')).toHaveTextContent('socket unavailable')
    expect(screen.getByText('~/.wegent-executor/logs/executor.log')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('local-runtime-retry-button'))

    await waitFor(() => expect(screen.getByTestId('main-app')).toBeInTheDocument())
  })

  test('uses friendly local runtime status errors', async () => {
    ensureMock.mockResolvedValue({ running: false, ready: false, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('local-runtime-error')).toHaveTextContent(
      '本机工作台服务还没有启动'
    )
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
