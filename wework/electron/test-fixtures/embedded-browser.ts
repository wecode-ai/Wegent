import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  authCookiesGet: vi.fn(),
  authCookiesSet: vi.fn(),
  appGetLocale: vi.fn(() => 'zh-CN'),
  createBackgroundWebContents: vi.fn(),
  browserSession: {
    cookies: { set: (...args: unknown[]) => electronMocks.authCookiesSet(...args) },
    clearCache: vi.fn(),
    clearStorageData: vi.fn(),
    on: vi.fn(),
    webRequest: {
      onBeforeSendHeaders: vi.fn(),
    },
  },
  menuPopup: vi.fn(),
  menuBuildFromTemplate: vi.fn((items: unknown[]) => ({
    items,
    popup: electronMocks.menuPopup,
  })),
}))

vi.mock('electron', () => ({
  app: {
    getLocale: electronMocks.appGetLocale,
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  WebContentsView: class {
    readonly webContents = electronMocks.createBackgroundWebContents()
  },
  Menu: {
    buildFromTemplate: electronMocks.menuBuildFromTemplate,
  },
  session: {
    defaultSession: {
      cookies: { get: (...args: unknown[]) => electronMocks.authCookiesGet(...args) },
    },
    fromPartition: vi.fn(() => electronMocks.browserSession),
  },
  shell: {
    openExternal: vi.fn(),
  },
}))

export class FakeWebContents extends EventEmitter {
  private static nextId = 1
  readonly id = FakeWebContents.nextId++
  readonly debugger = {
    attach: vi.fn(),
    detach: vi.fn(),
    isAttached: vi.fn(() => false),
    sendCommand: vi.fn(),
  }
  readonly navigationHistory = {
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    getActiveIndex: vi.fn(() => 0),
    getEntryAtIndex: vi.fn(() => ({ url: 'about:blank' })),
    removeEntryAtIndex: vi.fn(() => true),
  }
  private destroyed = false
  private url = 'about:blank'

  close = vi.fn(() => {
    this.destroyed = true
    this.emit('destroyed')
  })
  executeJavaScript = vi.fn()
  focus = vi.fn()
  getTitle = vi.fn(() => '')
  getUserAgent = vi.fn(() => 'Mozilla/5.0 Electron/43.4.1 Chrome/144.0.0.0')
  getURL = vi.fn(() => this.url)
  inspectElement = vi.fn()
  isDestroyed = vi.fn(() => this.destroyed)
  isDevToolsOpened = vi.fn(() => this.devToolsOpened)
  isLoading = vi.fn(() => true)
  loadURL = vi.fn<(url: string) => Promise<void>>()
  openDevTools = vi.fn(() => {
    this.devToolsOpened = true
  })
  closeDevTools = vi.fn(() => {
    this.devToolsOpened = false
  })
  capturePage = vi.fn()
  reload = vi.fn()
  sendInputEvent = vi.fn()
  setWindowOpenHandler = vi.fn()
  setUserAgent = vi.fn((userAgent: string) => {
    this.getUserAgent.mockReturnValue(userAgent)
  })
  setZoomFactor = vi.fn()
  devToolsWebContents: object | null = {}
  private devToolsOpened = false

  commitUrl(url: string): void {
    this.url = url
  }
}

export function emitBeforeInput(
  contents: FakeWebContents,
  input: Partial<{
    type: string
    key: string
    code: string
    isAutoRepeat: boolean
    isComposing: boolean
    alt: boolean
    control: boolean
    meta: boolean
    shift: boolean
  }> = {}
) {
  const event = { preventDefault: vi.fn() }
  contents.emit('before-input-event', event, {
    type: 'keyDown',
    key: 'F12',
    code: 'F12',
    isAutoRepeat: false,
    isComposing: false,
    alt: false,
    control: false,
    meta: false,
    shift: false,
    ...input,
  })
  return event
}

export { electronMocks }
