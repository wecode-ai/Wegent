import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { BrowserWindow, WebFrameMain } from 'electron'
import type { SmartAppInstallation } from './smart-app-manager.js'

const state = vi.hoisted(() => ({
  views: [] as unknown[],
  windows: [] as unknown[],
  copy: vi.fn(async () => {}),
}))
vi.mock('../runtime/dsh-browser-auth.js', () => ({
  copyDshBrowserAuthentication: state.copy,
  dshBrowserRequestHeaders: (_url: string, headers: unknown) => headers,
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    destroyed = false
    loadURL = vi.fn(async () => {})
    setWindowOpenHandler = vi.fn()
    focus = vi.fn()
    isFocused = () => true
    isDestroyed = () => this.destroyed
    close = vi.fn(() => {
      this.destroyed = true
    })
  }
  class Window extends EventEmitter {
    webContents = new Contents()
    shown = false
    destroyed = false
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    constructor(readonly options: unknown) {
      super()
      state.windows.push(this)
    }
    getContentSize = () => [600, 400]
    show = () => {
      this.shown = true
    }
    hide = () => {
      this.shown = false
    }
    focus = vi.fn()
    isVisible = () => this.shown
    isFocused = () => true
    isDestroyed = () => this.destroyed
    destroy = () => {
      this.destroyed = true
    }
  }
  class View {
    webContents = new Contents()
    setBounds = vi.fn()
    setVisible = vi.fn()
    constructor(readonly options: unknown) {
      state.views.push(this)
    }
  }
  return {
    BrowserWindow: Window,
    WebContentsView: View,
    session: {
      defaultSession: {},
      fromPartition: () => ({
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn() },
      }),
    },
  }
})
import { createWorkbenchSurface } from './workbench-window.js'

beforeEach(() => {
  state.views.length = 0
  state.windows.length = 0
  state.copy.mockClear()
})
const installation = {
  id: 'calc',
  webUrl: 'http://127.0.0.1:1234/app/',
  manifest: { displayName: 'Calculator' },
} as SmartAppInstallation

describe('movable DSH workbench surface', () => {
  test('reparents one authenticated sandboxed page without reloading on presentation changes', async () => {
    const surface = createWorkbenchSurface(installation, vi.fn())
    await surface.ready
    surface.showWindow()
    const window = surface.window()!
    const parent = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      isVisible: () => true,
      isFocused: () => true,
    } as unknown as BrowserWindow
    const original = surface.contents
    surface.showTab(parent, { x: 25, y: 40, width: 700, height: 500 }, true)
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(state.views[0])
    expect(parent.contentView.addChildView).toHaveBeenCalledWith(state.views[0])
    surface.showWindow()
    expect(parent.contentView.removeChildView).toHaveBeenCalledWith(state.views[0])
    expect(surface.contents).toBe(original)
    expect(original.loadURL).toHaveBeenCalledExactlyOnceWith(installation.webUrl)
    expect(state.copy).toHaveBeenCalledOnce()
    expect(state.views).toHaveLength(1)
    expect(state.views[0]).toMatchObject({
      options: {
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          webviewTag: false,
          webSecurity: true,
        },
      },
    })
    surface.dispose()
    expect(original.close).toHaveBeenCalledOnce()
  })
  test('blocks cross-origin navigation and delegates close to the installation policy', async () => {
    const close = vi.fn()
    const surface = createWorkbenchSurface(installation, close)
    await surface.ready
    const event = { preventDefault: vi.fn() }
    surface.contents.emit('will-navigate', event, 'https://example.com')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    event.preventDefault.mockClear()
    surface.contents.emit('will-navigate', event, 'http://127.0.0.1:1234/another')
    expect(event.preventDefault).not.toHaveBeenCalled()
    surface.showWindow()
    surface.window()!.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    surface.dispose()
  })
  test('protects the initial lightweight document in the same view used by windows and tabs', async () => {
    const surface = createWorkbenchSurface(installation, vi.fn())
    await surface.ready
    const frame = {
      name: 'wework-workbench-lightweight',
      url: 'about:srcdoc',
      parent: null,
    } as WebFrameMain
    surface.contents.emit('frame-created', {}, { frame })
    frame.name = ''
    const event = {
      frame,
      initiator: frame,
      url: 'https://remote.test/',
      preventDefault: vi.fn(),
    }
    surface.contents.emit('will-frame-navigate', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    surface.dispose()
  })
})
