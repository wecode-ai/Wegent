import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isDesktopRuntime, isElectronRuntime } from './runtime-environment'
import type { NativeWorkspacePath } from './native-workspace-path-picker'
import { readDroppedFiles } from '@/desktop/droppedFiles'

const FILE_URI_CLIPBOARD_TYPES = ['text/uri-list', 'public.file-url'] as const
export const WORKSPACE_PATH_DRAG_TYPE = 'application/x-wework-workspace-paths'
const IMAGE_EXTENSIONS = new Set([
  'apng',
  'avif',
  'bmp',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
])

function isNativeWorkspacePath(value: unknown): value is NativeWorkspacePath {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<NativeWorkspacePath>
  return typeof candidate.path === 'string' && typeof candidate.isDirectory === 'boolean'
}

export function writeWorkspacePathDragData(
  dataTransfer: DataTransfer,
  entries: NativeWorkspacePath[]
): void {
  dataTransfer.setData(WORKSPACE_PATH_DRAG_TYPE, JSON.stringify(entries))
}

export function readWorkspacePathDragData(
  dataTransfer: DataTransfer
): NativeWorkspacePath[] | null {
  if (!hasWorkspacePathDragData(dataTransfer)) return null

  try {
    const value: unknown = JSON.parse(dataTransfer.getData(WORKSPACE_PATH_DRAG_TYPE))
    if (!Array.isArray(value) || !value.every(isNativeWorkspacePath)) return null
    return value
  } catch {
    return null
  }
}

export function hasWorkspacePathDragData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types ?? []).includes(WORKSPACE_PATH_DRAG_TYPE)
}

declare global {
  interface Window {
    weworkElectronFiles?: {
      getPathForFile: (file: File) => string
    }
  }
}

function electronDataTransferFilePaths(dataTransfer: DataTransfer): string[] {
  if (!isElectronRuntime() || typeof window === 'undefined') return []
  const getPathForFile = window.weworkElectronFiles?.getPathForFile
  if (!getPathForFile) return []

  const paths: string[] = []
  for (const file of Array.from(dataTransfer.files)) {
    try {
      const path = getPathForFile(file).trim()
      if (path && !paths.includes(path)) paths.push(path)
    } catch {
      // Synthetic files and browser-created blobs do not have native paths.
    }
  }
  return paths
}

function dataTransferFallbackPaths(dataTransfer: DataTransfer): string[] {
  return [
    ...electronDataTransferFilePaths(dataTransfer),
    ...readClipboardFileUriPaths(dataTransfer),
  ].filter((path, index, paths) => paths.indexOf(path) === index)
}

export function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null

    const pathname = decodeURIComponent(url.pathname)
    if (url.hostname)
      return `//${url.hostname}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
    return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname
  } catch {
    return null
  }
}

export function readClipboardFileUriPaths(dataTransfer: DataTransfer): string[] {
  const paths: string[] = []

  for (const type of FILE_URI_CLIPBOARD_TYPES) {
    const value = dataTransfer.getData(type)
    if (!value) continue

    for (const line of value.split(/\r?\n/)) {
      const candidate = line.trim()
      if (!candidate || candidate.startsWith('#')) continue
      const path = fileUrlToPath(candidate)
      if (path && !paths.includes(path)) paths.push(path)
    }
  }

  return paths
}

export async function readNativeClipboardWorkspacePaths(
  clipboardData: DataTransfer
): Promise<NativeWorkspacePath[]> {
  const fallbackPaths = dataTransferFallbackPaths(clipboardData)
  return invokeDesktopHost<NativeWorkspacePath[]>('clipboard.readWorkspacePaths', {
    fallbackPaths,
  })
}

export async function readNativeDroppedWorkspacePaths(
  dataTransfer: DataTransfer
): Promise<NativeWorkspacePath[]> {
  const fallbackPaths = dataTransferFallbackPaths(dataTransfer)
  return invokeDesktopHost<NativeWorkspacePath[]>('filesystem.inspectPaths', {
    paths: fallbackPaths,
  })
}

export async function inspectNativeWorkspacePaths(paths: string[]): Promise<NativeWorkspacePath[]> {
  if (paths.length === 0) return []
  return invokeDesktopHost<NativeWorkspacePath[]>('filesystem.inspectPaths', { paths })
}

export function isWorkspaceImagePath(path: string): boolean {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase() ?? ''
  return IMAGE_EXTENSIONS.has(extension)
}

export function isWorkspaceImageFile(file: File): boolean {
  return file.type.toLocaleLowerCase().startsWith('image/') || isWorkspaceImagePath(file.name)
}

async function resolveNativeWorkspaceTransfer(
  entries: NativeWorkspacePath[],
  files: File[]
): Promise<ResolvedWorkspacePathTransfer> {
  const remainingEntries = [...entries]
  const attachmentFiles = files.filter(file => {
    let nativePath = ''
    try {
      nativePath = window.weworkElectronFiles?.getPathForFile(file) ?? ''
    } catch {
      // Browser-created files have no native path; match clipboard URI entries by name.
    }
    const index = remainingEntries.findIndex(entry =>
      nativePath
        ? entry.path.replaceAll('\\', '/') === nativePath.replaceAll('\\', '/')
        : entry.path.split(/[\\/]/).at(-1) === file.name
    )
    if (index < 0) return true
    return !remainingEntries.splice(index, 1)[0].isDirectory
  })
  const unreadPaths = remainingEntries.filter(entry => !entry.isDirectory).map(entry => entry.path)
  if (unreadPaths.length) attachmentFiles.push(...(await readDroppedFiles(unreadPaths)))
  return {
    attachmentFiles,
    referenceEntries: entries.filter(entry => entry.isDirectory),
  }
}

export interface ResolvedWorkspacePathTransfer {
  attachmentFiles: File[]
  referenceEntries: NativeWorkspacePath[]
}

export async function resolveDataTransferWorkspacePaths(
  dataTransfer: DataTransfer,
  source: 'clipboard' | 'drop'
): Promise<ResolvedWorkspacePathTransfer> {
  const draggedWorkspacePaths = readWorkspacePathDragData(dataTransfer)
  if (draggedWorkspacePaths) {
    return {
      attachmentFiles: [],
      referenceEntries: draggedWorkspacePaths,
    }
  }

  const files = Array.from(dataTransfer.files)
  if (!isDesktopRuntime() || (files.length > 0 && files.every(isWorkspaceImageFile))) {
    return { attachmentFiles: files, referenceEntries: [] }
  }

  let entries: NativeWorkspacePath[]
  try {
    entries =
      source === 'clipboard'
        ? await readNativeClipboardWorkspacePaths(dataTransfer)
        : await readNativeDroppedWorkspacePaths(dataTransfer)
  } catch (error) {
    console.warn(`[Wework workspace transfer] native ${source} path inspection failed`, error)
    return {
      attachmentFiles: files,
      referenceEntries: [],
    }
  }
  return resolveNativeWorkspaceTransfer(entries, files)
}

export async function resolveStoredWorkspacePaths(
  paths: string[],
  remote: boolean
): Promise<ResolvedWorkspacePathTransfer> {
  if (remote) {
    return {
      attachmentFiles: await readDroppedFiles(paths),
      referenceEntries: [],
    }
  }
  return resolveNativeWorkspaceTransfer(await inspectNativeWorkspacePaths(paths), [])
}
