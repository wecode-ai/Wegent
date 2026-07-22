import { isTauriRuntime } from './runtime-environment'
import { requestEmbeddedBrowserOpen } from './embedded-browser'
import { getAppPreferences, type BrowserLinkTarget } from '@/tauri/appPreferences'

interface OpenExternalUrlOptions {
  target?: BrowserLinkTarget
}

export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false

  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function isLocalHttpUrl(value: string | null | undefined): value is string {
  if (!isHttpUrl(value)) return false

  const hostname = new URL(value).hostname.toLowerCase()
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  )
}

async function preferredLinkTarget(value: string): Promise<BrowserLinkTarget> {
  const preferences = await getAppPreferences()
  return isLocalHttpUrl(value)
    ? preferences.browserLocalLinkTarget
    : preferences.browserExternalLinkTarget
}

async function openWithSystemBrowser(value: string): Promise<void> {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(value)
}

export async function openExternalUrl(
  value: string,
  options: OpenExternalUrlOptions = {}
): Promise<boolean> {
  if (!isHttpUrl(value)) {
    return false
  }

  if (isTauriRuntime()) {
    const target = options.target ?? (await preferredLinkTarget(value))
    if (target === 'wework' && requestEmbeddedBrowserOpen(value)) {
      return true
    }
    await openWithSystemBrowser(value)
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
