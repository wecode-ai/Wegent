import { isTauriRuntime } from '@/lib/runtime-environment'
import { copyLocalExecutorDebugInfo } from '@/tauri/localExecutor'

function copyTextWithDocumentCommand(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Desktop WebViews may reject the async clipboard API; use the fallbacks below.
  }

  if (copyTextWithDocumentCommand(text)) return

  if (isTauriRuntime()) {
    await copyLocalExecutorDebugInfo(text)
    return
  }

  throw new Error('Clipboard copy is not supported')
}
