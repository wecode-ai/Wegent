import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './runtime-environment'
import type { NativeWorkspacePath } from './native-workspace-path-picker'

const FILE_URI_CLIPBOARD_TYPES = ['text/uri-list', 'public.file-url'] as const

function fileUrlToPath(value: string): string | null {
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

export function readClipboardFileUriPaths(clipboardData: DataTransfer): string[] {
  const paths: string[] = []

  for (const type of FILE_URI_CLIPBOARD_TYPES) {
    const value = clipboardData.getData(type)
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
