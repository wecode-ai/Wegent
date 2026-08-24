import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { desktopFileUrl } from '@/components/chat/assistantMarkdownLinks'
import type { ResolvedAppearanceMode } from './types'

export type WorkbenchBackgroundSlot = ResolvedAppearanceMode | 'common'

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

export function backgroundImageUrl(path: string | null): string | null {
  return path ? desktopFileUrl(path) : null
}
