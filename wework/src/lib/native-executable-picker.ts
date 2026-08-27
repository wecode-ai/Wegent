import { invokeDesktopHost } from '@/api/dsh/desktopHost'

export async function openNativeExecutablePicker(
  defaultPath?: string,
  title?: string
): Promise<string | null> {
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
