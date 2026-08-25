import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WebContents } from 'electron'
import { EmbeddedBrowserManager } from './embedded-browser-manager.js'

const electronMocks = vi.hoisted(() => ({
  browserSession: {
    clearCache: vi.fn(),
    clearStorageData: vi.fn(),
    on: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition: vi.fn(() => electronMocks.browserSession),
  },
  shell: {
    openExternal: vi.fn(),
  },
}))

class FakeWebContents extends EventEmitter {
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
  isDestroyed = vi.fn(() => this.destroyed)
  isLoading = vi.fn(() => true)
  loadURL = vi.fn<(url: string) => Promise<void>>()
  capturePage = vi.fn()
  reload = vi.fn()
  setWindowOpenHandler = vi.fn()
  setZoomFactor = vi.fn()

  commitUrl(url: string): void {
    this.url = url
  }
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

    finishNavigation?.()
    await expect(opening).resolves.toMatchObject({
      label: 'workspace-browser',
      url: 'https://example.test/',
    })
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
})
