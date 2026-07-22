import { isHttpUrl } from '@/lib/external-links'
import { isTauriRuntime } from '@/lib/runtime-environment'

export async function openSystemBrowserIfCurrent(
  value: string,
  isCurrent: () => boolean
): Promise<boolean> {
  if (!isHttpUrl(value)) return false

  if (isTauriRuntime()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    if (!isCurrent()) return false
    await openUrl(value)
    return true
  }

  if (!isCurrent()) return false
  window.open(value, '_blank', 'noopener,noreferrer')
  return true
}
