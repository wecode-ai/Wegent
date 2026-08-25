import { openNativeWorkspacePathPicker } from './native-workspace-path-picker'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'

export async function openNativeDirectoryPicker(defaultPath?: string): Promise<string | null> {
  const selected = await invokeDesktopHost<{
    canceled: boolean
    filePaths: string[]
  }>('dialog.open', {
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  })
  return selected.canceled ? null : selected.filePaths[0]?.trim() || null
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

export async function openNativeProjectDirectoryPickers(
  initialDirectory?: string
): Promise<string[]> {
  const selected = await openNativeWorkspacePathPicker(initialDirectory, {
    directoriesOnly: true,
    multiple: true,
    defaultToHome: true,
  })
  return selected
    .filter(item => item.isDirectory)
    .map(item => item.path.trim())
    .filter(Boolean)
}
