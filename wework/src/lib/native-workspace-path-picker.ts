import { isTauriRuntime } from './runtime-environment'

export interface NativeWorkspacePath {
  path: string
  isDirectory: boolean
}

export function canOpenNativeWorkspacePathPicker(): boolean {
  return isTauriRuntime()
}

export async function openNativeWorkspacePathPicker(
  initialDirectory?: string
): Promise<NativeWorkspacePath[]> {
  if (!isTauriRuntime()) return []

  const { invoke } = await import('@tauri-apps/api/core')
  const selected = await invoke<NativeWorkspacePath[]>('pick_workspace_paths', {
    initialDirectory: initialDirectory?.trim() || null,
  })
  return selected.filter(item => item.path.trim().length > 0)
}
