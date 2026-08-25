export interface NativeContextMenuParams {
  mediaType: string
  selectionText: string
  x: number
  y: number
}

export interface ImageContext {
  filename: string
  localPath: string | null
  sourceUrl: string
}

export interface NativeContextMenuContents {
  copyImageAt: (x: number, y: number) => void
  on: (
    event: 'context-menu',
    listener: (event: unknown, params: NativeContextMenuParams) => void
  ) => void
}

export interface NativeContextMenu {
  popup: () => void
}

export interface NativeContextMenuItem {
  click?: () => void
  label?: string
  type?: 'separator'
}

export interface NativeContextMenuActions {
  copyPath: (path: string) => void
  copyText: (text: string) => void
  openImage: (image: ImageContext) => Promise<void>
  reportError: (action: string, error: unknown) => void
  resolveImageContext: (params: NativeContextMenuParams) => Promise<ImageContext | null>
  showItemInFolder: (path: string) => void
}

interface NativeContextMenuLabels {
  copy: string
  copyImage: string
  copyPath: string
  openImage: string
  showItemInFolder: string
}

const ZH_CN_LABELS: NativeContextMenuLabels = {
  copy: '复制',
  copyImage: '复制图片',
  copyPath: '复制文件路径',
  openImage: '在系统默认应用中打开',
  showItemInFolder: '在 Finder / 文件资源管理器中显示',
}

const EN_LABELS: NativeContextMenuLabels = {
  copy: 'Copy',
  copyImage: 'Copy Image',
  copyPath: 'Copy File Path',
  openImage: 'Open in Default Application',
  showItemInFolder: 'Show in Finder / File Explorer',
}

function labelsForLanguage(language: string): NativeContextMenuLabels {
  return language.trim().toLowerCase().startsWith('zh') ? ZH_CN_LABELS : EN_LABELS
}

function runAsyncAction(
  action: string,
  operation: () => Promise<void>,
  reportError: NativeContextMenuActions['reportError']
): void {
  void operation().catch(error => reportError(action, error))
}

async function showContextMenu(
  contents: NativeContextMenuContents,
  params: NativeContextMenuParams,
  buildMenu: (items: NativeContextMenuItem[]) => NativeContextMenu,
  actions: NativeContextMenuActions,
  labels: NativeContextMenuLabels
): Promise<void> {
  if (params.mediaType === 'image') {
    const image = await actions.resolveImageContext(params)
    if (!image) return

    const items: NativeContextMenuItem[] = [
      {
        label: labels.copyImage,
        click: () => contents.copyImageAt(params.x, params.y),
      },
      {
        label: labels.openImage,
        click: () =>
          runAsyncAction('open-image', () => actions.openImage(image), actions.reportError),
      },
    ]
    if (image.localPath) {
      const localPath = image.localPath
      items.push(
        { type: 'separator' },
        {
          label: labels.showItemInFolder,
          click: () => actions.showItemInFolder(localPath),
        },
        {
          label: labels.copyPath,
          click: () => actions.copyPath(localPath),
        }
      )
    }
    buildMenu(items).popup()
    return
  }

  if (!params.selectionText.trim()) return
  buildMenu([
    {
      label: labels.copy,
      click: () => actions.copyText(params.selectionText),
    },
  ]).popup()
}

export function installNativeContextMenu(
  contents: NativeContextMenuContents,
  buildMenu: (items: NativeContextMenuItem[]) => NativeContextMenu,
  actions: NativeContextMenuActions,
  language: string
): void {
  const labels = labelsForLanguage(language)
  contents.on('context-menu', (_event, params) => {
    void showContextMenu(contents, params, buildMenu, actions, labels).catch(error =>
      actions.reportError('show-context-menu', error)
    )
  })
}
