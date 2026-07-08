import { beforeEach, describe, expect, test, vi } from 'vitest'
import { openExternalUrl } from './external-links'
import { isTauriRuntime } from './runtime-environment'
import { openCloudAuthorizationWindow } from './cloud-authorization-window'

const webviewWindowMocks = vi.hoisted(() => {
  const constructorMock = vi.fn()
  const existingCloseMock = vi.fn()
  const getByLabelMock = vi.fn()
  const setFocusMock = vi.fn()
  const closeMock = vi.fn()
  const destroyMock = vi.fn()
  const onCloseRequestedMock = vi.fn()
  const onceMock = vi.fn()

  return {
    constructorMock,
    existingCloseMock,
    getByLabelMock,
    setFocusMock,
    closeMock,
    destroyMock,
    onCloseRequestedMock,
    onceMock,
  }
})

const currentWindowMocks = vi.hoisted(() => ({
  outerPosition: vi.fn(),
  outerSize: vi.fn(),
  scaleFactor: vi.fn(),
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
    onCloseRequested = webviewWindowMocks.onCloseRequestedMock
    once = webviewWindowMocks.onceMock

    constructor(label: string, options: Record<string, unknown>) {
      webviewWindowMocks.constructorMock(label, options)
    }
  }

  return { WebviewWindow }
})

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => currentWindowMocks,
}))

const isTauriRuntimeMock = vi.mocked(isTauriRuntime)
const openExternalUrlMock = vi.mocked(openExternalUrl)

describe('openCloudAuthorizationWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isTauriRuntimeMock.mockReturnValue(false)
    openExternalUrlMock.mockResolvedValue(true)
    webviewWindowMocks.getByLabelMock.mockResolvedValue(null)
    webviewWindowMocks.existingCloseMock.mockResolvedValue(undefined)
    webviewWindowMocks.closeMock.mockResolvedValue(undefined)
    webviewWindowMocks.destroyMock.mockResolvedValue(undefined)
    webviewWindowMocks.setFocusMock.mockResolvedValue(undefined)
    webviewWindowMocks.onCloseRequestedMock.mockResolvedValue(vi.fn())
    currentWindowMocks.outerPosition.mockResolvedValue({ x: 200, y: 100 })
    currentWindowMocks.outerSize.mockResolvedValue({ width: 1400, height: 1000 })
    currentWindowMocks.scaleFactor.mockResolvedValue(1)
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
      openCloudAuthorizationWindow('https://cloud.example.com/wework/authorize')
    ).resolves.toEqual({
      closed: expect.any(Promise),
      close: expect.any(Function),
    })

    expect(webviewWindowMocks.existingCloseMock).toHaveBeenCalled()
    expect(webviewWindowMocks.constructorMock).toHaveBeenCalledWith(
      'cloud-authorization',
      expect.objectContaining({
        url: 'https://cloud.example.com/wework/authorize',
        title: 'Wegent Cloud',
        width: 520,
        height: 560,
        x: 640,
        y: 284,
        center: false,
        maximizable: false,
        focus: true,
        visible: true,
      })
    )
    expect(webviewWindowMocks.setFocusMock).toHaveBeenCalled()
    expect(webviewWindowMocks.onCloseRequestedMock).toHaveBeenCalled()
    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })

  test('closes the authorization window from the returned handle', async () => {
    isTauriRuntimeMock.mockReturnValue(true)

    const handle = await openCloudAuthorizationWindow('https://cloud.example.com/wework/authorize')
    await handle?.close?.()

    expect(webviewWindowMocks.closeMock).toHaveBeenCalled()
  })

  test('destroys the authorization window when close is blocked', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    webviewWindowMocks.closeMock.mockRejectedValue(new Error('close not allowed'))

    const handle = await openCloudAuthorizationWindow('https://cloud.example.com/wework/authorize')
    await handle?.close?.()

    expect(webviewWindowMocks.closeMock).toHaveBeenCalled()
    expect(webviewWindowMocks.destroyMock).toHaveBeenCalled()
  })
})
