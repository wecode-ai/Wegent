import { openNativeWorkspacePathPicker } from './native-workspace-path-picker'
import { isTauriRuntime } from './runtime-environment'

export async function openNativeDirectoryPicker(defaultPath?: string): Promise<string | null> {
  const tauriRuntime = isTauriRuntime()
  if (!tauriRuntime) return null

  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: true,
    multiple: false,
    canCreateDirectories: true,
    defaultPath,
  })

  if (typeof selected === 'string') {
    const trimmed = selected.trim()
    return trimmed || null
  }

  return null
}

export async function openNativeProjectDirectoryPicker(
  initialDirectory?: string
): Promise<string | null> {
  const selected = await openNativeWorkspacePathPicker(initialDirectory, {
    directoriesOnly: true,
    multiple: false,
    defaultToHome: true,
  })
  const directory = selected.find(item => item.isDirectory)
  return directory?.path.trim() || null
}
