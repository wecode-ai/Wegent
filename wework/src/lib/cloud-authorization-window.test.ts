import { beforeEach, describe, expect, test, vi } from 'vitest'
import { openExternalUrl } from './external-links'
import { isTauriRuntime } from './runtime-environment'
import { openCloudAuthorizationWindow } from './cloud-authorization-window'

const invokeMock = vi.hoisted(() => vi.fn())

const webviewWindowMocks = vi.hoisted(() => {
  const constructorMock = vi.fn()
  const existingCloseMock = vi.fn()
  const getByLabelMock = vi.fn()
  const setFocusMock = vi.fn()
  const setAlwaysOnTopMock = vi.fn()
  const showMock = vi.fn()
  const closeMock = vi.fn()
  const destroyMock = vi.fn()
  const onCloseRequestedMock = vi.fn()
  const onceMock = vi.fn()

  return {
    constructorMock,
    existingCloseMock,
    getByLabelMock,
    setFocusMock,
    setAlwaysOnTopMock,
    showMock,
    closeMock,
    destroyMock,
    onCloseRequestedMock,
    onceMock,
  }
})

const currentWindowMocks = vi.hoisted(() => ({
  onMoved: vi.fn(),
  onScaleChanged: vi.fn(),
  outerPosition: vi.fn(),
  outerSize: vi.fn(),
}))

const monitorMocks = vi.hoisted(() => ({
  currentMonitor: vi.fn(),
  primaryMonitor: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('./runtime-environment', () => ({
  isTauriRuntime: vi.fn(),
}))

vi.mock('./external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('./external-links')>()),
  openExternalUrl: vi.fn(),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => {
  class WebviewWindow {
    static getByLabel = webviewWindowMocks.getByLabelMock

    close = webviewWindowMocks.closeMock
    destroy = webviewWindowMocks.destroyMock
    setFocus = webviewWindowMocks.setFocusMock
    setAlwaysOnTop = webviewWindowMocks.setAlwaysOnTopMock
    show = webviewWindowMocks.showMock
    onCloseRequested = webviewWindowMocks.onCloseRequestedMock
    once = webviewWindowMocks.onceMock

    constructor(label: string, options: Record<string, unknown>) {
      webviewWindowMocks.constructorMock(label, options)
    }
  }

  return { WebviewWindow }
})

vi.mock('@tauri-apps/api/window', () => ({
  currentMonitor: monitorMocks.currentMonitor,
  getCurrentWindow: () => currentWindowMocks,
  primaryMonitor: monitorMocks.primaryMonitor,
}))

const isTauriRuntimeMock = vi.mocked(isTauriRuntime)
const openExternalUrlMock = vi.mocked(openExternalUrl)

describe('openCloudAuthorizationWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMock.mockResolvedValue(undefined)
    isTauriRuntimeMock.mockReturnValue(false)
    openExternalUrlMock.mockResolvedValue(true)
    webviewWindowMocks.getByLabelMock.mockResolvedValue(null)
    webviewWindowMocks.existingCloseMock.mockResolvedValue(undefined)
    webviewWindowMocks.closeMock.mockResolvedValue(undefined)
    webviewWindowMocks.destroyMock.mockResolvedValue(undefined)
    webviewWindowMocks.setFocusMock.mockResolvedValue(undefined)
    webviewWindowMocks.setAlwaysOnTopMock.mockResolvedValue(undefined)
    webviewWindowMocks.showMock.mockResolvedValue(undefined)
    webviewWindowMocks.onCloseRequestedMock.mockResolvedValue(vi.fn())
    currentWindowMocks.onMoved.mockResolvedValue(vi.fn())
    currentWindowMocks.onScaleChanged.mockResolvedValue(vi.fn())
    currentWindowMocks.outerPosition.mockResolvedValue({ x: 200, y: 100 })
    currentWindowMocks.outerSize.mockResolvedValue({ width: 1400, height: 1000 })
    const defaultMonitor = {
      name: 'Primary',
      position: { x: 0, y: 0 },
      size: { width: 1920, height: 1080 },
      workArea: {
        position: { x: 0, y: 0 },
        size: { width: 1920, height: 1080 },
      },
      scaleFactor: 1,
    }
    monitorMocks.currentMonitor.mockResolvedValue(defaultMonitor)
    monitorMocks.primaryMonitor.mockResolvedValue(null)
    webviewWindowMocks.onceMock.mockImplementation((event: string, handler) => {
      if (event === 'tauri://created') {
        window.queueMicrotask(() => handler({ payload: null }))
      }
      return Promise.resolve(vi.fn())
    })
  })

  test('rejects non-http authorization urls', async () => {
    await expect(openCloudAuthorizationWindow('file:///tmp/auth.html')).resolves.toBeUndefined()

    expect(openExternalUrlMock).not.toHaveBeenCalled()
    expect(webviewWindowMocks.constructorMock).not.toHaveBeenCalled()
  })

  test('opens external browser outside Tauri runtime', async () => {
    await expect(openCloudAuthorizationWindow('https://example.com/auth')).resolves.toBeUndefined()

    expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/auth')
    expect(webviewWindowMocks.constructorMock).not.toHaveBeenCalled()
  })

  test('creates a native Tauri webview window for authorization', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    webviewWindowMocks.getByLabelMock.mockResolvedValue({
      close: webviewWindowMocks.existingCloseMock,
    })

    await expect(
      openCloudAuthorizationWindow('https://cloud.example.com/auth/wework/authorize')
    ).resolves.toEqual({
      closed: expect.any(Promise),
      close: expect.any(Function),
    })

    expect(webviewWindowMocks.existingCloseMock).toHaveBeenCalled()
    expect(webviewWindowMocks.constructorMock).toHaveBeenCalledWith(
      'cloud-authorization',
      expect.objectContaining({
        url: 'https://cloud.example.com/auth/wework/authorize',
        title: 'Wegent Cloud',
        width: 1000,
        height: 640,
        minWidth: 960,
        minHeight: 620,
        x: 400,
        y: 244,
        center: false,
        maximizable: false,
        alwaysOnTop: true,
        focus: true,
        visible: false,
      })
    )
    expect(webviewWindowMocks.setAlwaysOnTopMock).toHaveBeenCalledWith(true)
    expect(invokeMock).toHaveBeenCalledWith('position_cloud_authorization_window')
    expect(webviewWindowMocks.showMock).toHaveBeenCalled()
    expect(currentWindowMocks.onMoved).toHaveBeenCalled()
    expect(currentWindowMocks.onScaleChanged).toHaveBeenCalled()
    expect(webviewWindowMocks.setFocusMock).toHaveBeenCalled()
    expect(webviewWindowMocks.onCloseRequestedMock).toHaveBeenCalled()
    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })

  test('closes the authorization window from the returned handle', async () => {
    isTauriRuntimeMock.mockReturnValue(true)

    const handle = await openCloudAuthorizationWindow(
      'https://cloud.example.com/auth/wework/authorize'
    )
    await handle?.close?.()

    expect(webviewWindowMocks.closeMock).toHaveBeenCalled()
  })

  test('repositions the authorization window after Wework moves', async () => {
    isTauriRuntimeMock.mockReturnValue(true)

    await openCloudAuthorizationWindow('https://cloud.example.com/auth/wework/authorize')
    const movedHandler = currentWindowMocks.onMoved.mock.calls[0]?.[0]
    expect(movedHandler).toBeTypeOf('function')

    vi.useFakeTimers()
    try {
      movedHandler({ payload: { x: -1200, y: 0 } })
      await vi.advanceTimersByTimeAsync(100)
    } finally {
      vi.useRealTimers()
    }

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(invokeMock).toHaveBeenLastCalledWith('position_cloud_authorization_window')
  })

  test('keeps the authorization window on a monitor with a negative origin', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    currentWindowMocks.outerPosition.mockResolvedValue({ x: -1700, y: 100 })
    monitorMocks.currentMonitor.mockResolvedValue({
      name: 'Left',
      position: { x: -1920, y: 0 },
      size: { width: 1920, height: 1080 },
      workArea: {
        position: { x: -1920, y: 0 },
        size: { width: 1920, height: 1080 },
      },
      scaleFactor: 1,
    })

    await openCloudAuthorizationWindow('https://cloud.example.com/auth/wework/authorize')

    expect(webviewWindowMocks.constructorMock).toHaveBeenCalledWith(
      'cloud-authorization',
      expect.objectContaining({
        x: -1500,
        y: 244,
        center: false,
      })
    )
  })

  test('clamps the authorization window to the current monitor work area', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    currentWindowMocks.outerPosition.mockResolvedValue({ x: 1700, y: 900 })

    await openCloudAuthorizationWindow('https://cloud.example.com/auth/wework/authorize')

    expect(webviewWindowMocks.constructorMock).toHaveBeenCalledWith(
      'cloud-authorization',
      expect.objectContaining({
        x: 920,
        y: 440,
        center: false,
      })
    )
  })

  test('converts a scaled monitor work area back to logical coordinates', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    currentWindowMocks.outerPosition.mockResolvedValue({ x: 4000, y: 200 })
    currentWindowMocks.outerSize.mockResolvedValue({ width: 2200, height: 1200 })
    monitorMocks.currentMonitor.mockResolvedValue({
      name: 'Scaled',
      position: { x: 3840, y: 0 },
      size: { width: 2560, height: 1440 },
      workArea: {
        position: { x: 3840, y: 0 },
        size: { width: 2560, height: 1440 },
      },
      scaleFactor: 2,
    })
    await openCloudAuthorizationWindow('https://cloud.example.com/auth/wework/authorize')

    expect(webviewWindowMocks.constructorMock).toHaveBeenCalledWith(
      'cloud-authorization',
      expect.objectContaining({
        x: 2050,
        y: 44,
        center: false,
      })
    )
  })

  test('centers the authorization window on the primary monitor when no current monitor exists', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    monitorMocks.currentMonitor.mockResolvedValue(null)
    monitorMocks.primaryMonitor.mockResolvedValue({
      name: 'Primary',
      position: { x: 0, y: 0 },
      size: { width: 1440, height: 900 },
      workArea: {
        position: { x: 0, y: 25 },
        size: { width: 1440, height: 875 },
      },
      scaleFactor: 1,
    })

    await openCloudAuthorizationWindow('https://cloud.example.com/auth/wework/authorize')

    expect(webviewWindowMocks.constructorMock).toHaveBeenCalledWith(
      'cloud-authorization',
      expect.objectContaining({
        x: 220,
        y: 107,
        center: false,
      })
    )
  })

  test('destroys the authorization window when close is blocked', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    webviewWindowMocks.closeMock.mockRejectedValue(new Error('close not allowed'))

    const handle = await openCloudAuthorizationWindow(
      'https://cloud.example.com/auth/wework/authorize'
    )
    await handle?.close?.()

    expect(webviewWindowMocks.closeMock).toHaveBeenCalled()
    expect(webviewWindowMocks.destroyMock).toHaveBeenCalled()
  })

  test('closes the authorization window when enabling always-on-top fails', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    webviewWindowMocks.setAlwaysOnTopMock.mockRejectedValue(new Error('always-on-top not allowed'))

    await expect(
      openCloudAuthorizationWindow('https://cloud.example.com/auth/wework/authorize')
    ).rejects.toThrow('always-on-top not allowed')

    expect(webviewWindowMocks.closeMock).toHaveBeenCalled()
    expect(webviewWindowMocks.onCloseRequestedMock).not.toHaveBeenCalled()
  })

  test('closes the authorization window when native positioning fails', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockRejectedValue(new Error('native positioning failed'))

    await expect(
      openCloudAuthorizationWindow('https://cloud.example.com/auth/wework/authorize')
    ).rejects.toThrow('native positioning failed')

    expect(webviewWindowMocks.closeMock).toHaveBeenCalled()
    expect(webviewWindowMocks.showMock).not.toHaveBeenCalled()
    expect(webviewWindowMocks.onCloseRequestedMock).not.toHaveBeenCalled()
  })
})
