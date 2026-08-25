import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  closeLocalTerminal,
  connectLocalTerminal,
  getLocalExecutorDeviceId,
  getLocalPathKind,
  isLocalHarnessAvailable,
  isLocalTerminalAvailable,
  listLocalWorkspaceOpeners,
  localPathExists,
  openLocalFile,
  openLocalWorkspace,
  pickLocalWorkspaceOpenerExe,
  resizeLocalTerminal,
  startLocalTerminal,
  writeLocalTerminal,
} from './local-terminal'

const mocks = vi.hoisted(() => ({
  desktop: true,
  desktopHost: vi.fn(),
  executorStatus: vi.fn(),
  localExecutor: vi.fn(),
  terminalRequest: vi.fn(),
  terminalSubscribe: vi.fn(),
}))

vi.mock('./runtime-environment', () => ({
  isDesktopRuntime: () => mocks.desktop,
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.desktopHost,
}))

vi.mock('@/api/dsh/terminalTransport', () => ({
  requestDshTerminal: mocks.terminalRequest,
  subscribeDshTerminalEvents: mocks.terminalSubscribe,
}))

vi.mock('@/desktop/localExecutor', () => ({
  getLocalExecutorStatus: mocks.executorStatus,
  requestLocalExecutor: mocks.localExecutor,
}))

function setNavigatorValue<K extends keyof Navigator>(key: K, value: Navigator[K]) {
  Object.defineProperty(navigator, key, {
    configurable: true,
    value,
  })
}

describe('Electron local terminal', () => {
  beforeEach(() => {
    mocks.desktop = true
    mocks.desktopHost.mockReset()
    mocks.executorStatus.mockReset()
    mocks.localExecutor.mockReset()
    mocks.terminalRequest.mockReset()
    mocks.terminalSubscribe.mockReset()
    mocks.terminalSubscribe.mockReturnValue(vi.fn())
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
  })

  test('exposes terminal and harness features only in the Electron desktop runtime', () => {
    expect(isLocalTerminalAvailable()).toBe(true)
    expect(isLocalHarnessAvailable()).toBe(true)

    mocks.desktop = false

    expect(isLocalTerminalAvailable()).toBe(false)
    expect(isLocalHarnessAvailable()).toBe(false)
  })

  test('reads executor and filesystem state through Electron services', async () => {
    mocks.executorStatus.mockResolvedValue({ deviceId: ' local-device-1 ' })
    mocks.desktopHost
      .mockResolvedValueOnce({ isDirectory: false, isFile: true })
      .mockResolvedValueOnce({ isDirectory: true, isFile: false })

    await expect(getLocalExecutorDeviceId()).resolves.toBe('local-device-1')
    await expect(localPathExists(' /Users/me/project ')).resolves.toBe(true)
    await expect(getLocalPathKind(' /Users/me/project ')).resolves.toBe('directory')

    expect(mocks.desktopHost).toHaveBeenNthCalledWith(1, 'filesystem.stat', {
      path: '/Users/me/project',
    })
    expect(mocks.desktopHost).toHaveBeenNthCalledWith(2, 'filesystem.stat', {
      path: '/Users/me/project',
    })
  })

  test('starts and controls a terminal through the DSH terminal transport', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001')
    mocks.terminalRequest.mockResolvedValue(undefined)

    await expect(
      startLocalTerminal({
        cwd: ' /Users/me/project ',
        rows: 30,
        cols: 100,
        env: {
          WEWORK_PARENT_TITLE: 'Task A',
          ' BAD=KEY ': 'ignored',
          EMPTY_VALUE: null,
        },
      })
    ).resolves.toBe('00000000-0000-4000-8000-000000000001')
    await writeLocalTerminal('terminal-1', 'pwd\r')
    await resizeLocalTerminal('terminal-1', 40, 120)
    await closeLocalTerminal('terminal-1')

    expect(mocks.terminalRequest.mock.calls).toEqual([
      [
        'terminal.start',
        {
          session_id: '00000000-0000-4000-8000-000000000001',
          cwd: '/Users/me/project',
          rows: 30,
          cols: 100,
          env: { WEWORK_PARENT_TITLE: 'Task A' },
        },
      ],
      ['terminal.input', { session_id: 'terminal-1', data: 'pwd\r' }],
      ['terminal.resize', { session_id: 'terminal-1', rows: 40, cols: 120 }],
      ['terminal.close', { session_id: 'terminal-1' }],
    ])
  })

  test('opens local paths through Electron host capabilities', async () => {
    mocks.desktopHost
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        { id: 'vscode', category: 'general', available: true, label: 'VS Code' },
        { id: 'file-manager', category: 'fileManager', available: true },
      ])
      .mockResolvedValueOnce('C:\\Tools\\Helix\\hx.exe')

    await openLocalWorkspace({ opener: 'vscode', path: ' /Users/me/project ' })
    await openLocalFile(' /Users/me/project/readme.md ')
    await expect(listLocalWorkspaceOpeners()).resolves.toEqual([
      { id: 'vscode', category: 'general', available: true, label: 'VS Code' },
      { id: 'file-manager', category: 'fileManager', available: true },
    ])
    await expect(pickLocalWorkspaceOpenerExe()).resolves.toBe('C:\\Tools\\Helix\\hx.exe')

    expect(mocks.desktopHost.mock.calls).toEqual([
      ['workspace.open', { opener: 'vscode', path: '/Users/me/project' }],
      ['shell.openPath', { path: '/Users/me/project/readme.md' }],
      ['workspace.listOpeners'],
      ['workspace.pickOpener'],
    ])
  })

  test('replays snapshots before buffered live output and filters other sessions', async () => {
    const listeners: Array<(event: { event: string; payload: Record<string, unknown> }) => void> =
      []
    const unlisteners = [vi.fn(), vi.fn()]
    mocks.terminalSubscribe.mockImplementation(listener => {
      listeners.push(listener)
      return unlisteners[listeners.length - 1]
    })
    mocks.terminalRequest.mockImplementation(async method => {
      if (method !== 'terminal.snapshot') return undefined
      listeners[0]?.({
        event: 'terminal.output',
        payload: { session_id: 'terminal-1', sequence: 3, data: 'live' },
      })
      listeners[1]?.({
        event: 'terminal.exit',
        payload: { session_id: 'terminal-2' },
      })
      return { session_id: 'terminal-1', sequence: 2, data: 'history' }
    })
    const output = vi.fn()
    const exit = vi.fn()

    const disconnect = await connectLocalTerminal('terminal-1', output, exit)
    listeners[1]?.({
      event: 'terminal.exit',
      payload: { session_id: 'terminal-1' },
    })

    expect(output.mock.calls.map(([payload, source]) => [payload.data, source])).toEqual([
      ['history', 'snapshot'],
      ['live', 'live'],
    ])
    expect(exit).toHaveBeenCalledOnce()

    disconnect()
    expect(unlisteners[0]).toHaveBeenCalledOnce()
    expect(unlisteners[1]).toHaveBeenCalledOnce()
  })
})
