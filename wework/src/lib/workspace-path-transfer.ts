import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './runtime-environment'
import type { NativeWorkspacePath } from './native-workspace-path-picker'
import { readDroppedFiles } from '@/tauri/droppedFiles'

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
  if (!isTauriRuntime()) return []

  return invoke<NativeWorkspacePath[]>('read_clipboard_workspace_paths', {
    fallbackPaths: readClipboardFileUriPaths(clipboardData),
  })
}

export async function readNativeDroppedWorkspacePaths(
  dataTransfer: DataTransfer
): Promise<NativeWorkspacePath[]> {
  if (!isTauriRuntime()) return []

  return invoke<NativeWorkspacePath[]>('read_dropped_workspace_paths', {
    fallbackPaths: readClipboardFileUriPaths(dataTransfer),
  })
}

export async function inspectNativeWorkspacePaths(paths: string[]): Promise<NativeWorkspacePath[]> {
  if (!isTauriRuntime() || paths.length === 0) return []
  return invoke<NativeWorkspacePath[]>('inspect_workspace_paths', { paths })
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
    !isTauriRuntime() ||
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
