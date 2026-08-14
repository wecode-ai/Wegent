import { isTauriRuntime } from '@/lib/runtime-environment'
import { copyLocalExecutorDebugInfo } from '@/tauri/localExecutor'

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  if (isTauriRuntime()) {
    await copyLocalExecutorDebugInfo(text)
    return
  }

  throw new Error('Clipboard copy is not supported')
}
