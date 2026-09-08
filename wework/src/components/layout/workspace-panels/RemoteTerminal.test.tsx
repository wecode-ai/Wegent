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

interface OutputPayload {
  session_id: string
  sequence: number
  data: string
  protocol_version?: 1 | 2
}

const testState = vi.hoisted(() => ({
  terminalConstructorOptions: [] as Array<Record<string, unknown>>,
  terminalInstances: [] as Array<{
    rows: number
    cols: number
    buffer: { active: { viewportY: number } }
    emitData: (data: string) => void
    completeNextWrite: () => void
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
    const writeCallbacks: Array<() => void> = []
    const textarea = document.createElement('textarea')
    const textareaFocus = vi.spyOn(textarea, 'focus')
    const terminal = {
      rows: 24,
      cols: 80,
      buffer: { active: { viewportY: 0 } },
      emitData: (data: string) => dataHandlers.forEach(handler => handler(data)),
      completeNextWrite: () => writeCallbacks.shift()?.(),
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
      write: vi.fn((_data: string, callback?: () => void) => {
        if (callback) writeCallbacks.push(callback)
      }),
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
    ack: vi.fn().mockResolvedValue({ success: true }),
    write: vi.fn().mockResolvedValue({ success: true }),
    resize: vi.fn().mockResolvedValue({ success: true }),
    close: vi.fn().mockResolvedValue({ success: true }),
    onOutput: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onDisconnect: vi.fn(() => vi.fn()),
    onReconnect: vi.fn(() => vi.fn()),
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
    vi.useRealTimers()
    requestAnimationFrameSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  test('catches rejected terminal writes', async () => {
    const error = new Error('socket down')
    const client = createClient({
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
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(1))
    testState.terminalInstances[0].emitData('pwd\r')

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to write to remote terminal:', error)
    })
  })

  test('queues input until the initial attach completes', async () => {
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

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    testState.terminalInstances[0].emitData('pwd\r')

    expect(client.write).not.toHaveBeenCalled()
    resolveAttach?.()
    await waitFor(() => expect(client.write).toHaveBeenCalledWith('pwd\r'))
  })

  test('queues input while disconnected and coalesces duplicate reconnect attach requests', async () => {
    let disconnectHandler: (() => void) | null = null
    let reconnectHandler: (() => void) | null = null
    let resolveReconnectAttach: (() => void) | null = null
    const client = createClient({
      attach: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(
          () =>
            new Promise<void>(resolve => {
              resolveReconnectAttach = resolve
            })
        ),
      onDisconnect: vi.fn(handler => {
        disconnectHandler = handler
        return vi.fn()
      }),
      onReconnect: vi.fn(handler => {
        reconnectHandler = handler
        return vi.fn()
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(1))

    disconnectHandler?.()
    testState.terminalInstances[0].emitData('queued\r')
    reconnectHandler?.()
    reconnectHandler?.()

    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(2))
    expect(client.write).not.toHaveBeenCalled()
    resolveReconnectAttach?.()
    await waitFor(() => expect(client.write).toHaveBeenCalledWith('queued\r'))
    expect(client.attach).toHaveBeenCalledTimes(2)
  })

  test('queues a newer reconnect when the previous reconnect attach becomes stale', async () => {
    let disconnectHandler: (() => void) | null = null
    let reconnectHandler: (() => void) | null = null
    let rejectReconnectAttach: ((error: Error) => void) | null = null
    const client = createClient({
      attach: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectReconnectAttach = reject
            })
        )
        .mockResolvedValue(undefined),
      onDisconnect: vi.fn(handler => {
        disconnectHandler = handler
        return vi.fn()
      }),
      onReconnect: vi.fn(handler => {
        reconnectHandler = handler
        return vi.fn()
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(1))

    disconnectHandler?.()
    reconnectHandler?.()
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(2))
    disconnectHandler?.()
    reconnectHandler?.()
    rejectReconnectAttach?.(new Error('stale reconnect'))

    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(3))
  })

  test('keeps one terminal client during the StrictMode effect replay', async () => {
    let outputHandler: ((payload: OutputPayload) => void) | null = null
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
    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: 'remote prompt$ ' })

    expect(testState.terminalInstances).toHaveLength(1)
    expect(testState.terminalInstances[0].write).toHaveBeenCalledWith(
      'remote prompt$ ',
      expect.any(Function)
    )

    unmount()
    await waitFor(() => {
      expect(client.close).toHaveBeenCalledTimes(1)
      expect(client.dispose).toHaveBeenCalledTimes(1)
    })
  })

  test('writes output without scheduling a theme sync', () => {
    let outputHandler: ((payload: OutputPayload) => void) | null = null
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
      onOutput: vi.fn(handler => {
        outputHandler = handler
        return vi.fn()
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    const scheduledFrames = requestAnimationFrameSpy.mock.calls.length

    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: 'remote prompt$ ' })

    expect(testState.terminalInstances[0].write).toHaveBeenCalledWith(
      'remote prompt$ ',
      expect.any(Function)
    )
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(scheduledFrames)
  })

  test('writes output in sequence and acknowledges only after xterm consumes it', async () => {
    let outputHandler: ((payload: OutputPayload) => void) | null = null
    const client = createClient({
      onOutput: vi.fn(handler => {
        outputHandler = handler
        return vi.fn()
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(1))
    const terminal = testState.terminalInstances[0]

    outputHandler?.({ session_id: 'terminal-1', sequence: 2, data: 'second' })
    expect(terminal.write).not.toHaveBeenCalled()

    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: 'first' })
    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenLastCalledWith('first', expect.any(Function))
    expect(client.ack).not.toHaveBeenCalled()

    terminal.completeNextWrite()
    expect(terminal.write).toHaveBeenCalledTimes(2)
    expect(terminal.write).toHaveBeenLastCalledWith('second', expect.any(Function))
    expect(client.ack).not.toHaveBeenCalled()

    terminal.completeNextWrite()
    await waitFor(() => expect(client.ack).toHaveBeenCalledWith(2))
    expect(client.ack).toHaveBeenCalledTimes(1)
  })

  test('does not rewrite consumed replay and acknowledges it again after a failed ack', async () => {
    let outputHandler: ((payload: OutputPayload) => void) | null = null
    const ackError = new Error('ack lost')
    const client = createClient({
      ack: vi.fn().mockRejectedValueOnce(ackError).mockResolvedValue(undefined),
      onOutput: vi.fn(handler => {
        outputHandler = handler
        return vi.fn()
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(1))
    const terminal = testState.terminalInstances[0]

    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: 'once' })
    terminal.completeNextWrite()
    await waitFor(() => {
      expect(client.ack).toHaveBeenCalledTimes(1)
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to acknowledge remote terminal output:',
        ackError
      )
    })

    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: 'once' })

    await waitFor(() => expect(client.ack).toHaveBeenCalledTimes(2))
    expect(client.ack).toHaveBeenLastCalledWith(1)
    expect(terminal.write).toHaveBeenCalledTimes(1)
  })

  test('acknowledges consumed replay after attach completes without rewriting it', async () => {
    let outputHandler: ((payload: OutputPayload) => void) | null = null
    let resolveAttach: (() => void) | null = null
    const client = createClient({
      attach: vi.fn(
        () =>
          new Promise<void>(resolve => {
            resolveAttach = resolve
          })
      ),
      onOutput: vi.fn(handler => {
        outputHandler = handler
        return vi.fn()
      }),
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

    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: 'replayed' })
    terminal.completeNextWrite()
    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: 'replayed' })

    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(client.ack).not.toHaveBeenCalled()

    resolveAttach?.()

    await waitFor(() => expect(client.ack).toHaveBeenCalledWith(1))
    expect(terminal.write).toHaveBeenCalledTimes(1)
  })

  test('requests bounded replay when the out-of-order buffer reaches its limit', async () => {
    let outputHandler: ((payload: OutputPayload) => void) | null = null
    const client = createClient({
      onOutput: vi.fn(handler => {
        outputHandler = handler
        return vi.fn()
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(1))
    const terminal = testState.terminalInstances[0]

    for (let sequence = 2; sequence <= 257; sequence += 1) {
      outputHandler?.({ session_id: 'terminal-1', sequence, data: `${sequence}` })
    }
    outputHandler?.({ session_id: 'terminal-1', sequence: 258, data: 'overflow' })

    expect(terminal.write).not.toHaveBeenCalled()
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Remote terminal output buffer limit exceeded; requesting bounded replay.'
    )
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(2))
    expect(client.attach).toHaveBeenLastCalledWith(0)

    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: 'first' })
    expect(terminal.write).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenLastCalledWith('first', expect.any(Function))
  })

  test('requests replay when an output sequence gap does not close', async () => {
    vi.useFakeTimers()
    let outputHandler: ((payload: OutputPayload) => void) | null = null
    const client = createClient({
      onOutput: vi.fn(handler => {
        outputHandler = handler
        return vi.fn()
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    const { unmount } = render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    await Promise.resolve()
    expect(client.attach).toHaveBeenCalledTimes(1)

    outputHandler?.({ session_id: 'terminal-1', sequence: 2, data: 'second' })
    expect(testState.terminalInstances[0].write).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.attach).toHaveBeenCalledTimes(2)
    expect(client.attach).toHaveBeenLastCalledWith(0)

    unmount()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  })

  test('retries a failed replay attach after the output gap closes', async () => {
    vi.useFakeTimers()
    let outputHandler: ((payload: OutputPayload) => void) | null = null
    const client = createClient({
      attach: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('reattach failed'))
        .mockResolvedValue(undefined),
      onOutput: vi.fn(handler => {
        outputHandler = handler
        return vi.fn()
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    const { unmount } = render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    await Promise.resolve()
    outputHandler?.({ session_id: 'terminal-1', sequence: 2, data: 'second' })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.attach).toHaveBeenCalledTimes(2)

    testState.terminalInstances[0].emitData('pwd\r')
    expect(client.write).not.toHaveBeenCalled()

    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: 'first' })
    testState.terminalInstances[0].completeNextWrite()
    testState.terminalInstances[0].completeNextWrite()

    await vi.advanceTimersByTimeAsync(999)
    expect(client.attach).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.attach).toHaveBeenCalledTimes(3)
    await Promise.resolve()
    await vi.runOnlyPendingTimersAsync()
    expect(client.write).toHaveBeenCalledWith('pwd\r')
    expect(client.ack).toHaveBeenCalledWith(2)

    unmount()
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  })

  test('keeps replay recovery active until dropped output is observed', async () => {
    vi.useFakeTimers()
    let outputHandler: ((payload: OutputPayload) => void) | null = null
    const client = createClient({
      onOutput: vi.fn(handler => {
        outputHandler = handler
        return vi.fn()
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    const { unmount } = render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )
    await Promise.resolve()
    for (let sequence = 2; sequence <= 258; sequence += 1) {
      outputHandler?.({
        session_id: 'terminal-1',
        sequence,
        data: `${sequence}`,
      })
    }

    await vi.advanceTimersByTimeAsync(0)
    expect(client.attach).toHaveBeenCalledTimes(2)

    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: '1' })
    for (let sequence = 1; sequence <= 257; sequence += 1) {
      testState.terminalInstances[0].completeNextWrite()
    }
    await vi.advanceTimersByTimeAsync(2_000)
    expect(client.attach).toHaveBeenCalledTimes(3)

    outputHandler?.({ session_id: 'terminal-1', sequence: 258, data: '258' })
    testState.terminalInstances[0].completeNextWrite()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.attach).toHaveBeenCalledTimes(3)

    unmount()
    await vi.advanceTimersByTimeAsync(0)
  })

  test('reattaches from the last consumed output while hidden and defers size sync', async () => {
    let outputHandler: ((payload: OutputPayload) => void) | null = null
    let reconnectHandler: (() => void) | null = null
    const unsubscribeReconnect = vi.fn()
    const client = createClient({
      ack: vi.fn(() => new Promise(() => undefined)),
      onOutput: vi.fn(handler => {
        outputHandler = handler
        return vi.fn()
      }),
      onReconnect: vi.fn(handler => {
        reconnectHandler = handler
        return unsubscribeReconnect
      }),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    const { rerender, unmount } = render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={createRemoteTerminalClient}
        active={false}
      />
    )

    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(1))
    expect(client.resize).not.toHaveBeenCalled()
    outputHandler?.({ session_id: 'terminal-1', sequence: 1, data: 'consumed' })
    testState.terminalInstances[0].completeNextWrite()
    await waitFor(() => expect(client.ack).toHaveBeenCalledWith(1))

    reconnectHandler?.()

    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(2))
    expect(client.attach).toHaveBeenLastCalledWith(1)
    expect(client.resize).not.toHaveBeenCalled()

    rerender(
      <RemoteTerminal sessionId="terminal-1" clientFactory={createRemoteTerminalClient} active />
    )

    await waitFor(() => expect(client.resize).toHaveBeenCalledWith(24, 80))

    unmount()
    await waitFor(() => expect(unsubscribeReconnect).toHaveBeenCalledTimes(1))
  })

  test('waits for final xterm consumption before reporting an early legacy exit', async () => {
    const client = createClient()
    const onExit = vi.fn()
    render(
      <RemoteTerminal
        sessionId="terminal-1"
        clientFactory={() => client}
        active={false}
        onExit={onExit}
      />
    )
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(1))
    const output = client.onOutput.mock.calls[0][0] as (payload: OutputPayload) => void
    const exit = client.onExit.mock.calls[0][0] as (payload: { session_id: string }) => void
    output({ session_id: 'terminal-1', sequence: 1, data: 'first', protocol_version: 1 })
    output({ session_id: 'terminal-1', sequence: 2, data: 'final', protocol_version: 1 })
    exit({ session_id: 'terminal-1' })
    expect(onExit).not.toHaveBeenCalled()
    const terminal = testState.terminalInstances[0]
    terminal.completeNextWrite()
    expect(onExit).not.toHaveBeenCalled()
    expect(terminal.write).toHaveBeenLastCalledWith('final', expect.any(Function))
    terminal.completeNextWrite()
    expect(onExit).toHaveBeenCalledTimes(1)
    exit({ session_id: 'terminal-1' })
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  test.each(['queue', 'chunk'])(
    'closes an overflowing legacy %s with a visible error instead of requesting replay',
    async bound => {
      const client = createClient()
      render(<RemoteTerminal sessionId="terminal-1" clientFactory={() => client} active={false} />)
      await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(1))
      const output = client.onOutput.mock.calls[0][0] as (payload: OutputPayload) => void
      const count = bound === 'queue' ? 258 : 1
      for (let index = 1; index <= count; index++) {
        output({
          session_id: 'terminal-1',
          sequence: index,
          data: bound === 'chunk' ? 'x'.repeat(1024 * 1024 + 1) : 'line',
          protocol_version: 1,
        })
      }
      const terminal = testState.terminalInstances[0]
      expect(terminal.writeln).toHaveBeenCalledWith(expect.stringMatching(/legacy|旧版/))
      await waitFor(() => expect(client.dispose).toHaveBeenCalledTimes(1))
      expect(client.close).toHaveBeenCalledTimes(1)
      terminal.emitData('should not send\r')
      expect(client.write).not.toHaveBeenCalled()
      expect(client.attach).toHaveBeenCalledTimes(1)
      if (bound === 'chunk') expect(terminal.write).not.toHaveBeenCalled()
    }
  )

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
