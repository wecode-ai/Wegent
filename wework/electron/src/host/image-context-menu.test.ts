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
  state: NativeContextMenuState = { canGoBack: false, canGoForward: false }
) {
  let listener: ((event: unknown, params: NativeContextMenuParams) => void) | undefined
  const contents = {
    copy: vi.fn(),
    copyImageAt: vi.fn(),
    cut: vi.fn(),
    delete: vi.fn(),
    downloadURL: vi.fn(),
    on: vi.fn((_event, nextListener) => {
      listener = nextListener
    }),
    paste: vi.fn(),
    redo: vi.fn(),
    selectAll: vi.fn(),
    undo: vi.fn(),
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
    const { buildMenu, contents, popup, trigger } = setup()
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
    expect(items?.map(item => item.label)).toEqual(['Copy'])
    items?.[0]?.click?.()
    expect(contents.copy).toHaveBeenCalledOnce()
    expect(popup).toHaveBeenCalledWith({ frame })
  })

  test('shows editing actions with availability from Chromium', async () => {
    const { buildMenu, contents, popup, trigger } = setup()
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
    expect(items?.map(item => `${item.label ?? item.type}:${item.enabled ?? true}`)).toEqual([
      'Undo:true',
      'Redo:false',
      'separator:true',
      'Cut:true',
      'Copy:true',
      'Paste:false',
      'Delete:true',
      'separator:true',
      'Select All:true',
    ])
    items?.[3]?.click?.()
    items?.[4]?.click?.()
    items?.[5]?.click?.()
    expect(contents.cut).toHaveBeenCalledOnce()
    expect(contents.copy).toHaveBeenCalledOnce()
    expect(contents.paste).toHaveBeenCalledOnce()
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
      state: NativeContextMenuState = { canGoBack: true, canGoForward: false }
    ) {
      return setup('en-US', imageContext(), 'browser', state)
    }

    test('shows navigation and inspect on a blank page area', async () => {
      const { actions, buildMenu, popup, trigger } = browserSetup()

      await trigger({ mediaType: 'none', selectionText: '', x: 10, y: 20 })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        'Back',
        'Forward',
        'Reload',
        'separator',
        'Inspect',
      ])
      expect(items?.[0]?.enabled).toBe(true)
      expect(items?.[1]?.enabled).toBe(false)
      expect(popup).toHaveBeenCalledWith({ frame: undefined })

      items?.[0]?.click?.()
      items?.[2]?.click?.()
      items?.[4]?.click?.()
      expect(actions.goBack).toHaveBeenCalledOnce()
      expect(actions.reloadPage).toHaveBeenCalledOnce()
      expect(actions.inspect).toHaveBeenCalledWith(10, 20)
    })

    test('shows link groups on a link', async () => {
      const { actions, buildMenu, contents, trigger } = browserSetup()

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
        'separator',
        'Copy Link Address',
        'separator',
        'Save Link As...',
        'separator',
        'Inspect',
      ])

      items?.[0]?.click?.()
      items?.[1]?.click?.()
      items?.[3]?.click?.()
      items?.[5]?.click?.()
      expect(actions.openLinkInNewTab).toHaveBeenCalledWith('https://example.com/target')
      expect(actions.openExternal).toHaveBeenCalledWith('https://example.com/target')
      expect(actions.copyLink).toHaveBeenCalledWith('https://example.com/target')
      expect(contents.downloadURL).toHaveBeenCalledWith('https://example.com/target')
    })

    test('adds copy to the link menu when text is selected', async () => {
      const { buildMenu, contents, trigger } = browserSetup()

      await trigger({
        linkURL: 'https://example.com/target',
        mediaType: 'none',
        selectionText: 'link text',
        x: 10,
        y: 20,
      })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toContain('Copy')
      items?.find(item => item.label === 'Copy')?.click?.()
      expect(contents.copy).toHaveBeenCalledOnce()
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
        'separator',
        'Inspect',
      ])
    })

    test('shows image actions for an image', async () => {
      const { actions, buildMenu, contents, trigger } = browserSetup()

      await trigger({
        mediaType: 'image',
        selectionText: '',
        srcURL: 'https://example.com/pic.png',
        x: 10,
        y: 20,
      })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        'Open Image in New Tab',
        'Save Image As...',
        'Copy Image',
        'Copy Image Address',
        'separator',
        'Inspect',
      ])

      items?.[0]?.click?.()
      items?.[1]?.click?.()
      items?.[2]?.click?.()
      items?.[3]?.click?.()
      expect(actions.openLinkInNewTab).toHaveBeenCalledWith('https://example.com/pic.png')
      expect(contents.downloadURL).toHaveBeenCalledWith('https://example.com/pic.png')
      expect(contents.copyImageAt).toHaveBeenCalledWith(10, 20)
      expect(actions.copyLink).toHaveBeenCalledWith('https://example.com/pic.png')
    })

    test('only offers copy image when the image source is not a web URL', async () => {
      const { buildMenu, trigger } = browserSetup()

      await trigger({
        mediaType: 'image',
        selectionText: '',
        srcURL: 'data:image/png;base64,xxx',
        x: 10,
        y: 20,
      })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        'Copy Image',
        'separator',
        'Inspect',
      ])
    })

    test('shows combined link and image groups for a link wrapping an image', async () => {
      const { buildMenu, trigger } = browserSetup()

      await trigger({
        linkURL: 'https://example.com/target',
        mediaType: 'image',
        selectionText: '',
        srcURL: 'https://example.com/pic.png',
        x: 10,
        y: 20,
      })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        'Open Link in New Tab',
        'Open in External Browser',
        'separator',
        'Copy Link Address',
        'separator',
        'Save Link As...',
        'separator',
        'Open Image in New Tab',
        'Save Image As...',
        'Copy Image',
        'Copy Image Address',
        'separator',
        'Inspect',
      ])
    })

    test('shows copy and inspect for selected text', async () => {
      const { buildMenu, trigger } = browserSetup()

      await trigger({ mediaType: 'none', selectionText: 'hello', x: 10, y: 20 })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual(['Copy', 'separator', 'Inspect'])
    })

    test('shows only cut, copy, paste and inspect in editable areas', async () => {
      const { buildMenu, trigger } = browserSetup()

      await trigger({
        editFlags: {
          canCopy: true,
          canCut: true,
          canDelete: true,
          canPaste: false,
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
      expect(items?.map(item => `${item.label ?? item.type}:${item.enabled ?? true}`)).toEqual([
        'Cut:true',
        'Copy:true',
        'Paste:false',
        'separator:true',
        'Inspect:true',
      ])
    })

    test('uses Chinese labels for browser actions', async () => {
      const { buildMenu, trigger } = setup('zh-CN', imageContext(), 'browser')

      await trigger({
        linkURL: 'https://example.com/target',
        mediaType: 'image',
        selectionText: '',
        srcURL: 'https://example.com/pic.png',
        x: 10,
        y: 20,
      })

      const [items] = buildMenu.mock.calls[0] ?? []
      expect(items?.map(item => item.label ?? item.type)).toEqual([
        '在新标签页中打开链接',
        '在外部浏览器中打开',
        'separator',
        '复制链接地址',
        'separator',
        '链接存储为...',
        'separator',
        '在新标签页中打开图片',
        '图片存储为...',
        '复制图片',
        '复制图片地址',
        'separator',
        '检查',
      ])
    })
  })
})
