import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  closeConnectorAuthorizationWindow,
  isConnectorAuthorizationUrl,
  isConnectorAuthorizationWindowOpen,
  openConnectorAuthorizationWindow,
} from './connector-authorization-window.js'

type Listener = (...args: unknown[]) => void

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Listener>()
  const webContentsListeners = new Map<string, Listener>()
  const window = {
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    setMenuBarVisibility: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    once: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener)
    }),
    webContents: {
      on: vi.fn((event: string, listener: Listener) => {
        webContentsListeners.set(event, listener)
      }),
      setWindowOpenHandler: vi.fn(),
    },
  }
  return {
    window,
    listeners,
    webContentsListeners,
    clearStorageData: vi.fn(async () => undefined),
    fromPartition: vi.fn(),
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {
    constructor() {
      return mocks.window
    }
  },
  session: {
    fromPartition: mocks.fromPartition,
  },
}))

const parent = {} as never

describe('connector authorization window', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
    mocks.webContentsListeners.clear()
    mocks.fromPartition.mockReturnValue({ clearStorageData: mocks.clearStorageData })
  })

  test('only accepts https or loopback origins', () => {
    expect(isConnectorAuthorizationUrl('https://provider.example/authorize')).toBe(true)
    expect(isConnectorAuthorizationUrl('http://localhost:9999/connector-oauth/authorize')).toBe(
      true
    )
    expect(isConnectorAuthorizationUrl('http://127.0.0.1:8080/authorize')).toBe(true)
    expect(isConnectorAuthorizationUrl('http://provider.example/authorize')).toBe(false)
    expect(isConnectorAuthorizationUrl('file:///tmp/authorize.html')).toBe(false)
    expect(isConnectorAuthorizationUrl('not a url')).toBe(false)
  })

  test('keeps the window open after the backend callback loads', async () => {
    vi.useFakeTimers()
    try {
      await openConnectorAuthorizationWindow({
        url: 'https://provider.example/authorize',
        parent,
        requestId: 'attempt-1',
      })
      await vi.advanceTimersByTimeAsync(0)

      mocks.webContentsListeners.get('did-navigate')?.(
        {},
        'http://localhost:8000/api/connector-apps/oauth/callback?code=1'
      )
      await vi.advanceTimersByTimeAsync(2_000)

      // The backend may still be exchanging the code; the poll loop decides
      // when the window can close.
      expect(mocks.window.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test('closing is scoped to one attempt', async () => {
    await openConnectorAuthorizationWindow({
      url: 'https://provider.example/authorize',
      parent,
      requestId: 'attempt-1',
    })

    closeConnectorAuthorizationWindow('someone-else')
    expect(mocks.window.close).not.toHaveBeenCalled()

    closeConnectorAuthorizationWindow('attempt-1')
    expect(mocks.window.close).toHaveBeenCalledTimes(1)

    // Idempotent: a second call for the same attempt is a no-op.
    closeConnectorAuthorizationWindow('attempt-1')
    expect(mocks.window.close).toHaveBeenCalledTimes(1)
  })

  test('reports the attempt as open until its window closes', async () => {
    const closedAttempts: string[] = []
    await openConnectorAuthorizationWindow({
      url: 'https://provider.example/authorize',
      parent,
      requestId: 'attempt-1',
      onClosed: requestId => closedAttempts.push(requestId),
    })
    expect(isConnectorAuthorizationWindowOpen('attempt-1')).toBe(true)
    expect(closedAttempts).toEqual([])

    mocks.listeners.get('closed')?.()

    expect(isConnectorAuthorizationWindowOpen('attempt-1')).toBe(false)
    expect(closedAttempts).toEqual(['attempt-1'])
    expect(mocks.clearStorageData).toHaveBeenCalled()
  })

  test('notifies the owning attempt once, including on an early close', async () => {
    const closedAttempts: string[] = []
    await openConnectorAuthorizationWindow({
      url: 'https://provider.example/authorize',
      parent,
      requestId: 'attempt-1',
      onClosed: requestId => closedAttempts.push(requestId),
    })

    closeConnectorAuthorizationWindow('attempt-1')
    mocks.listeners.get('closed')?.()
    closeConnectorAuthorizationWindow('attempt-1')

    expect(closedAttempts).toEqual(['attempt-1'])
  })
})
