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

function createDeferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
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

  test('shares overlapping opener discovery without retaining completed results', async () => {
    const initial = [{ id: 'vscode', category: 'general', available: true }]
    const refreshed = [{ id: 'cursor', category: 'general', available: true }]
    const discovery = createDeferred<typeof initial>()
    mocks.desktopHost.mockReturnValueOnce(discovery.promise).mockResolvedValueOnce(refreshed)

    const requests = Array.from({ length: 3 }, () => listLocalWorkspaceOpeners())
    expect(mocks.desktopHost).toHaveBeenCalledTimes(1)
    expect(mocks.desktopHost).toHaveBeenCalledWith('workspace.listOpeners')
    discovery.resolve(initial)
    expect(await Promise.all(requests)).toEqual([initial, initial, initial])

    await expect(listLocalWorkspaceOpeners()).resolves.toEqual(refreshed)
    expect(mocks.desktopHost).toHaveBeenCalledTimes(2)
  })

  test('releases failed discovery and preserves the original error for every caller', async () => {
    const discovery = createDeferred<never>()
    const failure = new Error('Opener discovery failed')
    mocks.desktopHost.mockReturnValueOnce(discovery.promise).mockResolvedValueOnce([])
    const results = Promise.allSettled([listLocalWorkspaceOpeners(), listLocalWorkspaceOpeners()])
    discovery.reject(failure)

    expect(await results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    await expect(listLocalWorkspaceOpeners()).resolves.toEqual([])
    expect(mocks.desktopHost).toHaveBeenCalledTimes(2)
  })

  test('keeps desktop discovery unavailable outside the desktop runtime', async () => {
    const discovery = createDeferred<[]>()
    mocks.desktopHost.mockReturnValueOnce(discovery.promise)
    const request = listLocalWorkspaceOpeners()
    mocks.desktop = false

    await expect(listLocalWorkspaceOpeners()).resolves.toEqual([])
    expect(mocks.desktopHost).toHaveBeenCalledTimes(1)
    discovery.resolve([])
    await request
  })

  test('refreshes a changed custom opener without an old request clearing the new one', async () => {
    const original = [{ id: 'vscode', category: 'general', available: true }]
    const updated = [{ id: 'custom', category: 'winOnly', available: true }]
    const first = createDeferred<typeof original>()
    const second = createDeferred<typeof updated>()
    let discoveries = 0
    mocks.desktopHost.mockImplementation(capability => {
      if (capability === 'workspace.pickOpener') return Promise.resolve('D:\\Tools\\editor.exe')
      discoveries += 1
      return discoveries === 1 ? first.promise : second.promise
    })
    const oldRequest = listLocalWorkspaceOpeners()
    await pickLocalWorkspaceOpenerExe()
    const newRequest = listLocalWorkspaceOpeners()
    expect(discoveries).toBe(2)

    first.resolve(original)
    await expect(oldRequest).resolves.toEqual(original)
    const overlappingNewRequest = listLocalWorkspaceOpeners()
    expect(discoveries).toBe(2)
    second.resolve(updated)
    expect(await Promise.all([newRequest, overlappingNewRequest])).toEqual([updated, updated])
  })

  test('keeps shared discovery when the custom opener picker is cancelled', async () => {
    const discovery = createDeferred<[]>()
    mocks.desktopHost.mockImplementation(capability =>
      capability === 'workspace.pickOpener' ? Promise.resolve(null) : discovery.promise
    )
    const first = listLocalWorkspaceOpeners()
    await expect(pickLocalWorkspaceOpenerExe()).resolves.toBeNull()
    const second = listLocalWorkspaceOpeners()
    expect(mocks.desktopHost.mock.calls).toEqual([
      ['workspace.listOpeners'],
      ['workspace.pickOpener'],
    ])
    discovery.resolve([])
    await Promise.all([first, second])
  })

  test('opens attachments with the workspace choice and uses the global choice for a new workspace', async () => {
    const available = ['vscode', 'cursor', 'file-manager'].map(id => ({ id, available: true }))
    mocks.desktopHost.mockImplementation(async capability =>
      capability === 'workspace.listOpeners' ? available : undefined
    )
    setPreferredWorkspaceOpener('/project-a', 'cursor')
    setPreferredWorkspaceOpener('/project-b', 'file-manager')

    await openLocalFileInWorkspaceApp(' /draft/test.md ', '/project-a')
    expect(mocks.desktopHost).toHaveBeenLastCalledWith('workspace.openFile', {
      opener: 'cursor',
      path: '/draft/test.md',
    })
    await openLocalFileInWorkspaceApp('/draft/test.md', '/project-b')
    expect(mocks.desktopHost).toHaveBeenLastCalledWith('workspace.openFile', {
      opener: 'file-manager',
      path: '/draft/test.md',
    })
    await openLocalFileInWorkspaceApp('/draft/test.md', '/project-c')
    expect(mocks.desktopHost).toHaveBeenLastCalledWith('workspace.openFile', {
      opener: 'file-manager',
      path: '/draft/test.md',
    })
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
