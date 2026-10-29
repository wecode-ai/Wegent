import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  closeConnectorAuthorizationWindow,
  isConnectorAuthorizationUrl,
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
      void openConnectorAuthorizationWindow({
        url: 'https://provider.example/authorize',
        parent,
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

  test('closes when the poll loop reports a terminal state', async () => {
    vi.useFakeTimers()
    try {
      const opened = openConnectorAuthorizationWindow({
        url: 'https://provider.example/authorize',
        parent,
      })
      await vi.advanceTimersByTimeAsync(0)

      closeConnectorAuthorizationWindow()
      expect(mocks.window.close).toHaveBeenCalledTimes(1)

      mocks.listeners.get('closed')?.()
      await opened
      expect(mocks.clearStorageData).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test('stays open while the provider page is still loading', async () => {
    vi.useFakeTimers()
    try {
      const opened = openConnectorAuthorizationWindow({
        url: 'https://provider.example/authorize',
        parent,
      })
      await vi.advanceTimersByTimeAsync(0)

      mocks.webContentsListeners.get('did-navigate')?.({}, 'https://provider.example/consent')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(mocks.window.close).not.toHaveBeenCalled()

      mocks.listeners.get('closed')?.()
      await opened
    } finally {
      vi.useRealTimers()
    }
  })
})
