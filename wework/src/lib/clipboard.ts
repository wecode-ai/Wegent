import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch (error) {
      if (!isElectronRuntime()) throw error
    }
  }

  if (isElectronRuntime()) {
    await invokeDesktopHost<void>('clipboard.writeText', { text })
    return
  }

  throw new Error('Clipboard copy is not supported')
}
