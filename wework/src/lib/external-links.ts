import { isTauriRuntime } from './runtime-environment'

export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false

  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export async function openExternalUrl(value: string): Promise<boolean> {
  if (!isHttpUrl(value)) {
    return false
  }

  if (isTauriRuntime()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(value)
    return true
  }

  window.open(value, '_blank', 'noopener,noreferrer')
  return true
}

function findClickedAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null
  return target.closest('a[href]')
}

export function installExternalLinkHandler() {
  const handleClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return

    const anchor = findClickedAnchor(event.target)
    if (!anchor || !isHttpUrl(anchor.href)) return

    event.preventDefault()
    void openExternalUrl(anchor.href).catch(error => {
      console.error('Failed to open external URL:', error)
    })
  }

  document.addEventListener('click', handleClick)
  return () => document.removeEventListener('click', handleClick)
}
