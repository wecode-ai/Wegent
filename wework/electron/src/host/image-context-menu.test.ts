import { describe, expect, test, vi } from 'vitest'
import {
  installNativeContextMenu,
  type ImageContext,
  type NativeContextMenuContents,
  type NativeContextMenuItem,
  type NativeContextMenuParams,
} from './image-context-menu.js'

function imageContext(localPath: string | null = null): ImageContext {
  return {
    filename: 'preview.png',
    localPath,
    sourceUrl: 'blob:preview',
  }
}

function setup(language = 'en-US', resolvedImage = imageContext()) {
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
    copyPath: vi.fn(),
    copyText: vi.fn(),
    openImage: vi.fn(async () => undefined),
    reportError: vi.fn(),
    resolveImageContext: vi.fn(async () => resolvedImage),
    showItemInFolder: vi.fn(),
  }

  installNativeContextMenu(contents, buildMenu, actions, language)

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
    const { actions, buildMenu, trigger } = setup()
    const params = {
      mediaType: 'none',
      selectionText: 'selected response',
      x: 10,
      y: 20,
    }

    await trigger(params)

    const [items] = buildMenu.mock.calls[0] ?? []
    expect(items?.map(item => item.label)).toEqual(['Copy'])
    items?.[0]?.click?.()
    expect(actions.copyText).toHaveBeenCalledWith('selected response')
  })

  test('leaves non-image context menus without a selection untouched', async () => {
    const { buildMenu, popup, contents } = setup()
    const listener = contents.on.mock.calls[0]?.[1]

    listener?.({}, { mediaType: 'none', selectionText: '  ', x: 10, y: 20 })
    await Promise.resolve()

    expect(buildMenu).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
  })
})
