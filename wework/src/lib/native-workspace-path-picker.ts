import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './runtime-environment'

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
  return isTauriRuntime()
}

export async function openNativeWorkspacePathPicker(
  initialDirectory?: string,
  options: NativeWorkspacePathPickerOptions = {}
): Promise<NativeWorkspacePath[]> {
  if (!isTauriRuntime()) return []

  const selected = await invoke<NativeWorkspacePath[]>('pick_workspace_paths', {
    initialDirectory: initialDirectory?.trim() || null,
    directoriesOnly: options.directoriesOnly ?? false,
    multiple: options.multiple ?? true,
    defaultToHome: options.defaultToHome ?? false,
  })
  return selected.filter(item => item.path.trim().length > 0)
}
