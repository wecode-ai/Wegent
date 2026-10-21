import { isHttpUrl } from '@wegent/chat-core/http-url'
export { isHttpUrl } from '@wegent/chat-core/http-url'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from './runtime-environment'
import { requestEmbeddedBrowserOpen } from './embedded-browser'
import { browserDiagnosticOrigin } from './browser-url'
import { getAppPreferences, type BrowserLinkTarget } from '@/desktop/appPreferences'

interface OpenExternalUrlOptions {
  target?: BrowserLinkTarget
  source?: string
}

function logExternalLink(
  event: string,
  value: string,
  source: string,
  details: Record<string, unknown> = {}
): void {
  console.info('[Wework][external-link]', {
    event,
    source,
    url: browserDiagnosticOrigin(value),
    ...details,
  })
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
  await invokeDesktopHost<void>('shell.openExternal', { url: value })
}

export async function openExternalUrl(
  value: string,
  options: OpenExternalUrlOptions = {}
): Promise<boolean> {
  const source = options.source ?? 'unknown'
  if (!isHttpUrl(value)) {
    logExternalLink('rejected', value, source, { reason: 'unsupported-protocol' })
    return false
  }

  try {
    if (isElectronRuntime()) {
      const target = options.target ?? (await preferredLinkTarget(value))
      logExternalLink('resolved', value, source, { target })
      if (target === 'wework') {
        const handedOff = requestEmbeddedBrowserOpen(value)
        logExternalLink('browser-request', value, source, { handedOff })
        if (handedOff) return true
        logExternalLink('browser-fallback', value, source, { target: 'system' })
      }
      await openWithSystemBrowser(value)
      logExternalLink('opened', value, source, { target: 'system' })
      return true
    }

    window.open(value, '_blank', 'noopener,noreferrer')
    logExternalLink('opened', value, source, {
      target: 'browser',
    })
    return true
  } catch (error) {
    logExternalLink('failed', value, source, {
      error: error instanceof Error ? error.name : typeof error,
    })
    throw error
  }
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
    void openExternalUrl(anchor.href, { source: 'document' }).catch(error => {
      console.error('Failed to open external URL:', error)
    })
  }

  document.addEventListener('click', handleClick)
  return () => document.removeEventListener('click', handleClick)
}
