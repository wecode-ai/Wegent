import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export async function selectWorkbenchBackground(): Promise<string | null> {
  if (!isTauri()) throw new Error('Background images are only available in the desktop app')

  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  })
  if (!selected) return null
  return invoke<string>('import_workbench_background', { sourcePath: selected })
}

export async function removeWorkbenchBackground(): Promise<void> {
  if (!isTauri()) return
  await invoke('remove_workbench_background')
}

export function backgroundImageUrl(path: string | null): string | null {
  if (!path || !isTauri()) return null
  return convertFileSrc(path)
}
