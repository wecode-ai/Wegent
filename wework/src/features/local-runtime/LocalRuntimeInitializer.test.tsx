import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import {
  copyLocalExecutorDebugInfo,
  ensureLocalExecutorStarted,
  readLocalExecutorLog,
} from '@/tauri/localExecutor'
import { LocalRuntimeInitializer } from './LocalRuntimeInitializer'

const startDragging = vi.fn().mockResolvedValue(undefined)

vi.mock('@/tauri/localExecutor', () => ({
  copyLocalExecutorDebugInfo: vi.fn(),
  ensureLocalExecutorStarted: vi.fn(),
  readLocalExecutorLog: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ startDragging }),
}))

const copyDebugMock = vi.mocked(copyLocalExecutorDebugInfo)
const ensureMock = vi.mocked(ensureLocalExecutorStarted)
const readLogMock = vi.mocked(readLocalExecutorLog)
const DEV_STARTUP_HOLD_MS = 4800
const SLOW_STARTUP_WARNING_MS = 10000

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
}

function MountProbe({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount()
  }, [onMount])

  return <div data-testid="main-app">Main app</div>
}

describe('LocalRuntimeInitializer', () => {
  beforeEach(() => {
    enableTauri()
    vi.stubEnv('DEV', false)
    copyDebugMock.mockReset()
    ensureMock.mockReset()
    readLogMock.mockReset()
    startDragging.mockClear()
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
    expect(screen.queryByText(/执行器|daemon/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('main-app')).not.toBeInTheDocument()

    expect(await screen.findByTestId('main-app')).toBeInTheDocument()
    expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
  })

  test('mounts children behind the startup screen until app startup is ready', async () => {
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer startupReady={false}>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('main-app')).not.toBeVisible()
    expect(screen.getByTestId('local-runtime-initializer')).toBeInTheDocument()
  })

  test('shows slow startup help and copies diagnostic details with executor log', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-28T10:30:00Z'))
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })
    readLogMock.mockResolvedValue({
      path: '~/.wegent-executor/logs/executor.log',
      content: 'executor waiting for socket via Tauri runtime detail',
      truncated: true,
      lineCount: 20,
      socketPath: '~/.wegent-executor/app-ipc.sock',
      socketExists: true,
      socketFileType: 'socket',
      socketConnected: false,
      processPids: [1234],
      processPaths: ['/Applications/Wework.app/Contents/MacOS/wegent-executor'],
      sidecarSource: 'configured',
      sidecarPath: '/Applications/Wework.app/Contents/MacOS/wegent-executor',
      currentDir: '/Applications/Wework.app/Contents/MacOS',
      executorHome: '~/.wegent-executor',
      backendUrl: 'https://cloud.example.com',
      hasBackendAuthToken: true,
      pendingRequestCount: 1,
      status: {
        running: true,
        ready: true,
        deviceId: 'local-device',
        version: '1.9.0',
      },
    })
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 Tauri/2.0',
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <LocalRuntimeInitializer startupReady={false}>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    expect(screen.queryByTestId('local-runtime-slow-startup-help')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_STARTUP_WARNING_MS)
    })

    const slowStartupHelp = screen.getByTestId('local-runtime-slow-startup-help')
    expect(slowStartupHelp).toHaveTextContent('启动时间有点久')
    expect(slowStartupHelp.className).toContain('sm:flex-row')
    expect(slowStartupHelp.className).toContain('bg-amber-50/70')
    expect(
      within(slowStartupHelp).getByTestId('local-runtime-slow-startup-icon').className
    ).toContain('bg-amber-100')
    expect(screen.getByTestId('local-runtime-copy-debug-button').className).toContain('sm:w-auto')

    await act(async () => {
      fireEvent.click(screen.getByTestId('local-runtime-copy-debug-button'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(readLogMock).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Startup phase: ready'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Startup check: resolved'))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Socket path: ~/.wegent-executor/app-ipc.sock')
    )
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Socket exists: true'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Socket type: socket'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Socket connected: false'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Executor PID(s): 1234'))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        'Executor process path(s): /Applications/Wework.app/Contents/MacOS/wegent-executor'
      )
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Executor launch source: configured')
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        'Executor launch path: /Applications/Wework.app/Contents/MacOS/wegent-executor'
      )
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Current working directory: /Applications/Wework.app/Contents/MacOS')
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Executor home: ~/.wegent-executor')
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Backend URL: https://cloud.example.com')
    )
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Backend auth token configured: true')
    )
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Pending request count: 1'))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        'Local executor status: running=true ready=true deviceId=local-device version=1.9.0 error=none'
      )
    )
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Executor log lines: last 20'))
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('executor waiting for socket'))
    expect(writeText).toHaveBeenCalledWith(expect.not.stringMatching(/tauri/i))
    expect(screen.getByTestId('local-runtime-copy-debug-button')).toHaveTextContent('已复制')
  })

  test('copies debug details through native app fallback when Web Clipboard is unavailable', async () => {
    vi.useFakeTimers()
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })
    readLogMock.mockResolvedValue({
      path: '~/.wegent-executor/logs/executor.log',
      content: 'executor native clipboard path',
      truncated: false,
      lineCount: 1,
      socketPath: '~/.wegent-executor/app-ipc.sock',
      socketExists: false,
      socketFileType: 'missing',
      socketConnected: false,
      processPids: [],
      processPaths: [],
      sidecarSource: 'bundled',
      sidecarPath: 'binaries/wegent-executor',
      currentDir: '/tmp/wework',
      executorHome: '~/.wegent-executor',
      backendUrl: null,
      hasBackendAuthToken: false,
      pendingRequestCount: 0,
      status: {
        running: false,
        ready: false,
        error: 'connect timed out',
      },
    })
    copyDebugMock.mockResolvedValue(undefined)
    delete (navigator as unknown as { clipboard?: Clipboard }).clipboard

    render(
      <LocalRuntimeInitializer startupReady={false}>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_STARTUP_WARNING_MS)
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('local-runtime-copy-debug-button'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(copyDebugMock).toHaveBeenCalledWith(
      expect.stringContaining('executor native clipboard path')
    )
    expect(screen.getByTestId('local-runtime-copy-debug-button')).toHaveTextContent('已复制')
  })

  test('keeps the startup screen titlebar draggable', async () => {
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })

    render(
      <LocalRuntimeInitializer startupReady={false}>
        <div data-testid="main-app">Main app</div>
      </LocalRuntimeInitializer>
    )

    const dragRegion = within(screen.getByTestId('local-runtime-titlebar-drag-region')).getByTestId(
      'macos-titlebar-drag-region'
    )
    expect(dragRegion).toHaveAttribute('data-tauri-drag-region')

    fireEvent.mouseDown(dragRegion, { button: 0 })

    await waitFor(() => expect(startDragging).toHaveBeenCalledTimes(1))
  })

  test('does not remount children when the startup screen is dismissed', async () => {
    ensureMock.mockResolvedValue({ running: true, ready: true, deviceId: 'local-device' })
    const onMount = vi.fn()

    const { rerender } = render(
      <LocalRuntimeInitializer startupReady={false}>
        <MountProbe onMount={onMount} />
      </LocalRuntimeInitializer>
    )

    expect(await screen.findByTestId('main-app')).not.toBeVisible()
    await waitFor(() => expect(onMount).toHaveBeenCalledTimes(1))

    rerender(
      <LocalRuntimeInitializer startupReady>
        <MountProbe onMount={onMount} />
      </LocalRuntimeInitializer>
    )

    await waitFor(() =>
      expect(screen.queryByTestId('local-runtime-initializer')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('main-app')).toBeVisible()
    expect(onMount).toHaveBeenCalledTimes(1)
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
    expect(screen.getByTestId('main-app')).not.toBeVisible()

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
