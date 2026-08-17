import { isTauriRuntime } from './runtime-environment'

export async function openNativeExecutablePicker(
  defaultPath?: string,
  title?: string
): Promise<string | null> {
  if (!isTauriRuntime()) return null

  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: false,
    multiple: false,
    defaultPath,
    title,
  })

  if (typeof selected !== 'string') return null
  return selected.trim() || null
}
