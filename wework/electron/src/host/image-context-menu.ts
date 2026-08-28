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
  linkURL?: string
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
  copyLink: (url: string) => void
  copyPath: (path: string) => void
  getState: () => NativeContextMenuState
  goBack: () => void
  goForward: () => void
  inspect: (x: number, y: number) => void
  openExternal: (url: string) => void
  openImage: (image: ImageContext) => Promise<void>
  openLinkInNewTab: (url: string) => void
  reloadPage: () => void
  reportError: (action: string, error: unknown) => void
  resolveImageContext: (params: NativeContextMenuParams) => Promise<ImageContext | null>
  showItemInFolder: (path: string) => void
}

export interface NativeContextMenuState {
  canGoBack: boolean
  canGoForward: boolean
  url: string | null
}

export type NativeContextMenuMode = 'app' | 'browser'

interface NativeContextMenuLabels {
  back: string
  copyImage: string
  copyLink: string
  copyPath: string
  forward: string
  inspect: string
  openExternalBrowser: string
  openImage: string
  openLinkInNewTab: string
  reload: string
  showItemInFolder: string
}

const ZH_CN_LABELS: NativeContextMenuLabels = {
  back: '返回',
  copyImage: '复制图片',
  copyLink: '复制链接地址',
  copyPath: '复制文件路径',
  forward: '前进',
  inspect: '检查',
  openExternalBrowser: '在外部浏览器中打开',
  openImage: '在系统默认应用中打开',
  openLinkInNewTab: '在新标签页中打开链接',
  reload: '重新加载',
  showItemInFolder: '在 Finder / 文件资源管理器中显示',
}

const EN_LABELS: NativeContextMenuLabels = {
  back: 'Back',
  copyImage: 'Copy Image',
  copyLink: 'Copy Link Address',
  copyPath: 'Copy File Path',
  forward: 'Forward',
  inspect: 'Inspect',
  openExternalBrowser: 'Open in External Browser',
  openImage: 'Open in Default Application',
  openLinkInNewTab: 'Open Link in New Tab',
  reload: 'Reload',
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

function externalUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function withSeparators(groups: NativeContextMenuItem[][]): NativeContextMenuItem[] {
  const items: NativeContextMenuItem[] = []
  for (const group of groups) {
    if (group.length === 0) continue
    if (items.length > 0) items.push({ type: 'separator' })
    items.push(...group)
  }
  return items
}

function linkMenuGroup(
  url: string,
  actions: NativeContextMenuActions,
  labels: NativeContextMenuLabels
): NativeContextMenuItem[] {
  return [
    {
      label: labels.openLinkInNewTab,
      click: () => actions.openLinkInNewTab(url),
    },
    {
      label: labels.openExternalBrowser,
      click: () => actions.openExternal(url),
    },
    {
      label: labels.copyLink,
      click: () => actions.copyLink(url),
    },
  ]
}

function navigationMenuGroup(
  actions: NativeContextMenuActions,
  labels: NativeContextMenuLabels
): NativeContextMenuItem[] {
  const state = actions.getState()
  const items: NativeContextMenuItem[] = [
    { label: labels.back, enabled: state.canGoBack, click: () => actions.goBack() },
    { label: labels.forward, enabled: state.canGoForward, click: () => actions.goForward() },
    { label: labels.reload, click: () => actions.reloadPage() },
  ]
  const url = externalUrl(state.url)
  if (url) {
    items.push({
      label: labels.openExternalBrowser,
      click: () => actions.openExternal(url),
    })
  }
  return items
}

async function imageMenuGroup(
  contents: NativeContextMenuContents,
  params: NativeContextMenuParams,
  actions: NativeContextMenuActions,
  labels: NativeContextMenuLabels
): Promise<NativeContextMenuItem[]> {
  const image = await actions.resolveImageContext(params)
  if (!image) return []

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
  return items
}

async function showBrowserContextMenu(
  contents: NativeContextMenuContents,
  params: NativeContextMenuParams,
  buildMenu: (items: NativeContextMenuItem[]) => NativeContextMenu,
  actions: NativeContextMenuActions,
  labels: NativeContextMenuLabels
): Promise<void> {
  const frame = params.frame ?? undefined
  const linkUrl = externalUrl(params.linkURL)
  const isImage = params.mediaType === 'image'
  const hasSelection = params.selectionText.trim().length > 0

  const groups: NativeContextMenuItem[][] = []
  if (linkUrl) groups.push(linkMenuGroup(linkUrl, actions, labels))
  if (isImage) groups.push(await imageMenuGroup(contents, params, actions, labels))

  if (linkUrl && isImage) {
    // A link wrapping an image exposes only target-specific actions.
  } else if (hasSelection && !linkUrl && !isImage) {
    groups.push([{ role: 'copy' }])
  } else {
    groups.push(navigationMenuGroup(actions, labels))
  }

  if (!(linkUrl && isImage)) {
    groups.push([{ label: labels.inspect, click: () => actions.inspect(params.x, params.y) }])
  }

  const items = withSeparators(groups)
  if (items.length === 0) return
  buildMenu(items).popup({ frame })
}

async function showContextMenu(
  contents: NativeContextMenuContents,
  params: NativeContextMenuParams,
  buildMenu: (items: NativeContextMenuItem[]) => NativeContextMenu,
  actions: NativeContextMenuActions,
  labels: NativeContextMenuLabels,
  mode: NativeContextMenuMode
): Promise<void> {
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

  if (mode === 'browser') {
    await showBrowserContextMenu(contents, params, buildMenu, actions, labels)
    return
  }

  if (params.mediaType === 'image') {
    const items = await imageMenuGroup(contents, params, actions, labels)
    if (items.length === 0) return
    buildMenu(items).popup()
    return
  }

  if (!params.selectionText.trim()) return
  buildMenu([{ role: 'copy' }]).popup({ frame })
}

export function installNativeContextMenu(
  contents: NativeContextMenuContents,
  buildMenu: (items: NativeContextMenuItem[]) => NativeContextMenu,
  actions: NativeContextMenuActions,
  language: string,
  mode: NativeContextMenuMode = 'app'
): void {
  const labels = labelsForLanguage(language)
  contents.on('context-menu', (_event, params) => {
    void showContextMenu(contents, params, buildMenu, actions, labels, mode).catch(error =>
      actions.reportError('show-context-menu', error)
    )
  })
}
