import { invoke } from '@tauri-apps/api/core'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isDesktopRuntime, isElectronRuntime, isTauriRuntime } from './runtime-environment'

export interface NativeWorkspacePath {
  path: string
  isDirectory: boolean
}

export interface NativeWorkspacePathPickerOptions {
  directoriesOnly?: boolean
  multiple?: boolean
  defaultToHome?: boolean
}

export function canOpenNativeWorkspacePathPicker(): boolean {
  return isDesktopRuntime()
}

export async function openNativeWorkspacePathPicker(
  initialDirectory?: string,
  options: NativeWorkspacePathPickerOptions = {}
): Promise<NativeWorkspacePath[]> {
  if (isElectronRuntime()) {
    const properties = [
      options.directoriesOnly ? 'openDirectory' : 'openFile',
      ...((options.multiple ?? true) ? ['multiSelections'] : []),
      ...(options.directoriesOnly ? ['createDirectory'] : []),
    ]
    const selected = await invokeDesktopHost<{
      canceled: boolean
      filePaths: string[]
    }>('dialog.open', {
      defaultPath: initialDirectory?.trim() || undefined,
      properties,
    })
    if (selected.canceled) return []
    return Promise.all(
      selected.filePaths.map(async path => {
        const metadata = await invokeDesktopHost<{ isDirectory: boolean }>('filesystem.stat', {
          path,
        })
        return { path, isDirectory: metadata.isDirectory }
      })
    )
  }
  if (!isTauriRuntime()) return []

  const selected = await invoke<NativeWorkspacePath[]>('pick_workspace_paths', {
    initialDirectory: initialDirectory?.trim() || null,
    directoriesOnly: options.directoriesOnly ?? false,
    multiple: options.multiple ?? true,
    defaultToHome: options.defaultToHome ?? false,
  })
  return selected.filter(item => item.path.trim().length > 0)
}
