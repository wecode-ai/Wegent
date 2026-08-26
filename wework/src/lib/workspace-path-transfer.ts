import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isDesktopRuntime, isElectronRuntime } from './runtime-environment'
import type { NativeWorkspacePath } from './native-workspace-path-picker'
import { readDroppedFiles } from '@/desktop/droppedFiles'

const FILE_URI_CLIPBOARD_TYPES = ['text/uri-list', 'public.file-url'] as const
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

export function partitionLocalWorkspaceTransfer(
  entries: NativeWorkspacePath[],
  files: File[]
): {
  attachmentFiles: File[]
  referenceEntries: NativeWorkspacePath[]
} {
  return {
    attachmentFiles: files.filter(isWorkspaceImageFile),
    referenceEntries: entries.filter(
      entry => entry.isDirectory || !isWorkspaceImagePath(entry.path)
    ),
  }
}

export function partitionNativeWorkspacePaths(entries: NativeWorkspacePath[]): {
  imagePaths: string[]
  referenceEntries: NativeWorkspacePath[]
} {
  return {
    imagePaths: entries
      .filter(entry => !entry.isDirectory && isWorkspaceImagePath(entry.path))
      .map(entry => entry.path),
    referenceEntries: entries.filter(
      entry => entry.isDirectory || !isWorkspaceImagePath(entry.path)
    ),
  }
}

export interface ResolvedWorkspacePathTransfer {
  attachmentFiles: File[]
  referenceEntries: NativeWorkspacePath[]
}

export async function resolveDataTransferWorkspacePaths(
  dataTransfer: DataTransfer,
  source: 'clipboard' | 'drop',
  workspaceSource?: string | null
): Promise<ResolvedWorkspacePathTransfer> {
  const files = Array.from(dataTransfer.files)
  if (
    !isDesktopRuntime() ||
    workspaceSource === 'remote' ||
    (files.length > 0 && files.every(isWorkspaceImageFile))
  ) {
    return { attachmentFiles: files, referenceEntries: [] }
  }

  try {
    const entries =
      source === 'clipboard'
        ? await readNativeClipboardWorkspacePaths(dataTransfer)
        : await readNativeDroppedWorkspacePaths(dataTransfer)
    if (entries.length === 0) {
      return { attachmentFiles: files, referenceEntries: [] }
    }
    return partitionLocalWorkspaceTransfer(entries, files)
  } catch (error) {
    console.warn(`[Wework workspace transfer] native ${source} path inspection failed`, error)
    return {
      attachmentFiles: files.filter(isWorkspaceImageFile),
      referenceEntries: [],
    }
  }
}

export async function resolveStoredWorkspacePaths(
  paths: string[],
  remote: boolean
): Promise<ResolvedWorkspacePathTransfer> {
  try {
    if (remote) {
      return {
        attachmentFiles: await readDroppedFiles(paths),
        referenceEntries: [],
      }
    }

    const entries = await inspectNativeWorkspacePaths(paths)
    const { imagePaths, referenceEntries } = partitionNativeWorkspacePaths(entries)
    return {
      attachmentFiles: imagePaths.length > 0 ? await readDroppedFiles(imagePaths) : [],
      referenceEntries,
    }
  } catch (error) {
    console.warn('[Wework workspace transfer] stored path inspection failed', error)
    return { attachmentFiles: [], referenceEntries: [] }
  }
}
