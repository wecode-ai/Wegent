import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime, isTauriRuntime } from './runtime-environment'

export async function openNativeExecutablePicker(
  defaultPath?: string,
  title?: string
): Promise<string | null> {
  if (isElectronRuntime()) {
    const selected = await invokeDesktopHost<{
      canceled: boolean
      filePaths: string[]
    }>('dialog.open', {
      defaultPath,
      title,
      properties: ['openFile'],
    })
    return selected.canceled ? null : selected.filePaths[0]?.trim() || null
  }
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
