import { isHttpUrl, openExternalUrl } from '@/lib/external-links'
import { isDesktopRuntime } from '@/lib/runtime-environment'

export async function openSystemBrowserIfCurrent(
  value: string,
  isCurrent: () => boolean
): Promise<boolean> {
  if (!isHttpUrl(value)) return false

  if (isDesktopRuntime()) {
    if (!isCurrent()) return false
    return openExternalUrl(value, { target: 'system' })
  }

  if (!isCurrent()) return false
  window.open(value, '_blank', 'noopener,noreferrer')
  return true
}
