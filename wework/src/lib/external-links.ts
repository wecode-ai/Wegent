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

const DINGTALK_URL_PATTERN = /^dingtalk:\/\//i

export function isDingTalkUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && DINGTALK_URL_PATTERN.test(value.trim())
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
  const trimmed = value.trim()
  if (!isHttpUrl(trimmed) && !isDingTalkUrl(trimmed)) {
    logExternalLink('rejected', value, source, { reason: 'unsupported-protocol' })
    return false
  }

  try {
    if (isElectronRuntime()) {
      // DingTalk links are handled by the client registered for the protocol.
      if (isDingTalkUrl(trimmed)) {
        await openWithSystemBrowser(trimmed)
        logExternalLink('opened', trimmed, source, { target: 'system' })
        return true
      }
      const target = options.target ?? (await preferredLinkTarget(trimmed))
      logExternalLink('resolved', trimmed, source, { target })
      if (target === 'wework') {
        const handedOff = requestEmbeddedBrowserOpen(trimmed)
        logExternalLink('browser-request', trimmed, source, { handedOff })
        if (handedOff) return true
        logExternalLink('browser-fallback', trimmed, source, { target: 'system' })
      }
      await openWithSystemBrowser(trimmed)
      logExternalLink('opened', trimmed, source, { target: 'system' })
      return true
    }

    window.open(trimmed, '_blank', 'noopener,noreferrer')
    logExternalLink('opened', trimmed, source, {
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
    if (!anchor || (!isHttpUrl(anchor.href) && !isDingTalkUrl(anchor.href))) return

    event.preventDefault()
    void openExternalUrl(anchor.href, { source: 'document' }).catch(error => {
      console.error('Failed to open external URL:', error)
    })
  }

  document.addEventListener('click', handleClick)
  return () => document.removeEventListener('click', handleClick)
}
