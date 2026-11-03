import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  closeLocalTerminal,
  connectLocalTerminal,
  getLocalExecutorDeviceId,
  getLocalPathKind,
  listLocalWorkspaceOpeners,
  localPathExists,
  openLocalFile,
  openLocalFileInWorkspaceApp,
  openLocalWorkspace,
  pickLocalWorkspaceOpenerExe,
  resizeLocalTerminal,
  startLocalHarness,
  startLocalTerminal,
  writeLocalTerminal,
} from './local-terminal'
import { setPreferredWorkspaceOpener } from './workspace-opener-preferences'

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

  test('passes a new Kimi prompt as a launch argument without PTY input injection', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000002')
    mocks.localExecutor.mockResolvedValue({
      args: ['--model', '__kimi_env_model__', '--prompt', 'Inspect the project with Kimi'],
      env: { KIMI_CONFIG_DIR: '/tmp/kimi' },
    })
    mocks.terminalRequest.mockResolvedValue(undefined)

    await startLocalHarness({
      harnessId: 'kimi_code',
      prompt: 'Inspect the project with Kimi',
      isPrimary: false,
      projectId: 7,
      executablePath: '/usr/local/bin/kimi',
      args: ['--model', '__kimi_env_model__'],
      pluginRoots: [],
      cwd: '/Users/me/project',
      modelKey: 'wework:model',
      resumeSessionId: null,
    })

    expect(mocks.localExecutor).toHaveBeenCalledWith('executor.harnesses.prepare_launch', {
      harness_id: 'kimi_code',
      session_id: expect.stringContaining('local-harness-'),
      cwd: '/Users/me/project',
      args: ['--model', '__kimi_env_model__', '--prompt', 'Inspect the project with Kimi'],
      uses_wework_model: false,
      accept_bypass_permissions: false,
    })
    expect(mocks.terminalRequest).toHaveBeenCalledWith('terminal.start', {
      session_id: expect.stringContaining('local-harness-'),
      executable: '/usr/local/bin/kimi',
      args: ['--model', '__kimi_env_model__', '--prompt', 'Inspect the project with Kimi'],
      cwd: '/Users/me/project',
      rows: undefined,
      cols: undefined,
      env: { KIMI_CONFIG_DIR: '/tmp/kimi' },
    })
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

  test('shares discovery failure and permits a fresh request afterward', async () => {
    let fail!: (reason: Error) => void
    mocks.desktopHost.mockReturnValue(new Promise((_, reject) => (fail = reject)))
    const pending = Array.from({ length: 3 }, () => listLocalWorkspaceOpeners())
    const settled = Promise.allSettled(pending)
    fail(new Error('discovery failed'))
    expect(await settled).toEqual(
      Array.from({ length: 3 }, () => ({
        status: 'rejected',
        reason: new Error('discovery failed'),
      }))
    )
    expect(mocks.desktopHost).toHaveBeenCalledTimes(1)

    mocks.desktopHost.mockResolvedValue([])
    await expect(listLocalWorkspaceOpeners()).resolves.toEqual([])
    expect(mocks.desktopHost).toHaveBeenCalledTimes(2)
  })

  test('a saved opener invalidates old discovery without clearing a newer pending request', async () => {
    const oldResult = [{ id: 'vscode', category: 'general', available: true }]
    const freshResult = [{ id: 'custom', category: 'winOnly', available: true }]
    let finishOld!: (value: typeof oldResult) => void
    let finishFresh!: (value: typeof freshResult) => void
    mocks.desktopHost
      .mockReturnValueOnce(new Promise(resolve => (finishOld = resolve)))
      .mockResolvedValueOnce('C:\\Tools\\editor.exe')
      .mockReturnValue(new Promise(resolve => (finishFresh = resolve)))
    const old = listLocalWorkspaceOpeners()
    await expect(pickLocalWorkspaceOpenerExe()).resolves.toBe('C:\\Tools\\editor.exe')
    const fresh = listLocalWorkspaceOpeners()
    finishOld(oldResult)
    await expect(old).resolves.toEqual(oldResult)
    const joined = listLocalWorkspaceOpeners()
    try {
      expect(mocks.desktopHost.mock.calls).toEqual([
        ['workspace.listOpeners'],
        ['workspace.pickOpener'],
        ['workspace.listOpeners'],
      ])
    } finally {
      finishFresh(freshResult)
      await Promise.all([fresh, joined])
    }
    expect(await joined).toEqual(freshResult)
  })

  test.each(['cancelled', 'failed'])('a %s picker retains pending discovery', async outcome => {
    let complete!: (value: []) => void
    mocks.desktopHost.mockReturnValueOnce(new Promise(resolve => (complete = resolve)))
    if (outcome === 'cancelled') mocks.desktopHost.mockResolvedValue(null)
    else mocks.desktopHost.mockRejectedValue(new Error('picker failed'))
    const pending = listLocalWorkspaceOpeners()
    if (outcome === 'cancelled') await expect(pickLocalWorkspaceOpenerExe()).resolves.toBeNull()
    else await expect(pickLocalWorkspaceOpenerExe()).rejects.toThrow('picker failed')
    const joined = listLocalWorkspaceOpeners()
    try {
      expect(mocks.desktopHost.mock.calls).toEqual([
        ['workspace.listOpeners'],
        ['workspace.pickOpener'],
      ])
    } finally {
      complete([])
      await Promise.allSettled([pending, joined])
    }
    await expect(joined).resolves.toEqual([])
  })

  test('rejects empty attachment paths before contacting the desktop host', async () => {
    await expect(openLocalFileInWorkspaceApp('   ')).rejects.toThrow('Local file path is empty')
    expect(mocks.desktopHost).not.toHaveBeenCalled()
  })

  test('rejects attachment opening outside the desktop runtime', async () => {
    mocks.desktop = false
    await expect(openLocalFileInWorkspaceApp('/draft/test.md')).rejects.toThrow()
    expect(mocks.desktopHost).not.toHaveBeenCalled()
  })

  test('uses the first available opener when a saved app is uninstalled and propagates launch failures', async () => {
    setPreferredWorkspaceOpener('/project-a', 'cursor')
    mocks.desktopHost
      .mockResolvedValueOnce([
        { id: 'vscode', available: true },
        { id: 'cursor', available: false },
      ])
      .mockRejectedValueOnce(new Error('test launch failure'))
    await expect(openLocalFileInWorkspaceApp('/draft/test.md', '/project-a')).rejects.toThrow(
      'test launch failure'
    )
    expect(mocks.desktopHost).toHaveBeenLastCalledWith('workspace.openFile', {
      opener: 'vscode',
      path: '/draft/test.md',
    })
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
      return { session_id: 'terminal-1', sequence: 2, data: 'history', running: true }
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
  test('replays completed terminal output and reports exit when reconnecting', async () => {
    mocks.terminalRequest.mockResolvedValue({
      session_id: 'terminal-completed',
      sequence: 1,
      data: 'completed output',
      running: false,
    })
    const output = vi.fn()
    const exit = vi.fn()

    const disconnect = await connectLocalTerminal('terminal-completed', output, exit)

    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ data: 'completed output' }),
      'snapshot'
    )
    expect(exit).toHaveBeenCalledWith({ session_id: 'terminal-completed' })
    expect(output.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0])
    disconnect()
  })
})
