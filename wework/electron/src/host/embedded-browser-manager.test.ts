import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WebContents } from 'electron'
import { EmbeddedBrowserManager, type BrowserHostEvent } from './embedded-browser-manager.js'

const electronMocks = vi.hoisted(() => ({
  appGetLocale: vi.fn(() => 'zh-CN'),
  createBackgroundWebContents: vi.fn(),
  browserSession: {
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

  test('applies request headers only to an exact HTTPS origin and path prefix', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    manager.setRequestHeaderRule({
      id: 'plugin:test',
      origins: ['https://auth.example.test'],
      pathPrefixes: ['/login'],
      headers: { Authorization: 'Bearer secret' },
    })
    const listener = electronMocks.browserSession.webRequest.onBeforeSendHeaders.mock.calls[0]?.[0]
    const matching = vi.fn()
    listener(
      {
        url: 'https://auth.example.test/login?service=example',
        requestHeaders: { Accept: 'text/html' },
      },
      matching
    )
    expect(matching).toHaveBeenCalledWith({
      requestHeaders: { Accept: 'text/html', Authorization: 'Bearer secret' },
    })
    const unrelated = vi.fn()
    listener(
      {
        url: 'https://other.example.test/login',
        requestHeaders: { Accept: 'text/html' },
      },
      unrelated
    )
    expect(unrelated).toHaveBeenCalledWith({ requestHeaders: { Accept: 'text/html' } })
    await rm(directory, { recursive: true, force: true })
  })

  test('requires an explicit opt-in before sending request headers over HTTP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)

    expect(() =>
      manager.setRequestHeaderRule({
        id: 'plugin:insecure-rejected',
        origins: ['http://auth.example.test'],
        pathPrefixes: ['/login'],
        headers: { Authorization: 'Bearer secret' },
      })
    ).toThrow('insecure HTTP is explicitly allowed')

    manager.setRequestHeaderRule({
      id: 'plugin:insecure-allowed',
      origins: ['http://auth.example.test'],
      pathPrefixes: ['/login'],
      headers: { Authorization: 'Bearer secret' },
      allowInsecure: true,
    })
    const listener = electronMocks.browserSession.webRequest.onBeforeSendHeaders.mock.calls[0]?.[0]
    const callback = vi.fn()
    listener(
      {
        url: 'http://auth.example.test/login',
        requestHeaders: { Accept: 'text/html' },
      },
      callback
    )
    expect(callback).toHaveBeenCalledWith({
      requestHeaders: { Accept: 'text/html', Authorization: 'Bearer secret' },
    })
    await rm(directory, { recursive: true, force: true })
  })

  test('owns hidden pages in the shared browser session without encoding a navigation flow', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const contents = new FakeWebContents()
    contents.isLoading.mockReturnValue(false)
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
      contents.emit('did-navigate', {}, url, 403, 'Forbidden')
    })
    electronMocks.createBackgroundWebContents.mockReturnValue(contents)
    const manager = new EmbeddedBrowserManager(directory)

    expect(manager.createBackgroundPage('plugin:test')).toMatchObject({
      id: 'plugin:test',
      url: 'about:blank',
      userAgent: 'Mozilla/5.0 Electron/43.4.1 Chrome/144.0.0.0',
    })
    expect(
      manager.setBackgroundPageUserAgent('plugin:test', 'Mozilla/5.0 Chrome/144.0.0.0')
    ).toMatchObject({
      userAgent: 'Mozilla/5.0 Chrome/144.0.0.0',
    })
    await expect(
      manager.navigateBackgroundPage('plugin:test', 'https://auth.example.test/login')
    ).resolves.toMatchObject({
      id: 'plugin:test',
      url: 'https://auth.example.test/login',
      isLoading: false,
      httpResponseCode: 403,
      httpStatusText: 'Forbidden',
    })
    manager.closeBackgroundPage('plugin:test')

    expect(contents.close).toHaveBeenCalledOnce()
    expect(() => manager.backgroundPageState('plugin:test')).toThrow(
      'Browser background page does not exist'
    )
    await rm(directory, { recursive: true, force: true })
  })

  test('publishes host cursor events and waits for renderer arrival', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))

    const moveSequence = manager.showAgentCursor('workspace-browser', 120, 80)
    const arrival = manager.waitForAgentCursorArrival('workspace-browser', moveSequence)
    manager.notifyAgentCursorArrived('workspace-browser', moveSequence)

    await expect(arrival).resolves.toBe(true)
    manager.hideAgentCursor('workspace-browser')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent-cursor',
          payload: expect.objectContaining({
            label: 'workspace-browser',
            visible: true,
            x: 120,
            y: 80,
            moveSequence,
          }),
        }),
        expect.objectContaining({
          type: 'agent-cursor',
          payload: expect.objectContaining({
            label: 'workspace-browser',
            visible: false,
            moveSequence,
          }),
        }),
      ])
    )
    await rm(directory, { recursive: true, force: true })
  })

  test('settles pending cursor arrival when the browser label changes', async () => {
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
    const moveSequence = manager.showAgentCursor('workspace-browser', 120, 80)
    const arrival = manager.waitForAgentCursorArrival('workspace-browser', moveSequence)

    manager.relabel('workspace-browser', 'workspace-browser-task-1')

    await expect(arrival).resolves.toBe(false)
    await rm(directory, { recursive: true, force: true })
  })

  test('keeps the host cursor visible briefly between adjacent agent actions', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))

    manager.emitAgentState('workspace-browser', 'running', { action: 'click' })
    manager.showAgentCursor('workspace-browser', 120, 80)
    manager.emitAgentState('workspace-browser', 'idle', { action: 'click' })

    expect(events.filter(event => event.type === 'agent-cursor').at(-1)?.payload).toMatchObject({
      visible: true,
    })

    vi.advanceTimersByTime(3_999)
    expect(events.filter(event => event.type === 'agent-cursor').at(-1)?.payload).toMatchObject({
      visible: true,
    })

    vi.advanceTimersByTime(1)
    expect(events.filter(event => event.type === 'agent-cursor').at(-1)?.payload).toMatchObject({
      visible: false,
    })

    vi.useRealTimers()
    await rm(directory, { recursive: true, force: true })
  })

  test('cancels a pending cursor hide when another agent action starts', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))

    manager.emitAgentState('workspace-browser', 'running', { action: 'click' })
    manager.showAgentCursor('workspace-browser', 120, 80)
    manager.emitAgentState('workspace-browser', 'idle', { action: 'click' })
    vi.advanceTimersByTime(2_000)

    manager.emitAgentState('workspace-browser', 'running', { action: 'click' })
    vi.advanceTimersByTime(4_000)

    expect(events.filter(event => event.type === 'agent-cursor').at(-1)?.payload).toMatchObject({
      visible: true,
    })

    manager.emitAgentState('workspace-browser', 'idle', { action: 'click' })
    vi.advanceTimersByTime(4_000)
    expect(events.filter(event => event.type === 'agent-cursor').at(-1)?.payload).toMatchObject({
      visible: false,
    })

    vi.useRealTimers()
    await rm(directory, { recursive: true, force: true })
  })

  test('pauses active agent control when the user presses the mouse in the page', async () => {
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
    manager.emitAgentState('workspace-browser', 'running', { action: 'waitFor' })

    contents.emit('before-mouse-event', {}, { type: 'mouseDown' })

    expect(manager.isAgentControlPaused('workspace-browser')).toBe(true)
    expect(events.at(-1)).toMatchObject({
      type: 'agent-state',
      payload: {
        label: 'workspace-browser',
        status: 'paused',
      },
    })
    await rm(directory, { recursive: true, force: true })
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

  test('keeps existing browser routes valid after relabeling a browser entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    const temporaryLabel = 'workspace-browser-blank-1'
    const taskLabel = 'workspace-browser-task-1'
    manager.attach(temporaryLabel, contents as unknown as WebContents)
    await manager.open({
      label: temporaryLabel,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    manager.setActiveTab(temporaryLabel, temporaryLabel)
    manager.setActiveTab('workspace-browser', temporaryLabel)

    manager.relabel(temporaryLabel, taskLabel)

    expect(manager.activeLabel(temporaryLabel)).toBe(taskLabel)
    expect(manager.activeLabel('workspace-browser')).toBe(taskLabel)
    expect(manager.state(manager.activeLabel(temporaryLabel))).toMatchObject({
      label: taskLabel,
      url: 'https://example.test/',
    })

    contents.close()
    expect(manager.has(taskLabel)).toBe(false)
    await rm(directory, { recursive: true, force: true })
  })

  test('settles a pending target open when relabeling an attached browser', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    const temporaryLabel = 'workspace-browser-blank-1'
    const taskLabel = 'workspace-browser-task-1'
    manager.attach(temporaryLabel, contents as unknown as WebContents)
    await manager.open({
      label: temporaryLabel,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    const pendingOpen = manager.open({
      label: taskLabel,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: false,
    })

    manager.relabel(temporaryLabel, taskLabel)

    await expect(pendingOpen).resolves.toMatchObject({
      label: taskLabel,
      url: 'https://example.test/',
    })
    manager.close(taskLabel)
    await rm(directory, { recursive: true, force: true })
  })

  test('clears migrated label state when the attached web contents is destroyed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
    })
    const temporaryLabel = 'workspace-browser-blank-1'
    const taskLabel = 'workspace-browser-task-1'
    manager.attach(temporaryLabel, contents as unknown as WebContents)
    await manager.open({
      label: temporaryLabel,
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })
    manager.setAgentControlPaused(temporaryLabel, true)
    manager.emitAgentState(temporaryLabel, 'running')
    manager.showAgentCursor(temporaryLabel, 120, 80)
    const approvalResult = {
      error: { code: 'approval_required' },
      approval: { actionKind: 'click' },
    }
    const approval = manager.registerAgentApproval(
      temporaryLabel,
      'click:button',
      'click',
      approvalResult
    )
    expect(approval).not.toBeNull()
    manager.resolveAgentApproval(temporaryLabel, approval?.approvalId ?? '', true)
    manager.relabel(temporaryLabel, taskLabel)

    contents.close()

    const internals = manager as unknown as {
      agentActive: Set<string>
      agentCursorStates: Map<string, unknown>
    }
    expect(manager.has(taskLabel)).toBe(false)
    expect(manager.isAgentControlPaused(taskLabel)).toBe(false)
    expect(manager.consumeApprovedAgentRisk(taskLabel, 'click:button')).toBe(false)
    expect(internals.agentActive.has(taskLabel)).toBe(false)
    expect(internals.agentCursorStates.has(taskLabel)).toBe(false)
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

  test('sends a focused native click to the embedded browser', async () => {
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

    manager.clickAt('workspace-browser', 120.4, 48.6)

    expect(contents.focus).toHaveBeenCalledOnce()
    expect(contents.sendInputEvent.mock.calls).toEqual([
      [{ type: 'mouseMove', x: 120, y: 49 }],
      [{ type: 'mouseDown', x: 120, y: 49, button: 'left', clickCount: 1 }],
      [{ type: 'mouseUp', x: 120, y: 49, button: 'left', clickCount: 1 }],
    ])
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
