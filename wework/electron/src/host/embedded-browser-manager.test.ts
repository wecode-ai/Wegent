import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WebContents } from 'electron'
import { EmbeddedBrowserManager, type BrowserHostEvent } from './embedded-browser-manager.js'

const electronMocks = vi.hoisted(() => ({
  appGetLocale: vi.fn(() => 'zh-CN'),
  browserSession: {
    clearCache: vi.fn(),
    clearStorageData: vi.fn(),
    on: vi.fn(),
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
  Menu: {
    buildFromTemplate: electronMocks.menuBuildFromTemplate,
  },
  session: {
    fromPartition: vi.fn(() => electronMocks.browserSession),
  },
  shell: {
    openExternal: vi.fn(),
  },
}))

class FakeWebContents extends EventEmitter {
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
  }
  private destroyed = false
  private url = 'about:blank'

  close = vi.fn(() => {
    this.destroyed = true
    this.emit('destroyed')
  })
  executeJavaScript = vi.fn()
  getTitle = vi.fn(() => '')
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
  setWindowOpenHandler = vi.fn()
  setZoomFactor = vi.fn()
  devToolsWebContents: object | null = {}
  private devToolsOpened = false

  commitUrl(url: string): void {
    this.url = url
  }
}

function emitBeforeInput(
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

describe('EmbeddedBrowserManager lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('registers an attached browser before its initial navigation settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    let finishNavigation: (() => void) | undefined
    contents.loadURL.mockImplementation(
      url =>
        new Promise(resolve => {
          contents.commitUrl(url)
          finishNavigation = resolve
        })
    )
    manager.attach('workspace-browser', contents as unknown as WebContents)

    const opening = manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalledOnce())

    expect(manager.has('workspace-browser')).toBe(true)
    expect(manager.state('workspace-browser').url).toBe('https://example.test/')
    expect(manager.state('workspace-browser').visible).toBe(true)

    finishNavigation?.()
    await expect(opening).resolves.toMatchObject({
      label: 'workspace-browser',
      url: 'https://example.test/',
    })
    await rm(directory, { recursive: true, force: true })
  })

  test('toggles the detached Inspector with a bare F12 keydown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    const openEvent = emitBeforeInput(contents)

    expect(openEvent.preventDefault).toHaveBeenCalledOnce()
    expect(contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })

    const closeEvent = emitBeforeInput(contents)

    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(contents.closeDevTools).toHaveBeenCalledOnce()
    await rm(directory, { recursive: true, force: true })
  })

  test('leaves modified and repeated F12 input to the browser page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    const events = [
      emitBeforeInput(contents, { shift: true }),
      emitBeforeInput(contents, { isAutoRepeat: true }),
      emitBeforeInput(contents, { type: 'keyUp' }),
    ]

    for (const event of events) expect(event.preventDefault).not.toHaveBeenCalled()
    expect(contents.openDevTools).not.toHaveBeenCalled()
    expect(contents.closeDevTools).not.toHaveBeenCalled()
    await rm(directory, { recursive: true, force: true })
  })

  test('shows the browser context menu and routes its actions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    contents.emit(
      'context-menu',
      {},
      {
        x: 80,
        y: 120,
        isEditable: false,
        formControlType: 'none',
        mediaType: 'none',
        linkURL: '',
        srcURL: '',
        selectionText: '',
      }
    )

    const items = electronMocks.menuBuildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
      click?: () => void
      enabled?: boolean
      label?: string
      type?: string
    }>
    expect(items.map(item => item.label ?? item.type)).toEqual([
      '快速评论',
      '评论',
      'separator',
      '返回',
      '前进',
      '重新加载',
      'separator',
      '检查',
    ])
    expect(items[3]).toMatchObject({ enabled: false })
    expect(items[4]).toMatchObject({ enabled: false })
    expect(electronMocks.menuPopup).toHaveBeenCalledOnce()

    items[0].click?.()
    items[1].click?.()
    items[5].click?.()
    items[7].click?.()

    expect(contents.reload).toHaveBeenCalledOnce()
    expect(contents.inspectElement).toHaveBeenCalledWith(80, 120)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'annotation-request',
          payload: expect.objectContaining({
            label: 'workspace-browser',
            mode: 'quick',
            x: 80,
            y: 120,
          }),
        }),
        expect.objectContaining({
          type: 'annotation-request',
          payload: expect.objectContaining({
            label: 'workspace-browser',
            mode: 'batch',
            x: 80,
            y: 120,
          }),
        }),
      ])
    )
    await rm(directory, { recursive: true, force: true })
  })

  test('omits navigation actions for a non-plain browser context', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    contents.emit(
      'context-menu',
      {},
      {
        x: 20,
        y: 30,
        isEditable: false,
        formControlType: 'none',
        mediaType: 'none',
        linkURL: 'https://example.test/linked',
        srcURL: '',
        selectionText: '',
      }
    )

    const items = electronMocks.menuBuildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
      label?: string
      type?: string
    }>
    expect(items.map(item => item.label ?? item.type)).toEqual([
      '快速评论',
      '评论',
      'separator',
      '检查',
    ])
    await rm(directory, { recursive: true, force: true })
  })

  test('routes a popup to the current logical label and native browser identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    const nativeLabel = manager.state('workspace-browser').nativeLabel
    manager.relabel('workspace-browser', 'workspace-browser-task-1')

    const windowOpenHandler = contents.setWindowOpenHandler.mock.calls[0]?.[0] as
      | ((details: { url: string }) => { action: string })
      | undefined
    expect(windowOpenHandler?.({ url: 'https://example.test/linked-page' })).toEqual({
      action: 'deny',
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'popup',
        payload: expect.objectContaining({
          parentLabel: 'workspace-browser-task-1',
          parentNativeLabel: nativeLabel,
          strategy: 'new-tab',
          url: 'https://example.test/linked-page',
        }),
      })
    )
    await rm(directory, { recursive: true, force: true })
  })

  test('ignores page state events from a replaced browser with the same label', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    const previousContents = new FakeWebContents()
    previousContents.loadURL.mockImplementation(async url => {
      previousContents.commitUrl(url)
    })
    manager.attach('workspace-browser', previousContents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://previous.example/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    manager.close('workspace-browser')
    const currentContents = new FakeWebContents()
    currentContents.loadURL.mockImplementation(async url => {
      currentContents.commitUrl(url)
    })
    manager.attach('workspace-browser', currentContents as unknown as WebContents)
    await manager.open({
      label: 'workspace-browser',
      url: 'https://current.example/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    events.length = 0

    previousContents.emit('did-stop-loading')
    expect(events).toEqual([])

    currentContents.emit('did-stop-loading')
    expect(events).toEqual([
      expect.objectContaining({
        type: 'page-state',
        payload: expect.objectContaining({
          label: 'workspace-browser',
          url: 'https://current.example/',
        }),
      }),
    ])
    await rm(directory, { recursive: true, force: true })
  })

  test('replaces an attached browser and ignores a stale identity-scoped close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const previousContents = new FakeWebContents()
    previousContents.loadURL.mockImplementation(async url => {
      previousContents.commitUrl(url)
    })
    manager.attach('smart-app:test', previousContents as unknown as WebContents)
    const previousState = await manager.open({
      label: 'smart-app:test',
      url: 'https://previous.example/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    const currentContents = new FakeWebContents()
    currentContents.loadURL.mockImplementation(async url => {
      currentContents.commitUrl(url)
    })
    manager.attach('smart-app:test', currentContents as unknown as WebContents)
    const currentState = await manager.open({
      label: 'smart-app:test',
      url: 'https://current.example/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    expect(previousContents.close).toHaveBeenCalledOnce()
    expect(currentState.nativeLabel).not.toBe(previousState.nativeLabel)
    manager.close('smart-app:test', previousState.nativeLabel)
    expect(manager.state('smart-app:test')).toMatchObject({
      nativeLabel: currentState.nativeLabel,
      url: 'https://current.example/',
    })

    manager.close('smart-app:test', currentState.nativeLabel)
    expect(currentContents.close).toHaveBeenCalledOnce()
    await rm(directory, { recursive: true, force: true })
  })

  test('records, searches, removes, and clears persisted browser history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.getTitle.mockReturnValue('Electron Docs')
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
      contents.emit('did-start-navigation', {}, url, false, true)
      contents.emit('did-finish-load')
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)

    await manager.open({
      label: 'workspace-browser',
      url: 'https://electronjs.org/docs',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    await vi.waitFor(async () =>
      expect(
        await manager.searchHistory({
          text: 'ELECTRON',
          endTimeMs: null,
          offset: 0,
          maxResults: 100,
        })
      ).toHaveLength(1)
    )
    const [entry] = await manager.searchHistory({
      text: 'docs',
      endTimeMs: null,
      offset: 0,
      maxResults: 100,
    })
    expect(entry).toMatchObject({
      url: 'https://electronjs.org/docs',
      title: 'Electron Docs',
    })
    expect(await manager.removeHistory([entry.id])).toBe(1)
    expect(
      await manager.searchHistory({ text: '', endTimeMs: null, offset: 0, maxResults: 100 })
    ).toEqual([])

    contents.getTitle.mockReturnValue('')
    await manager.navigate('workspace-browser', 'https://example.test/')
    await vi.waitFor(async () =>
      expect(
        await manager.searchHistory({ text: '', endTimeMs: null, offset: 0, maxResults: 100 })
      ).toHaveLength(1)
    )
    await manager.clearData(['history'])
    expect(electronMocks.browserSession.clearStorageData).not.toHaveBeenCalled()
    expect(
      await manager.searchHistory({ text: '', endTimeMs: null, offset: 0, maxResults: 100 })
    ).toEqual([])
    expect(JSON.parse(await readFile(join(directory, 'browser-history.json'), 'utf8'))).toEqual([])
    await rm(directory, { recursive: true, force: true })
  })

  test('captures an embedded browser through Electron before using the CDP fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    contents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      toDataURL: () => 'data:image/png;base64,native-embedded-browser',
    })
    contents.debugger.sendCommand.mockRejectedValue(new Error('UnknownVizError'))
    manager.attach('smart-app:test', contents as unknown as WebContents)

    await manager.open({
      label: 'smart-app:test',
      url: 'http://127.0.0.1:3080/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    await expect(manager.capture('smart-app:test')).resolves.toBe(
      'data:image/png;base64,native-embedded-browser'
    )
    expect(contents.capturePage).toHaveBeenCalledOnce()
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled()
    await rm(directory, { recursive: true, force: true })
  })

  test('waits for browser layout to settle before verifying a detached Inspector', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    try {
      const manager = new EmbeddedBrowserManager(directory)
      const contents = new FakeWebContents()
      contents.loadURL.mockImplementation(async url => {
        contents.commitUrl(url)
      })
      manager.attach('workspace-browser', contents as unknown as WebContents)
      await manager.open({
        label: 'workspace-browser',
        url: 'https://example.test/',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        navigateExisting: true,
      })

      const verification = manager.verifyDetachedInspector('workspace-browser')
      setTimeout(() => {
        manager.setBounds('workspace-browser', { x: 0, y: 0, width: 801, height: 600 }, true)
      }, 600)
      await vi.advanceTimersByTimeAsync(2_500)

      await expect(verification).resolves.toMatchObject({
        beforeFrame: [0, 0, 801, 600],
        afterFrame: [0, 0, 801, 600],
        visible: true,
        closedVisible: false,
      })
      expect(contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })
      expect(contents.closeDevTools).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
