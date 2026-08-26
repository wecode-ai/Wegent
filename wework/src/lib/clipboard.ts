import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'

export async function copyTextToClipboard(text: string): Promise<void> {
  if (isElectronRuntime()) {
    await invokeDesktopHost<void>('clipboard.writeText', { text })
    return
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  throw new Error('Clipboard copy is not supported')
}
