import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ProcessSnapshot } from '@wegent/process-explorer'
import { ProcessExplorerPage } from './ProcessExplorerPage'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: mocks.invoke }))
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function snapshot(): ProcessSnapshot {
  return {
    capturedAt: 1,
    platform: 'darwin',
    applicationPid: 100,
    degraded: [],
    processes: [
      {
        id: '100:1',
        pid: 100,
        parentPid: 1,
        kind: 'application',
        source: 'electron',
        owner: { id: 'application', label: 'Application', key: 'application' },
        name: 'Wework',
        detail: '/Applications/Wework.app/Contents/MacOS/Wework',
        cpuPercent: 1.2,
        memoryBytes: 2048 * 1024,
        idleWakeupsPerSecond: null,
        startedAt: 1_000,
      },
      {
        id: '200:2',
        pid: 200,
        parentPid: 100,
        kind: 'gpu',
        source: 'electron',
        owner: { id: 'helpers', label: 'Chromium helpers', key: 'helpers' },
        name: 'GPU Process',
        detail: 'Electron Helper --type=gpu-process',
        cpuPercent: 5.5,
        memoryBytes: 1024 * 1024,
        idleWakeupsPerSecond: null,
        startedAt: 1_000,
      },
      {
        id: '300:3',
        pid: 300,
        parentPid: 100,
        kind: 'window',
        source: 'electron',
        owner: { id: 'windows', label: 'Windows', key: 'windows' },
        name: 'Task — Refactor',
        detail: 'Electron Helper --type=renderer',
        cpuPercent: 0.4,
        memoryBytes: 512 * 1024,
        idleWakeupsPerSecond: null,
        startedAt: 1_000,
      },
    ],
  }
}

function mockHost() {
  mocks.invoke.mockImplementation((capability: string, params?: { alwaysOnTop?: boolean }) => {
    if (capability === 'clipboard.writeText') return Promise.resolve()
    if (capability === 'processExplorer.setAlwaysOnTop') {
      return Promise.resolve({ alwaysOnTop: Boolean(params?.alwaysOnTop) })
    }
    return Promise.resolve(snapshot())
  })
}

describe('ProcessExplorerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHost()
  })

  test('renders owner groups and rows', async () => {
    render(<ProcessExplorerPage />)

    expect(await screen.findByTestId('process-explorer-row-200')).toBeTruthy()
    expect(screen.getByTestId('process-explorer-row-100')).toBeTruthy()
    expect(screen.getByTestId('process-explorer-row-300')).toBeTruthy()
    expect(screen.getByTestId('process-explorer-group-application')).toBeTruthy()
    expect(screen.getByTestId('process-explorer-group-windows')).toBeTruthy()
    expect(screen.getByTestId('process-explorer-group-helpers')).toBeTruthy()
    expect(screen.getByText('Application')).toBeTruthy()
    expect(screen.getByTestId('process-explorer-resize-0')).toBeTruthy()
    expect(screen.getByTestId('process-explorer-resize-3')).toBeTruthy()
    expect(screen.queryByTestId('process-explorer-resize-4')).toBeNull()
    expect(mocks.invoke).toHaveBeenCalledWith('diagnostics.processSnapshot')
  })

  test('never exposes termination actions', async () => {
    render(<ProcessExplorerPage />)

    for (const pid of [100, 200, 300]) {
      const row = await screen.findByTestId(`process-explorer-row-${pid}`)
      row.click()
      expect(screen.queryByTestId(/process-explorer-(end|confirm|cancel)-/)).toBeNull()
    }
  })

  test('toggles always on top', async () => {
    render(<ProcessExplorerPage />)

    const pin = await screen.findByTestId('process-explorer-always-on-top')
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    pin.click()
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('processExplorer.setAlwaysOnTop', {
        alwaysOnTop: true,
      })
    )
    await waitFor(() =>
      expect(
        screen.getByTestId('process-explorer-always-on-top').getAttribute('aria-pressed')
      ).toBe('true')
    )
  })

  test('selects a row from the keyboard', async () => {
    render(<ProcessExplorerPage />)

    const row = await screen.findByTestId('process-explorer-row-200')
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(screen.getByTestId('process-explorer-selection').textContent).toContain('GPU Process')
    expect(screen.getByTestId('process-explorer-selection-detail').textContent).toContain(
      'Electron Helper --type=gpu-process'
    )
  })

  test('copies only the selected launch detail', async () => {
    render(<ProcessExplorerPage />)
    const row = await screen.findByTestId('process-explorer-row-200')
    row.click()
    const copyButton = await screen.findByTestId('process-explorer-copy-launch-details')
    copyButton.click()
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('clipboard.writeText', {
        text: 'Electron Helper --type=gpu-process',
      })
    )
  })

  test('filters rows and keeps the owner context', async () => {
    render(<ProcessExplorerPage />)
    await screen.findByTestId('process-explorer-row-200')

    const filter = screen.getByTestId('process-explorer-filter')
    fireEvent.change(filter, { target: { value: 'GPU' } })

    await waitFor(() => {
      expect(screen.queryByTestId('process-explorer-row-300')).toBeNull()
    })
    expect(screen.getByTestId('process-explorer-row-200')).toBeTruthy()
    expect(screen.getByTestId('process-explorer-group-helpers')).toBeTruthy()
  })

  test('matches a numeric filter to the exact PID instead of launch arguments', async () => {
    const processes = snapshot()
    processes.processes[1].detail += ' --shared-files=100,1100'
    processes.processes[2].pid = 1100
    mocks.invoke.mockResolvedValue(processes)
    render(<ProcessExplorerPage />)
    await screen.findByTestId('process-explorer-row-200')

    fireEvent.change(screen.getByTestId('process-explorer-filter'), {
      target: { value: '100' },
    })

    expect(screen.getByTestId('process-explorer-row-100')).toBeInTheDocument()
    expect(screen.queryByTestId('process-explorer-row-200')).not.toBeInTheDocument()
    expect(screen.queryByTestId('process-explorer-row-1100')).not.toBeInTheDocument()
  })

  test('surfaces a snapshot failure', async () => {
    mocks.invoke.mockImplementation(() =>
      Promise.reject(new Error('Process snapshot is unavailable'))
    )
    render(<ProcessExplorerPage />)
    expect(await screen.findByTestId('process-explorer-error')).toBeTruthy()
  })

  test('surfaces degraded collection details', async () => {
    mocks.invoke.mockImplementation(() =>
      Promise.resolve({
        ...snapshot(),
        degraded: [{ code: 'system-process-table-failed', detail: 'ps failed' }],
      })
    )
    render(<ProcessExplorerPage />)

    const banner = await screen.findByTestId('process-explorer-degraded')
    expect(banner.textContent).toContain('process_explorer.degraded')
    expect(banner.getAttribute('title')).toBe('ps failed')
  })
})
