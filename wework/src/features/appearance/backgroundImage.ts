import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { readElectronLocalFile } from '@/lib/electron-local-file'
import { isElectronRuntime } from '@/lib/runtime-environment'
import type { ResolvedAppearanceMode } from './types'

export type WorkbenchBackgroundSlot = ResolvedAppearanceMode | 'common'

const WORKBENCH_BACKGROUND_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export interface WorkbenchBackgroundImage {
  url: string
  release: () => void
}

export async function selectWorkbenchBackground(
  theme: WorkbenchBackgroundSlot
): Promise<string | null> {
  void theme
  const selected = await invokeDesktopHost<{ canceled: boolean; filePaths: string[] }>(
    'dialog.open',
    {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    }
  )
  return selected.canceled ? null : (selected.filePaths[0] ?? null)
}

export async function removeWorkbenchBackground(theme?: WorkbenchBackgroundSlot): Promise<void> {
  void theme
}

/**
 * The desktop renderer runs on an HTTP origin, where Chromium blocks `file://`
 * images. Read the selected image through the Electron file bridge and expose
 * it to the renderer as a Blob URL instead.
 */
export async function loadWorkbenchBackgroundImage(
  path: string | null
): Promise<WorkbenchBackgroundImage | null> {
  if (!path || !isElectronRuntime()) return null
  const mimeType = workbenchBackgroundMimeType(path)
  if (!mimeType) return null

  const bytes = await readElectronLocalFile(path)
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  return {
    url,
    release: () => URL.revokeObjectURL(url),
  }
}

function workbenchBackgroundMimeType(path: string): string | null {
  const extension = /\.([a-zA-Z0-9]+)$/.exec(path)?.[1].toLowerCase()
  return extension ? (WORKBENCH_BACKGROUND_MIME_TYPES[extension] ?? null) : null
}
