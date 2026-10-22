import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WebContents } from 'electron'
import { electronMocks, FakeWebContents } from '../../test-fixtures/embedded-browser.js'
import { EmbeddedBrowserManager, type BrowserHostEvent } from './embedded-browser-manager.js'

describe('EmbeddedBrowserManager navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test.each(['did-navigate', 'did-navigate-in-page'])(
    'preserves the pending destination when a late bootstrap %s arrives',
    async eventName => {
      const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
      const events: BrowserHostEvent[] = []
      const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
      const contents = new FakeWebContents()
      const targetUrl = 'https://pending.test/comment'
      let finishNavigation: (() => void) | undefined
      contents.loadURL.mockImplementation(
        url =>
          new Promise(resolve => {
            finishNavigation = () => {
              contents.commitUrl(url)
              contents.emit('did-navigate', {}, url)
              resolve()
            }
          })
      )
      manager.attach('workspace-browser', contents as unknown as WebContents)
      const opening = manager.open({
        label: 'workspace-browser',
        url: targetUrl,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        navigateExisting: true,
      })

      try {
        await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalledWith(targetUrl))
        expect(contents.getURL()).toBe('about:blank')
        expect(manager.state('workspace-browser').url).toBe(targetUrl)

        contents.emit(eventName, {}, 'about:blank', true)

        expect(manager.state('workspace-browser')).toMatchObject({
          url: targetUrl,
          isLoading: true,
          navigationError: null,
        })
        expect(events.filter(event => event.type === 'page-state').at(-1)?.payload).toMatchObject({
          url: targetUrl,
        })
      } finally {
        finishNavigation?.()
        await opening
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  test('accepts main-frame hash navigation without adopting a subframe URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const events: BrowserHostEvent[] = []
    const manager = new EmbeddedBrowserManager(directory, event => events.push(event))
    const contents = new FakeWebContents()
    const targetUrl = 'https://parent.test/comment'
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
      contents.emit('did-navigate', {}, url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)

    try {
      await manager.open({
        label: 'workspace-browser',
        url: targetUrl,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        navigateExisting: true,
      })
      events.length = 0

      contents.emit('did-navigate-in-page', {}, 'https://child.test/frame#reply', false)

      expect(manager.state('workspace-browser').url).toBe(targetUrl)
      expect(events.filter(event => event.type === 'page-state')).toEqual([])

      contents.commitUrl(`${targetUrl}#reply`)
      contents.emit('did-navigate-in-page', {}, `${targetUrl}#reply`, true)
      expect(manager.state('workspace-browser').url).toBe(`${targetUrl}#reply`)
      expect(events.filter(event => event.type === 'page-state').at(-1)?.payload).toMatchObject({
        url: `${targetUrl}#reply`,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('accepts an explicitly requested initial blank page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockImplementation(async url => {
      contents.commitUrl(url)
      contents.emit('did-navigate', {}, url)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)

    try {
      await expect(
        manager.open({
          label: 'workspace-browser',
          url: 'about:blank',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          visible: true,
          navigateExisting: true,
        })
      ).resolves.toMatchObject({ url: 'about:blank', navigationError: null })
      expect(contents.loadURL).toHaveBeenCalledWith('about:blank')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('adopts a committed redirect and accepts later navigation to blank', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    const redirectedUrl = 'https://redirected.test/comment'
    contents.loadURL.mockImplementation(async url => {
      const committedUrl = url === 'about:blank' ? url : redirectedUrl
      contents.commitUrl(committedUrl)
      contents.emit('did-navigate', {}, committedUrl)
    })
    manager.attach('workspace-browser', contents as unknown as WebContents)

    try {
      await expect(
        manager.open({
          label: 'workspace-browser',
          url: 'https://original.test/comment',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          visible: true,
          navigateExisting: true,
        })
      ).resolves.toMatchObject({ url: redirectedUrl, navigationError: null })

      await manager.navigate('workspace-browser', 'about:blank')

      expect(contents.loadURL).toHaveBeenLastCalledWith('about:blank')
      expect(manager.state('workspace-browser')).toMatchObject({
        url: 'about:blank',
        navigationError: null,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('ignores aborted load rejections instead of recording a navigation error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
    const manager = new EmbeddedBrowserManager(directory)
    const contents = new FakeWebContents()
    contents.loadURL.mockRejectedValue(
      new Error('ERR_ABORTED (-3) loading "https://example.test/"')
    )
    manager.attach('workspace-browser', contents as unknown as WebContents)

    const state = await manager.open({
      label: 'workspace-browser',
      url: 'https://example.test/',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      navigateExisting: true,
    })

    expect(state.navigationError).toBeNull()
    expect(manager.state('workspace-browser').navigationError).toBeNull()
    await rm(directory, { recursive: true, force: true })
  })

  test('clears a stale navigation error when a main-frame navigation commits', async () => {
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

    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.test/', true)
    expect(manager.state('workspace-browser').navigationError).toMatchObject({ code: -105 })

    contents.commitUrl('https://example.test/')
    contents.emit('did-navigate', {}, 'https://example.test/')
    expect(manager.state('workspace-browser').navigationError).toBeNull()
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

    contents.navigationHistory.canGoBack.mockReturnValue(true)
    expect(manager.state('workspace-browser').canGoBack).toBe(true)
    expect(manager.state('workspace-browser').canGoForward).toBe(false)

    finishNavigation?.()
    await expect(opening).resolves.toMatchObject({
      label: 'workspace-browser',
      url: 'https://example.test/',
    })
    await rm(directory, { recursive: true, force: true })
  })

  test.each(['about:blank', 'https://previous.test/'])(
    'removes only a bootstrap blank entry from initial history starting at %s',
    async firstUrl => {
      const directory = await mkdtemp(join(tmpdir(), 'wework-browser-manager-'))
      const manager = new EmbeddedBrowserManager(directory)
      const contents = new FakeWebContents()
      contents.loadURL.mockImplementation(async url => {
        contents.commitUrl(url)
        contents.emit('did-navigate', {}, url)
      })
      manager.attach('workspace-browser', contents as unknown as WebContents)
      try {
        await manager.open({
          label: 'workspace-browser',
          url: 'about:blank',
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          visible: true,
          navigateExisting: true,
        })
        expect(contents.navigationHistory.removeEntryAtIndex).not.toHaveBeenCalled()
        contents.navigationHistory.getActiveIndex.mockReturnValue(1)
        contents.navigationHistory.getEntryAtIndex.mockReturnValue({ url: firstUrl })
        contents.navigationHistory.canGoBack.mockReturnValue(true)
        contents.navigationHistory.removeEntryAtIndex.mockImplementation(() => {
          contents.navigationHistory.canGoBack.mockReturnValue(false)
          return true
        })
        await manager.navigate('workspace-browser', 'https://first.test/')
        const blankBootstrap = firstUrl === 'about:blank'
        expect(contents.navigationHistory.removeEntryAtIndex).toHaveBeenCalledTimes(
          blankBootstrap ? 1 : 0
        )
        if (blankBootstrap) {
          expect(contents.navigationHistory.removeEntryAtIndex).toHaveBeenCalledWith(0)
        }
        expect(manager.state('workspace-browser').canGoBack).toBe(!blankBootstrap)

        contents.navigationHistory.removeEntryAtIndex.mockClear()
        contents.navigationHistory.canGoBack.mockReturnValue(true)
        await manager.navigate('workspace-browser', 'https://second.test/')
        expect(contents.navigationHistory.removeEntryAtIndex).not.toHaveBeenCalled()
        expect(manager.state('workspace-browser').canGoBack).toBe(true)
        manager.goBack('workspace-browser')
        expect(contents.navigationHistory.goBack).toHaveBeenCalledOnce()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

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
})
