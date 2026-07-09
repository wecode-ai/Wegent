import { isTauriRuntime } from './runtime-environment'

export async function openNativeProjectDirectoryPicker(): Promise<string | null> {
  const tauriRuntime = isTauriRuntime()
  if (!tauriRuntime) return null

  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: true,
    multiple: false,
    canCreateDirectories: true,
  })

  if (typeof selected === 'string') {
    const trimmed = selected.trim()
    return trimmed || null
  }

  return null
}
