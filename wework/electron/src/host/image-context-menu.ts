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
  srcURL?: string
  x: number
  y: number
}

export interface ImageContext {
  filename: string
  localPath: string | null
  sourceUrl: string
}

export interface NativeContextMenuContents {
  copy: () => void
  copyImageAt: (x: number, y: number) => void
  cut: () => void
  delete: () => void
  downloadURL: (url: string) => void
  on: (
    event: 'context-menu',
    listener: (event: unknown, params: NativeContextMenuParams) => void
  ) => void
  paste: () => void
  redo: () => void
  selectAll: () => void
  undo: () => void
}

export interface NativeContextMenu {
  popup: (options?: { frame?: WebFrameMain }) => void
}

export interface NativeContextMenuItem {
  click?: () => void
  enabled?: boolean
  label?: string
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
}

export type NativeContextMenuMode = 'app' | 'browser'

interface NativeContextMenuLabels {
  back: string
  copy: string
  copyImage: string
  copyImageAddress: string
  copyLink: string
  copyPath: string
  cut: string
  delete: string
  forward: string
  inspect: string
  openExternalBrowser: string
  openImage: string
  openImageInNewTab: string
  openLinkInNewTab: string
  paste: string
  redo: string
  reload: string
  saveImageAs: string
  saveLinkAs: string
  selectAll: string
  showItemInFolder: string
  undo: string
}

const ZH_CN_LABELS: NativeContextMenuLabels = {
  back: '返回',
  copy: '复制',
  copyImage: '复制图片',
  copyImageAddress: '复制图片地址',
  copyLink: '复制链接地址',
  copyPath: '复制文件路径',
  cut: '剪切',
  delete: '删除',
  forward: '前进',
  inspect: '检查',
  openExternalBrowser: '在外部浏览器中打开',
  openImage: '在系统默认应用中打开',
  openImageInNewTab: '在新标签页中打开图片',
  openLinkInNewTab: '在新标签页中打开链接',
  paste: '粘贴',
  redo: '重做',
  reload: '重新加载',
  saveImageAs: '图片存储为...',
  saveLinkAs: '链接存储为...',
  selectAll: '全选',
  showItemInFolder: '在 Finder / 文件资源管理器中显示',
  undo: '撤销',
}

const EN_LABELS: NativeContextMenuLabels = {
  back: 'Back',
  copy: 'Copy',
  copyImage: 'Copy Image',
  copyImageAddress: 'Copy Image Address',
  copyLink: 'Copy Link Address',
  copyPath: 'Copy File Path',
  cut: 'Cut',
  delete: 'Delete',
  forward: 'Forward',
  inspect: 'Inspect',
  openExternalBrowser: 'Open in External Browser',
  openImage: 'Open in Default Application',
  openImageInNewTab: 'Open Image in New Tab',
  openLinkInNewTab: 'Open Link in New Tab',
  paste: 'Paste',
  redo: 'Redo',
  reload: 'Reload',
  saveImageAs: 'Save Image As...',
  saveLinkAs: 'Save Link As...',
  selectAll: 'Select All',
  showItemInFolder: 'Show in Finder / File Explorer',
  undo: 'Undo',
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
  ]
}

function navigationMenuGroup(
  actions: NativeContextMenuActions,
  labels: NativeContextMenuLabels
): NativeContextMenuItem[] {
  const state = actions.getState()
  return [
    { label: labels.back, enabled: state.canGoBack, click: () => actions.goBack() },
    { label: labels.forward, enabled: state.canGoForward, click: () => actions.goForward() },
    { label: labels.reload, click: () => actions.reloadPage() },
  ]
}

// Plain label items instead of native roles: macOS appends system "Services"
// and "Auto Fill" items to menus built from edit roles.
function copyMenuItem(
  contents: NativeContextMenuContents,
  labels: NativeContextMenuLabels,
  enabled = true
): NativeContextMenuItem {
  return { label: labels.copy, enabled, click: () => contents.copy() }
}

function inspectMenuGroup(
  actions: NativeContextMenuActions,
  labels: NativeContextMenuLabels,
  params: NativeContextMenuParams
): NativeContextMenuItem[] {
  return [{ label: labels.inspect, click: () => actions.inspect(params.x, params.y) }]
}

function editMenuItems(
  contents: NativeContextMenuContents,
  params: NativeContextMenuParams,
  labels: NativeContextMenuLabels,
  full: boolean
): NativeContextMenuItem[] {
  const editFlags = params.editFlags
  const cutCopyPaste: NativeContextMenuItem[] = [
    { label: labels.cut, enabled: editFlags?.canCut, click: () => contents.cut() },
    copyMenuItem(contents, labels, editFlags?.canCopy ?? true),
    { label: labels.paste, enabled: editFlags?.canPaste, click: () => contents.paste() },
  ]
  if (!full) return cutCopyPaste
  return [
    { label: labels.undo, enabled: editFlags?.canUndo, click: () => contents.undo() },
    { label: labels.redo, enabled: editFlags?.canRedo, click: () => contents.redo() },
    { type: 'separator' },
    ...cutCopyPaste,
    { label: labels.delete, enabled: editFlags?.canDelete, click: () => contents.delete() },
    { type: 'separator' },
    {
      label: labels.selectAll,
      enabled: editFlags?.canSelectAll,
      click: () => contents.selectAll(),
    },
  ]
}

function browserImageMenuItems(
  contents: NativeContextMenuContents,
  params: NativeContextMenuParams,
  actions: NativeContextMenuActions,
  labels: NativeContextMenuLabels
): NativeContextMenuItem[] {
  const sourceUrl = externalUrl(params.srcURL)
  const items: NativeContextMenuItem[] = []
  if (sourceUrl) {
    items.push(
      {
        label: labels.openImageInNewTab,
        click: () => actions.openLinkInNewTab(sourceUrl),
      },
      {
        label: labels.saveImageAs,
        click: () => contents.downloadURL(sourceUrl),
      }
    )
  }
  items.push({
    label: labels.copyImage,
    click: () => contents.copyImageAt(params.x, params.y),
  })
  if (sourceUrl) {
    items.push({
      label: labels.copyImageAddress,
      click: () => actions.copyLink(sourceUrl),
    })
  }
  return items
}

async function legacyImageMenuGroup(
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

function showBrowserContextMenu(
  contents: NativeContextMenuContents,
  params: NativeContextMenuParams,
  buildMenu: (items: NativeContextMenuItem[]) => NativeContextMenu,
  actions: NativeContextMenuActions,
  labels: NativeContextMenuLabels
): void {
  const frame = params.frame ?? undefined
  const linkUrl = externalUrl(params.linkURL)
  const isImage = params.mediaType === 'image'
  const hasSelection = params.selectionText.trim().length > 0

  const groups: NativeContextMenuItem[][] = []
  if (linkUrl) {
    groups.push(linkMenuGroup(linkUrl, actions, labels))
    const copyGroup: NativeContextMenuItem[] = [
      { label: labels.copyLink, click: () => actions.copyLink(linkUrl) },
    ]
    if (hasSelection) copyGroup.push(copyMenuItem(contents, labels))
    groups.push(copyGroup)
    groups.push([{ label: labels.saveLinkAs, click: () => contents.downloadURL(linkUrl) }])
    if (isImage) {
      groups.push(browserImageMenuItems(contents, params, actions, labels))
    }
  } else if (isImage) {
    groups.push(browserImageMenuItems(contents, params, actions, labels))
  } else if (hasSelection) {
    groups.push([copyMenuItem(contents, labels)])
  } else {
    groups.push(navigationMenuGroup(actions, labels))
  }
  groups.push(inspectMenuGroup(actions, labels, params))

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
    const full = mode === 'app'
    const groups: NativeContextMenuItem[][] = [editMenuItems(contents, params, labels, full)]
    if (!full) groups.push(inspectMenuGroup(actions, labels, params))
    buildMenu(withSeparators(groups)).popup({ frame })
    return
  }

  if (mode === 'browser') {
    showBrowserContextMenu(contents, params, buildMenu, actions, labels)
    return
  }

  if (params.mediaType === 'image') {
    const items = await legacyImageMenuGroup(contents, params, actions, labels)
    if (items.length === 0) return
    buildMenu(items).popup()
    return
  }

  if (!params.selectionText.trim()) return
  buildMenu([copyMenuItem(contents, labels)]).popup({ frame })
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
