import { fireEvent, render, screen } from '@testing-library/react'
import type { ProcessSnapshot } from '@wegent/process-explorer'
import { beforeEach, describe, expect, test, vi } from 'vitest'
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
    expect(mocks.invoke).toHaveBeenCalledWith('diagnostics.processSnapshot', {
      waitForSystemProcesses: false,
    })
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
})
