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

export function openNativeProjectDirectoryPicker(): Promise<string | null> {
  return openNativeDirectoryPicker()
}
