import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRemoteTerminalClient } from '@/lib/remote-terminal-socket'
import { RemoteTerminal } from './RemoteTerminal'

const testState = vi.hoisted(() => ({
  terminalInstances: [] as Array<{
    rows: number
    cols: number
    emitData: (data: string) => void
    onData: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    writeln: ReturnType<typeof vi.fn>
    loadAddon: ReturnType<typeof vi.fn>
    open: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
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
      write: vi.fn(),
      writeln: vi.fn(),
      loadAddon: vi.fn(),
      open: vi.fn(),
      dispose: vi.fn(),
      focus: vi.fn(),
    }
    testState.terminalInstances.push(terminal)
    return terminal
  }),
}))

vi.mock('@/lib/remote-terminal-socket', () => ({
  createRemoteTerminalClient: vi.fn(),
}))

const createRemoteTerminalClientMock = vi.mocked(createRemoteTerminalClient)

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

    render(<RemoteTerminal sessionId="terminal-1" active={false} />)
    testState.terminalInstances[0].emitData('pwd\r')

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to write to remote terminal:',
        error
      )
    })
  })

  test('catches rejected resize observer syncs', async () => {
    const error = new Error('resize failed')
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
      resize: vi.fn().mockRejectedValue(error),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(<RemoteTerminal sessionId="terminal-1" active={false} />)
    testState.resizeObserverInstances[0].trigger()

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to resize remote terminal:',
        error
      )
    })
  })

  test('catches rejected active terminal size syncs', async () => {
    const error = new Error('activate resize failed')
    const client = createClient({
      attach: vi.fn(() => new Promise(() => undefined)),
      resize: vi.fn().mockRejectedValue(error),
    })
    createRemoteTerminalClientMock.mockReturnValue(client)

    render(<RemoteTerminal sessionId="terminal-1" active />)

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to sync remote terminal size on activate:',
        error
      )
    })
    expect(requestAnimationFrameSpy).toHaveBeenCalled()
  })
})
