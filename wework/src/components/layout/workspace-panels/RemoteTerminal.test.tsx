import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { StrictMode } from 'react'
import { openExternalUrl } from '@/lib/external-links'
import { createRemoteTerminalClient } from '@/lib/remote-terminal-socket'
import {
  consumeWorkbenchComposerFocusRequest,
  requestWorkbenchComposerFocus,
} from '@/lib/workbenchComposerFocus'
import { RemoteTerminal } from './RemoteTerminal'

const testState = vi.hoisted(() => ({
  terminalConstructorOptions: [] as Array<Record<string, unknown>>,
  terminalInstances: [] as Array<{
    rows: number
    cols: number
    buffer: { active: { viewportY: number } }
    emitData: (data: string) => void
    clearSelection: ReturnType<typeof vi.fn>
    getSelection: ReturnType<typeof vi.fn>
    getSelectionPosition: ReturnType<typeof vi.fn>
    hasSelection: ReturnType<typeof vi.fn>
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>
    onData: ReturnType<typeof vi.fn>
    onResize: ReturnType<typeof vi.fn>
    onScroll: ReturnType<typeof vi.fn>
    onSelectionChange: ReturnType<typeof vi.fn>
    onTitleChange: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    writeln: ReturnType<typeof vi.fn>
    loadAddon: ReturnType<typeof vi.fn>
    open: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    refresh: ReturnType<typeof vi.fn>
    textarea: HTMLTextAreaElement
    textareaFocus: ReturnType<typeof vi.spyOn>
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
  Terminal: vi.fn().mockImplementation(function TerminalMock(options: Record<string, unknown>) {
    testState.terminalConstructorOptions.push(options)
    const dataHandlers: Array<(data: string) => void> = []
    const textarea = document.createElement('textarea')
    const textareaFocus = vi.spyOn(textarea, 'focus')
    const terminal = {
      rows: 24,
      cols: 80,
      buffer: { active: { viewportY: 0 } },
      emitData: (data: string) => dataHandlers.forEach(handler => handler(data)),
      clearSelection: vi.fn(),
      getSelection: vi.fn(() => ''),
      getSelectionPosition: vi.fn(() => undefined),
      hasSelection: vi.fn(() => false),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn((handler: (data: string) => void) => {
        dataHandlers.push(handler)
        return { dispose: vi.fn() }
      }),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      writeln: vi.fn(),
      loadAddon: vi.fn(),
      open: vi.fn(),
      dispose: vi.fn(),
      focus: vi.fn(),
      refresh: vi.fn(),
      textarea,
      textareaFocus,
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
    testState.terminalConstructorOptions.length = 0
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

  test('keeps one terminal client during the StrictMode effect replay', async () => {
    let outputHandler: ((payload: { session_id: string; data: string }) => void) | null = null
    const client = createClient({
      onOutput: vi.fn(handler => {
        outputHandler = handler
        return vi.fn()
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    const { unmount } = render(
      <StrictMode>
        <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
      </StrictMode>
    )

    await waitFor(() => {
      expect(createRemoteTerminalClientMock).toHaveBeenCalledTimes(1)
      expect(client.attach).toHaveBeenCalledTimes(1)
    })
    outputHandler?.({ session_id: 'terminal-1', data: 'remote prompt$ ' })

    expect(testState.terminalInstances).toHaveLength(1)
    expect(testState.terminalInstances[0].write).toHaveBeenCalledWith('remote prompt$ ')

    unmount()
    await waitFor(() => {
      expect(client.close).toHaveBeenCalledTimes(1)
      expect(client.dispose).toHaveBeenCalledTimes(1)
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

  test('waits for attach before syncing terminal size and does not resend it', async () => {
    let resolveAttach: (() => void) | null = null
    const client = createClient({
      attach: vi.fn(
        () =>
          new Promise<void>(resolve => {
            resolveAttach = resolve
          })
      ),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    const { rerender } = render(
      <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
    )

    expect(client.resize).not.toHaveBeenCalled()

    resolveAttach?.()
    await waitFor(() => expect(client.resize).toHaveBeenCalledWith(24, 80))

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

  test('does not take focus from the composer when reactivated', () => {
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    const { rerender } = render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    const composer = document.createElement('textarea')
    composer.dataset.testid = 'chat-message-input'
    document.body.append(composer)
    composer.focus()

    rerender(
      <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
    )

    expect(composer).toHaveFocus()
    expect(testState.terminalInstances[0].textareaFocus).not.toHaveBeenCalled()
    composer.remove()
  })

  test('does not focus the terminal while a composer focus request is pending', () => {
    const now = Date.now()
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)
    requestWorkbenchComposerFocus('runtime:device-1:task-1')

    render(
      <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
    )

    expect(testState.terminalInstances[0].textareaFocus).not.toHaveBeenCalled()
    dateNowSpy.mockReturnValue(now + 2_001)
    consumeWorkbenchComposerFocusRequest('runtime:device-1:task-1', Symbol('cleanup-1'))
    consumeWorkbenchComposerFocusRequest('runtime:device-1:task-1', Symbol('cleanup-2'))
    dateNowSpy.mockRestore()
  })

  test('focuses the terminal when activated without a focused composer', () => {
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
    )

    expect(testState.terminalInstances[0].textareaFocus).toHaveBeenCalledWith({
      preventScroll: true,
    })
  })

  test('refreshes buffered rows when activated and when the window regains focus', () => {
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
    )
    const terminal = testState.terminalInstances[0]

    expect(terminal.refresh).toHaveBeenCalledWith(0, 23)

    terminal.refresh.mockClear()
    window.dispatchEvent(new Event('focus'))

    expect(terminal.refresh).toHaveBeenCalledWith(0, 23)
  })

  test('catches rejected post-attach terminal size syncs', async () => {
    const error = new Error('activate resize failed')
    const client = createClient({
      resize: vi.fn().mockRejectedValue(error),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
    )

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to resize remote terminal:', error)
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

  test('enables xterm transparency for a workbench background', () => {
    createRemoteTerminalClientMock.mockReturnValue(
      createClient({ attach: vi.fn(() => new Promise(() => undefined)) })
    )

    const { getByTestId } = render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active
        showWorkbenchBackground
      />
    )

    expect(testState.terminalConstructorOptions[0]).toEqual(
      expect.objectContaining({
        allowTransparency: true,
        theme: expect.objectContaining({ background: 'rgba(0, 0, 0, 0)' }),
      })
    )
    expect(getByTestId('remote-terminal')).toHaveClass('bg-transparent')
  })
})
