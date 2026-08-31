import type { WebFrameMain } from 'electron'

export interface NativeContextMenuParams {
  editFlags?: {
    canCopy: boolean
    canCut: boolean
    canDelete: boolean
    canPaste: boolean
    canRedo: boolean
    canSelectAll: boolean
    canUndo: boolean
  }
  frame?: WebFrameMain | null
  isEditable?: boolean
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
  popup: (options?: { frame?: WebFrameMain }) => void
}

export interface NativeContextMenuItem {
  click?: () => void
  enabled?: boolean
  label?: string
  role?: 'copy' | 'cut' | 'delete' | 'paste' | 'redo' | 'selectAll' | 'undo'
  type?: 'separator'
}

export interface NativeContextMenuActions {
  copyPath: (path: string) => void
  openImage: (image: ImageContext) => Promise<void>
  reportError: (action: string, error: unknown) => void
  resolveImageContext: (params: NativeContextMenuParams) => Promise<ImageContext | null>
  showItemInFolder: (path: string) => void
}

interface NativeContextMenuLabels {
  copyImage: string
  copyPath: string
  openImage: string
  showItemInFolder: string
}

const ZH_CN_LABELS: NativeContextMenuLabels = {
  copyImage: '复制图片',
  copyPath: '复制文件路径',
  openImage: '在系统默认应用中打开',
  showItemInFolder: '在 Finder / 文件资源管理器中显示',
}

const EN_LABELS: NativeContextMenuLabels = {
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

  const frame = params.frame ?? undefined
  if (params.isEditable) {
    const editFlags = params.editFlags
    buildMenu([
      { role: 'undo', enabled: editFlags?.canUndo },
      { role: 'redo', enabled: editFlags?.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: editFlags?.canCut },
      { role: 'copy', enabled: editFlags?.canCopy },
      { role: 'paste', enabled: editFlags?.canPaste },
      { role: 'delete', enabled: editFlags?.canDelete },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags?.canSelectAll },
    ]).popup({ frame })
    return
  }

  if (!params.selectionText.trim()) return
  buildMenu([{ role: 'copy' }]).popup({ frame })
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
