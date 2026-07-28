import { isTauriRuntime } from '@/lib/runtime-environment'
import { copyLocalExecutorDebugInfo } from '@/tauri/localExecutor'

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // The macOS WebView may reject the browser clipboard API; use the native command below.
  }

  if (isTauriRuntime()) {
    await copyLocalExecutorDebugInfo(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}
