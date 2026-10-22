import { browserMarkdownServices } from '@wegent/collaboration/markdown'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'

export async function copyTextToClipboard(text: string): Promise<void> {
  if (isElectronRuntime()) {
    await invokeDesktopHost<void>('clipboard.writeText', { text })
    return
  }

  await browserMarkdownServices.copyText(text)
}
