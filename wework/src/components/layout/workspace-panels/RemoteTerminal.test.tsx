import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { openExternalUrl } from '@/lib/external-links'
import { createRemoteTerminalClient } from '@/lib/remote-terminal-socket'
import { RemoteTerminal } from './RemoteTerminal'

const testState = vi.hoisted(() => ({
  terminalInstances: [] as Array<{
    rows: number
    cols: number
    emitData: (data: string) => void
    onData: ReturnType<typeof vi.fn>
    onTitleChange: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    writeln: ReturnType<typeof vi.fn>
    loadAddon: ReturnType<typeof vi.fn>
    open: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    options: { theme?: unknown }
  }>,
  webLinksAddonInstances: [] as Array<{
    activate: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    openUri: (uri: string) => void
  }>,
  resizeObserverInstances: [] as Array<{
    trigger: () => void
    observe: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function FitAddonMock() {
    return {
      fit: vi.fn(),
    }
  }),
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(function WebLinksAddonMock(
    handler: (_event: MouseEvent, uri: string) => void
  ) {
    const addon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      openUri: (uri: string) => handler(new MouseEvent('click'), uri),
    }
    testState.webLinksAddonInstances.push(addon)
    return addon
  }),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock() {
    const dataHandlers: Array<(data: string) => void> = []
    const terminal = {
      rows: 24,
      cols: 80,
      emitData: (data: string) => dataHandlers.forEach(handler => handler(data)),
      onData: vi.fn((handler: (data: string) => void) => {
        dataHandlers.push(handler)
        return { dispose: vi.fn() }
      }),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      writeln: vi.fn(),
      loadAddon: vi.fn(),
      open: vi.fn(),
      dispose: vi.fn(),
      focus: vi.fn(),
      options: {},
    }
    testState.terminalInstances.push(terminal)
    return terminal
  }),
}))

vi.mock('@/lib/remote-terminal-socket', () => ({
  createRemoteTerminalClient: vi.fn(),
}))

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn().mockResolvedValue(true),
}))

const createRemoteTerminalClientMock = vi.mocked(createRemoteTerminalClient)
const openExternalUrlMock = vi.mocked(openExternalUrl)

function createClient(overrides: Partial<ReturnType<typeof createRemoteTerminalClient>> = {}) {
  return {
    attach: vi.fn().mockResolvedValue({ success: true }),
    write: vi.fn().mockResolvedValue({ success: true }),
    resize: vi.fn().mockResolvedValue({ success: true }),
    close: vi.fn().mockResolvedValue({ success: true }),
    onOutput: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    ...overrides,
  }
}

class ResizeObserverMock {
  observe = vi.fn()
  disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallback) {
    testState.resizeObserverInstances.push(this)
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

describe('RemoteTerminal', () => {
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    testState.terminalInstances.length = 0
    testState.webLinksAddonInstances.length = 0
    testState.resizeObserverInstances.length = 0
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(callback => {
        callback(0)
        return 1
      })
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    requestAnimationFrameSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  test('catches rejected terminal writes', async () => {
    const error = new Error('socket down')
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
      write: vi.fn().mockRejectedValue(error),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    testState.terminalInstances[0].emitData('pwd\r')

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to write to remote terminal:', error)
    })
  })

  test('calls exit handler without writing process exited text', () => {
    let exitHandler: ((payload: { session_id: string }) => void) | null = null
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
      onExit: vi.fn(handler => {
        exitHandler = handler
        return vi.fn()
      }),
    })
    const onExit = vi.fn()
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
        onExit={onExit}
      />
    )
    exitHandler?.({ session_id: 'terminal-1' })

    expect(onExit).toHaveBeenCalledTimes(1)
    expect(testState.terminalInstances[0].writeln).not.toHaveBeenCalledWith(
      expect.stringContaining('Process exited')
    )
  })

  test('skips resize observer syncs while inactive', () => {
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    testState.resizeObserverInstances[0].trigger()

    expect(client.resize).not.toHaveBeenCalled()
  })

  test('does not resend unchanged terminal size when reactivated', async () => {
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    const { rerender } = render(
      <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
    )

    await waitFor(() => {
      expect(client.resize).toHaveBeenCalledTimes(1)
    })

    rerender(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    rerender(
      <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
    )

    expect(client.resize).toHaveBeenCalledTimes(1)
  })

  test('catches rejected active terminal size syncs', async () => {
    const error = new Error('activate resize failed')
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
      resize: vi.fn().mockRejectedValue(error),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
    )

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to sync remote terminal size on activate:',
        error
      )
    })
    expect(requestAnimationFrameSpy).toHaveBeenCalled()
  })

  test('loads web links addon and opens terminal urls through the external link handler', () => {
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    const terminal = testState.terminalInstances[0]
    const webLinksAddon = testState.webLinksAddonInstances[0]

    expect(terminal.loadAddon).toHaveBeenCalledWith(webLinksAddon)
    webLinksAddon.openUri('https://example.com/docs')
    expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/docs')
  })
})
