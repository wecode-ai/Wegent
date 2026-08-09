import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import i18n from '@/i18n'
import {
  closeLocalTerminal,
  connectLocalTerminal,
  getLocalExecutorDeviceId,
  isLocalHarnessAvailable,
  isLocalTerminalAvailable,
  listenLocalTerminalExit,
  listenLocalTerminalOutput,
  getLocalPathKind,
  localPathExists,
  openLocalFile,
  openLocalWorkspace,
  resizeLocalTerminal,
  startLocalTerminal,
  writeLocalTerminal,
} from './local-terminal'

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)
const listenMock = vi.mocked(listen)

function setNavigatorValue<K extends keyof Navigator>(key: K, value: Navigator[K]) {
  Object.defineProperty(navigator, key, {
    configurable: true,
    value,
  })
}

describe('local-terminal', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  test('is available inside the WeWork macOS Tauri app', () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    expect(isLocalTerminalAvailable()).toBe(true)
  })

  test('is available inside the WeWork Windows Tauri app', () => {
    setNavigatorValue('userAgent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    setNavigatorValue('platform', 'Win32')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    expect(isLocalTerminalAvailable()).toBe(true)
  })

  test('keeps the local terminal unavailable inside the Linux Tauri desktop E2E app', () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    setNavigatorValue('userAgent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    setNavigatorValue('platform', 'Linux x86_64')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    expect(isLocalTerminalAvailable()).toBe(false)
  })

  test('makes local harnesses available inside the Linux Tauri desktop E2E app', () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    setNavigatorValue('userAgent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    setNavigatorValue('platform', 'Linux x86_64')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    expect(isLocalHarnessAvailable()).toBe(true)
  })

  test('is unavailable for regular browsers even on macOS', () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)

    expect(isLocalTerminalAvailable()).toBe(false)
  })

  test('is unavailable inside the iOS Tauri app', () => {
    setNavigatorValue('userAgent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
    setNavigatorValue('platform', 'iPhone')
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    expect(isLocalTerminalAvailable()).toBe(false)
  })

  test('reads the local executor device id from the native app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    invokeMock.mockResolvedValue(' local-device-1 ')

    await expect(getLocalExecutorDeviceId(' http://localhost:8000/api ')).resolves.toBe(
      'local-device-1'
    )
    expect(invokeMock).toHaveBeenCalledWith('get_local_executor_device_id', {
      expectedBackendUrl: 'http://localhost:8000/api',
    })
  })

  test('does not read the local executor device id in regular browsers', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)

    await expect(getLocalExecutorDeviceId()).resolves.toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('checks local project path existence through the native app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    invokeMock.mockResolvedValue(true)

    await expect(localPathExists(' /Users/me/project ')).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('local_path_exists', {
      path: '/Users/me/project',
    })
  })

  test('does not check local project paths in regular browsers', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)

    await expect(localPathExists('/Users/me/project')).resolves.toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('reads local path kinds through the native app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    invokeMock.mockResolvedValue('directory')

    await expect(getLocalPathKind(' /Users/me/tmp ')).resolves.toBe('directory')
    expect(invokeMock).toHaveBeenCalledWith('get_local_path_kind', {
      path: '/Users/me/tmp',
    })
  })

  test('starts an embedded local terminal session through the native app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    invokeMock.mockResolvedValue('local-terminal-1')

    await expect(
      startLocalTerminal({ cwd: ' /Users/me/project ', rows: 30, cols: 100 })
    ).resolves.toBe('local-terminal-1')
    expect(invokeMock).toHaveBeenCalledWith('start_local_terminal', {
      cwd: '/Users/me/project',
      rows: 30,
      cols: 100,
    })
  })

  test('passes sanitized context env when starting an embedded local terminal', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    invokeMock.mockResolvedValue('local-terminal-1')

    await expect(
      startLocalTerminal({
        cwd: '/Users/me/project',
        env: {
          WEWORK_PARENT_TITLE: 'Task A',
          ' BAD=KEY ': 'ignored',
          EMPTY_VALUE: null,
        },
      })
    ).resolves.toBe('local-terminal-1')
    expect(invokeMock).toHaveBeenCalledWith('start_local_terminal', {
      cwd: '/Users/me/project',
      rows: undefined,
      cols: undefined,
      env: {
        WEWORK_PARENT_TITLE: 'Task A',
      },
    })
  })

  test('rejects starting a local terminal outside the Tauri desktop app', async () => {
    setNavigatorValue('userAgent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    setNavigatorValue('platform', 'Win32')
    setNavigatorValue('maxTouchPoints', 0)

    await expect(startLocalTerminal({ cwd: '/Users/me/project' })).rejects.toThrow(
      i18n.t('localRuntime:local_terminal_unavailable')
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('rejects starting a local terminal inside the iOS-like Tauri app', async () => {
    setNavigatorValue('userAgent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
    setNavigatorValue('platform', 'iPhone')
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    await expect(startLocalTerminal({ cwd: '/Users/me/project' })).rejects.toThrow(
      i18n.t('localRuntime:local_terminal_unavailable')
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('opens a local workspace through the selected native app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    invokeMock.mockResolvedValue(undefined)

    await openLocalWorkspace({ opener: 'vscode', path: ' /Users/me/project ' })

    expect(invokeMock).toHaveBeenCalledWith('open_local_workspace', {
      opener: 'vscode',
      path: '/Users/me/project',
    })
  })

  test('opens a local file with the native default app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    invokeMock.mockResolvedValue(undefined)

    await openLocalFile(' /Users/me/project/.wegent/attachments/draft/1/paste.txt ')

    expect(invokeMock).toHaveBeenCalledWith('open_local_file', {
      path: '/Users/me/project/.wegent/attachments/draft/1/paste.txt',
    })
  })

  test('does not open a local workspace outside the macOS Tauri app', async () => {
    setNavigatorValue(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15'
    )
    setNavigatorValue('platform', 'MacIntel')
    setNavigatorValue('maxTouchPoints', 0)

    await expect(
      openLocalWorkspace({ opener: 'vscode', path: '/Users/me/project' })
    ).rejects.toThrow(i18n.t('localRuntime:local_workspace_opening_unavailable'))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('writes, resizes, and closes embedded local terminal sessions', async () => {
    invokeMock.mockResolvedValue(undefined)

    await writeLocalTerminal('local-terminal-1', 'pwd\r')
    await resizeLocalTerminal('local-terminal-1', 40, 120)
    await closeLocalTerminal('local-terminal-1')

    expect(invokeMock).toHaveBeenCalledWith('write_local_terminal', {
      sessionId: 'local-terminal-1',
      data: 'pwd\r',
    })
    expect(invokeMock).toHaveBeenCalledWith('resize_local_terminal', {
      sessionId: 'local-terminal-1',
      rows: 40,
      cols: 120,
    })
    expect(invokeMock).toHaveBeenCalledWith('close_local_terminal', {
      sessionId: 'local-terminal-1',
    })
  })

  test('listens to embedded local terminal native events', async () => {
    const unlisten = vi.fn()
    listenMock.mockResolvedValue(unlisten)
    const outputHandler = vi.fn()
    const exitHandler = vi.fn()

    await listenLocalTerminalOutput(outputHandler)
    await listenLocalTerminalExit(exitHandler)

    expect(listenMock).toHaveBeenCalledWith('local-terminal-output', expect.any(Function))
    expect(listenMock).toHaveBeenCalledWith('local-terminal-exit', expect.any(Function))
  })

  test('attaches an embedded local terminal after listeners are ready', async () => {
    const calls: string[] = []
    const outputUnlisten = vi.fn()
    const exitUnlisten = vi.fn()
    listenMock.mockImplementation(async event => {
      calls.push(`listen:${event}`)
      return event === 'local-terminal-output' ? outputUnlisten : exitUnlisten
    })
    invokeMock.mockImplementation(async command => {
      calls.push(`invoke:${command}`)
      if (command === 'get_local_terminal_snapshot') {
        return { session_id: 'local-terminal-1', sequence: 0, data: '' }
      }
      return undefined
    })

    const unlisten = await connectLocalTerminal('local-terminal-1', vi.fn(), vi.fn())

    expect(calls).toEqual([
      'listen:local-terminal-output',
      'listen:local-terminal-exit',
      'invoke:get_local_terminal_snapshot',
      'invoke:attach_local_terminal',
    ])

    unlisten()
    expect(outputUnlisten).toHaveBeenCalledOnce()
    expect(exitUnlisten).toHaveBeenCalledOnce()
  })

  test('removes local terminal listeners when attach fails', async () => {
    const outputUnlisten = vi.fn()
    const exitUnlisten = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    listenMock.mockResolvedValueOnce(outputUnlisten).mockResolvedValueOnce(exitUnlisten)
    invokeMock.mockImplementation(async command => {
      if (command === 'get_local_terminal_snapshot') {
        return { session_id: 'local-terminal-1', sequence: 0, data: '' }
      }
      throw new Error('attach failed')
    })

    await expect(connectLocalTerminal('local-terminal-1', vi.fn(), vi.fn())).rejects.toThrow(
      'attach failed'
    )

    expect(outputUnlisten).toHaveBeenCalledOnce()
    expect(exitUnlisten).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledWith('Local terminal connection failed', {
      sessionId: 'local-terminal-1',
      stage: 'attach',
      error: 'attach failed',
    })
  })

  test('replays a snapshot before buffered live output without duplicates', async () => {
    const outputHandler = vi.fn()
    let nativeOutput:
      | ((event: { payload: { session_id: string; sequence: number; data: string } }) => void)
      | undefined
    listenMock.mockImplementation(async (event, handler) => {
      if (event === 'local-terminal-output') {
        nativeOutput = handler as typeof nativeOutput
      }
      return vi.fn()
    })
    invokeMock.mockImplementation(async command => {
      if (command === 'get_local_terminal_snapshot') {
        nativeOutput?.({
          payload: { session_id: 'local-terminal-1', sequence: 3, data: 'live' },
        })
        return { session_id: 'local-terminal-1', sequence: 2, data: 'history' }
      }
      return undefined
    })

    await connectLocalTerminal('local-terminal-1', outputHandler, vi.fn())

    expect(outputHandler.mock.calls.map(([payload]) => payload.data)).toEqual(['history', 'live'])
  })

  test('ignores exit events from other local terminal sessions', async () => {
    const exitHandler = vi.fn()
    let nativeExit: ((event: { payload: { session_id: string } }) => void) | undefined
    listenMock.mockImplementation(async (event, handler) => {
      if (event === 'local-terminal-exit') {
        nativeExit = handler as typeof nativeExit
      }
      return vi.fn()
    })
    invokeMock.mockImplementation(async command => {
      if (command === 'get_local_terminal_snapshot') {
        return { session_id: 'local-terminal-1', sequence: 0, data: '' }
      }
      return undefined
    })

    await connectLocalTerminal('local-terminal-1', vi.fn(), exitHandler)
    nativeExit?.({ payload: { session_id: 'local-terminal-2' } })
    nativeExit?.({ payload: { session_id: 'local-terminal-1' } })

    expect(exitHandler).toHaveBeenCalledOnce()
    expect(exitHandler).toHaveBeenCalledWith({ session_id: 'local-terminal-1' })
  })
})
