import { describe, expect, test, vi } from 'vitest'
import {
  installNativeContextMenu,
  type ImageContext,
  type NativeContextMenuContents,
  type NativeContextMenuItem,
  type NativeContextMenuMode,
  type NativeContextMenuParams,
  type NativeContextMenuState,
} from './image-context-menu.js'

function imageContext(localPath: string | null = null): ImageContext {
  return {
    filename: 'preview.png',
    localPath,
    sourceUrl: 'blob:preview',
  }
}

function setup(
  language = 'en-US',
  resolvedImage: ImageContext | null = imageContext(),
  mode: NativeContextMenuMode = 'app',
  state: NativeContextMenuState = { canGoBack: false, canGoForward: false, url: null }
) {
  let listener: ((event: unknown, params: NativeContextMenuParams) => void) | undefined
  const contents = {
    copyImageAt: vi.fn(),
    on: vi.fn((_event, nextListener) => {
      listener = nextListener
    }),
  } as NativeContextMenuContents
  const popup = vi.fn()
  const buildMenu = vi.fn((items: NativeContextMenuItem[]) => {
    void items
    return { popup }
  })
  const actions = {
    copyLink: vi.fn(),
    copyPath: vi.fn(),
    getState: vi.fn(() => state),
    goBack: vi.fn(),
    goForward: vi.fn(),
    inspect: vi.fn(),
    openExternal: vi.fn(),
    openImage: vi.fn(async () => undefined),
    openLinkInNewTab: vi.fn(),
    reloadPage: vi.fn(),
    reportError: vi.fn(),
    resolveImageContext: vi.fn(async () => resolvedImage),
    showItemInFolder: vi.fn(),
  }

  installNativeContextMenu(contents, buildMenu, actions, language, mode)

  return {
    actions,
    buildMenu,
    contents,
    popup,
    trigger: async (params: NativeContextMenuParams) => {
      listener?.({}, params)
      await vi.waitFor(() => {
        expect(buildMenu).toHaveBeenCalled()
      })
    },
  }
}

function imageParams(): NativeContextMenuParams {
  return { mediaType: 'image', selectionText: '', x: 120, y: 240 }
}

describe('installNativeContextMenu', () => {
  test('shows copy and open actions for a remote image', async () => {
    const { actions, buildMenu, contents, popup, trigger } = setup()

    await trigger(imageParams())

    expect(popup).toHaveBeenCalledOnce()
    const [items] = buildMenu.mock.calls[0] ?? []
    expect(items?.map(item => item.label ?? item.type)).toEqual([
      'Copy Image',
      'Open in Default Application',
    ])

    items?.[0]?.click?.()
    items?.[1]?.click?.()
    expect(contents.copyImageAt).toHaveBeenCalledWith(120, 240)
    await vi.waitFor(() => expect(actions.openImage).toHaveBeenCalledWith(imageContext()))
  })

  test('adds file actions for a local image', async () => {
    const localImage = imageContext('/tmp/preview.png')
    const { actions, buildMenu, trigger } = setup('en-US', localImage)

    await trigger(imageParams())

    const [items] = buildMenu.mock.calls[0] ?? []
    expect(items?.map(item => item.label ?? item.type)).toEqual([
      'Copy Image',
      'Open in Default Application',
      'separator',
      'Show in Finder / File Explorer',
      'Copy File Path',
    ])
    items?.[3]?.click?.()
    items?.[4]?.click?.()
    expect(actions.showItemInFolder).toHaveBeenCalledWith('/tmp/preview.png')
    expect(actions.copyPath).toHaveBeenCalledWith('/tmp/preview.png')
  })

  test('uses Chinese labels for image actions', async () => {
    const { buildMenu, trigger } = setup('zh-CN', imageContext('/tmp/preview.png'))

    await trigger(imageParams())

    const [items] = buildMenu.mock.calls[0] ?? []
    expect(items?.map(item => item.label ?? item.type)).toEqual([
      '复制图片',
      '在系统默认应用中打开',
      'separator',
      '在 Finder / 文件资源管理器中显示',
      '复制文件路径',
    ])
  })

  test('shows Copy for selected conversation text', async () => {
    const { buildMenu, popup, trigger } = setup()
    const frame = {}
    const params = {
      frame,
      mediaType: 'none',
      selectionText: 'selected response',
      x: 10,
      y: 20,
    }

    await trigger(params)

    const [items] = buildMenu.mock.calls[0] ?? []
    expect(items).toEqual([{ role: 'copy' }])
    expect(popup).toHaveBeenCalledWith({ frame })
  })

  test('shows native editing actions with availability from Chromium', async () => {
    const { buildMenu, popup, trigger } = setup()
    const frame = {}

    await trigger({
      editFlags: {
        canCopy: true,
        canCut: true,
        canDelete: true,
        canPaste: false,
        canRedo: false,
        canSelectAll: true,
        canUndo: true,
      },
      frame,
      isEditable: true,
      mediaType: 'none',
      selectionText: '',
      x: 10,
      y: 20,
    })

    const [items] = buildMenu.mock.calls[0] ?? []
    expect(items).toEqual([
      { role: 'undo', enabled: true },
      { role: 'redo', enabled: false },
      { type: 'separator' },
      { role: 'cut', enabled: true },
      { role: 'copy', enabled: true },
      { role: 'paste', enabled: false },
      { role: 'delete', enabled: true },
      { type: 'separator' },
      { role: 'selectAll', enabled: true },
    ])
    expect(popup).toHaveBeenCalledWith({ frame })
  })

  test('leaves non-image context menus without a selection untouched', async () => {
    const { buildMenu, popup, contents } = setup()
    const listener = contents.on.mock.calls[0]?.[1]

    listener?.({}, { mediaType: 'none', selectionText: '  ', x: 10, y: 20 })
    await Promise.resolve()

    expect(buildMenu).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
  })

  describe('browser mode', () => {
    function browserSetup(
      state: NativeContextMenuState = {
        canGoBack: true,
        canGoForward: false,
        url: 'https://example.com/page',
      },
      resolvedImage: ImageContext | null = imageContext()
    ) {
      return setup('en-US', resolvedImage, 'browser', state)
    }

    test('shows navigation and inspect on a blank page area', async () => {
      const { actions, buildMenu, popup, trigger } = browserSetup()

      await trigger({ mediaType: 'none', selectionText: '', x: 10, y: 20 })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.role ?? item.type)).toEqual([
        'Back',
        'Forward',
        'Reload',
        'Open in External Browser',
        'separator',
        'Inspect',
      ])
      expect(items?.[0]?.enabled).toBe(true)
      expect(items?.[1]?.enabled).toBe(false)
      expect(popup).toHaveBeenCalledWith({ frame: undefined })

      items?.[0]?.click?.()
      items?.[2]?.click?.()
      items?.[3]?.click?.()
      items?.[5]?.click?.()
      expect(actions.goBack).toHaveBeenCalledOnce()
      expect(actions.reloadPage).toHaveBeenCalledOnce()
      expect(actions.openExternal).toHaveBeenCalledWith('https://example.com/page')
      expect(actions.inspect).toHaveBeenCalledWith(10, 20)
    })

    test('omits open-external when the page URL is not http(s)', async () => {
      const { buildMenu, trigger } = browserSetup({
        canGoBack: false,
        canGoForward: false,
        url: 'about:blank',
      })

      await trigger({ mediaType: 'none', selectionText: '', x: 10, y: 20 })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        'Back',
        'Forward',
        'Reload',
        'separator',
        'Inspect',
      ])
    })

    test('shows link actions before navigation on a link', async () => {
      const { actions, buildMenu, trigger } = browserSetup()

      await trigger({
        linkURL: 'https://example.com/target',
        mediaType: 'none',
        selectionText: '',
        x: 10,
        y: 20,
      })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        'Open Link in New Tab',
        'Open in External Browser',
        'Copy Link Address',
        'separator',
        'Back',
        'Forward',
        'Reload',
        'Open in External Browser',
        'separator',
        'Inspect',
      ])

      items?.[0]?.click?.()
      items?.[1]?.click?.()
      items?.[2]?.click?.()
      expect(actions.openLinkInNewTab).toHaveBeenCalledWith('https://example.com/target')
      expect(actions.openExternal).toHaveBeenCalledWith('https://example.com/target')
      expect(actions.copyLink).toHaveBeenCalledWith('https://example.com/target')
    })

    test('ignores non-http link URLs', async () => {
      const { buildMenu, trigger } = browserSetup()

      await trigger({
        linkURL: 'javascript:void(0)',
        mediaType: 'none',
        selectionText: '',
        x: 10,
        y: 20,
      })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        'Back',
        'Forward',
        'Reload',
        'Open in External Browser',
        'separator',
        'Inspect',
      ])
    })

    test('shows only link and image groups for a link wrapping an image', async () => {
      const { buildMenu, trigger } = browserSetup()

      await trigger({
        linkURL: 'https://example.com/target',
        mediaType: 'image',
        selectionText: '',
        x: 10,
        y: 20,
      })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        'Open Link in New Tab',
        'Open in External Browser',
        'Copy Link Address',
        'separator',
        'Copy Image',
        'Open in Default Application',
      ])
    })

    test('falls back to navigation when the image context cannot be resolved', async () => {
      const { buildMenu, trigger } = browserSetup(
        { canGoBack: false, canGoForward: false, url: null },
        null
      )

      await trigger({ mediaType: 'image', selectionText: '', x: 10, y: 20 })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        'Back',
        'Forward',
        'Reload',
        'separator',
        'Inspect',
      ])
    })

    test('shows copy and inspect for selected text', async () => {
      const { buildMenu, trigger } = browserSetup()

      await trigger({ mediaType: 'none', selectionText: 'hello', x: 10, y: 20 })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items).toEqual([
        { role: 'copy' },
        { type: 'separator' },
        { label: 'Inspect', click: expect.any(Function) },
      ])
    })

    test('keeps the editing menu unchanged in browser mode', async () => {
      const { buildMenu, trigger } = browserSetup()

      await trigger({
        editFlags: {
          canCopy: true,
          canCut: true,
          canDelete: true,
          canPaste: true,
          canRedo: true,
          canSelectAll: true,
          canUndo: true,
        },
        isEditable: true,
        linkURL: 'https://example.com/target',
        mediaType: 'none',
        selectionText: '',
        x: 10,
        y: 20,
      })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.every(item => item.role || item.type === 'separator')).toBe(true)
    })

    test('uses Chinese labels for browser actions', async () => {
      const { buildMenu, trigger } = setup('zh-CN', imageContext(), 'browser', {
        canGoBack: false,
        canGoForward: false,
        url: null,
      })

      await trigger({ mediaType: 'none', selectionText: '', x: 10, y: 20 })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        '返回',
        '前进',
        '重新加载',
        'separator',
        '检查',
      ])
    })
  })
})
