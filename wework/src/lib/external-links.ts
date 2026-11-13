import { isHttpUrl } from '@wegent/chat-core/http-url'
export { isHttpUrl } from '@wegent/chat-core/http-url'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from './runtime-environment'
import { requestEmbeddedBrowserOpen } from './embedded-browser'
import { browserDiagnosticOrigin } from './browser-url'
import { getAppPreferences, type BrowserLinkTarget } from '@/desktop/appPreferences'
import { openWeworkScheme } from '@/features/notifications/schemeEvents'
import { parseConversationMentionHref } from './conversation-mentions'
import { parseIssueMentionHref } from './issue-mentions'

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

/** Explicit browser-toolbar action; does not broaden document link handling. */
export async function openInExternalBrowser(value: string): Promise<void> {
  const url = new URL(value)
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) {
    throw new Error('Unsupported external browser URL')
  }
  if (isElectronRuntime()) {
    await invokeDesktopHost<void>('browser.openExternal', { url: url.href })
    return
  }
  if (url.protocol === 'file:') throw new Error('Local browser opening requires the desktop app')
  window.open(url.href, '_blank', 'noopener,noreferrer')
}

export async function openExternalUrl(
  value: string,
  options: OpenExternalUrlOptions = {}
): Promise<boolean> {
  const source = options.source ?? 'unknown'
  if (value.startsWith('wework:')) {
    const opened = openWeworkScheme(value)
    logExternalLink(opened ? 'opened' : 'rejected', value, source, { target: 'wework' })
    return opened
  }
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

function isAnchor(node: EventTarget | null): node is Element {
  return (
    node instanceof Element &&
    node.localName === 'a' &&
    (node.hasAttribute('href') || node.hasAttributeNS('http://www.w3.org/1999/xlink', 'href'))
  )
}

function anchorHref(anchor: Element): string {
  return (
    anchor.getAttribute('href') ??
    anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
    ''
  )
}

function resolvedAnchorHref(anchor: Element): string {
  try {
    return new URL(anchorHref(anchor), anchor.baseURI).href
  } catch {
    return ''
  }
}

function findClickedAnchor(event: MouseEvent): Element | null {
  const composed = event.composedPath().find(isAnchor)
  if (composed instanceof Element) return composed
  const target = event.target
  if (!(target instanceof Element)) return null
  const anchor = target.closest('a')
  return isAnchor(anchor) ? anchor : null
}

export function installExternalLinkHandler() {
  const rejectUnsafeLink = (event: MouseEvent) => {
    const anchor = findClickedAnchor(event)
    if (!anchor) return
    const href = anchorHref(anchor)
    if (parseConversationMentionHref(href) || parseIssueMentionHref(href)) {
      // Internal references navigate through their owning React handler, never the browser.
      event.preventDefault()
      return
    }
    if (
      !isHttpUrl(resolvedAnchorHref(anchor)) &&
      !href.startsWith('#') &&
      !href.startsWith('wework:')
    ) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  const handleClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return
    const anchor = findClickedAnchor(event)
    if (!anchor) return
    const target = anchorHref(anchor).trim()
    if (!target || target === '#') {
      event.preventDefault()
      return
    }
    if (target.startsWith('#')) return
    const href = resolvedAnchorHref(anchor)
    if (!isHttpUrl(href)) return

    event.preventDefault()
    void openExternalUrl(href, { source: 'document' }).catch(error => {
      console.error('Failed to open external URL:', error)
    })
  }

  // Capture before third-party document renderers or propagation-stopping handlers.
  document.addEventListener('click', rejectUnsafeLink, true)
  document.addEventListener('auxclick', rejectUnsafeLink, true)
  document.addEventListener('click', handleClick)
  return () => {
    document.removeEventListener('click', rejectUnsafeLink, true)
    document.removeEventListener('auxclick', rejectUnsafeLink, true)
    document.removeEventListener('click', handleClick)
  }
}
