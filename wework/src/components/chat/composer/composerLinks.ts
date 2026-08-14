import { GENERIC_LINK_ICON_SRC, resolveAndProbeIcon, resolveFavicon } from '@/lib/favicon-resolver'
import {
  BARE_HTTP_URL_REGEX,
  getRecognizedLink,
  trimUrlBoundaries,
  type RecognizedLink,
} from '@/lib/link-preview'

export interface ComposerLinkPayload {
  url: string
  label: string
  iconUrl: string
  provider: string
}

export interface ParsedComposerLink extends ComposerLinkPayload {
  start: number
  end: number
}

const MARKDOWN_LINK_REGEX = new RegExp(
  '\\[!?([^\\]]*)\\]\\(([a-z][a-z0-9+.-]*:\\/\\/[^\\s)\\]]+)\\)',
  'gi'
)

function recognizedToParsed(
  recognized: RecognizedLink,
  start: number,
  end: number,
  label?: string
): ParsedComposerLink {
  return {
    url: recognized.url,
    label: label || recognized.label,
    iconUrl: recognized.iconUrl,
    provider: recognized.provider,
    start,
    end,
  }
}

export function parseComposerLinks(value: string): ParsedComposerLink[] {
  const links: ParsedComposerLink[] = []
  for (const match of value.matchAll(MARKDOWN_LINK_REGEX)) {
    const raw = match[0]
    const label = match[1] ?? ''
    const url = trimUrlBoundaries(match[2] ?? '')
    const recognized = getRecognizedLink(url)
    if (!recognized) continue
    const start = match.index ?? 0
    links.push(recognizedToParsed(recognized, start, start + raw.length, label || undefined))
  }
  for (const match of value.matchAll(BARE_HTTP_URL_REGEX)) {
    const start = match.index ?? 0
    const url = trimUrlBoundaries(match[0])
    const recognized = getRecognizedLink(url)
    if (!recognized) continue
    if (links.some(link => start >= link.start && start < link.end)) continue
    links.push(recognizedToParsed(recognized, start, start + url.length))
  }
  return links.sort((a, b) => a.start - b.start)
}

export function applyLinkIcon(icon: HTMLImageElement, payload: ComposerLinkPayload): void {
  const iconUrl =
    payload.iconUrl && payload.iconUrl !== GENERIC_LINK_ICON_SRC
      ? payload.iconUrl
      : (getRecognizedLink(payload.url)?.iconUrl ?? '')
  icon.src = iconUrl || GENERIC_LINK_ICON_SRC
  icon.onerror = () => {
    if (icon.src !== GENERIC_LINK_ICON_SRC) icon.src = GENERIC_LINK_ICON_SRC
  }
  if (payload.provider === 'web') {
    resolveAndProbeIcon(
      payload.url,
      resolveFavicon(payload.url),
      favicon => {
        if (icon.isConnected) icon.src = favicon
      },
      () => !icon.isConnected
    )
  }
}

export function createComposerLinkElement(payload: ComposerLinkPayload): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = 'composer-link-node composer-mention-link'
  element.setAttribute('data-testid', 'composer-link-chip')
  element.setAttribute('data-composer-link-url', payload.url)
  element.setAttribute('data-composer-link-provider', payload.provider)
  element.setAttribute('data-composer-link-label', payload.label)
  element.setAttribute('contenteditable', 'false')
  element.setAttribute('aria-label', payload.label)
  element.setAttribute('spellcheck', 'false')
  element.setAttribute('tabindex', '0')

  const iconSlot = document.createElement('span')
  iconSlot.className = 'composer-mention-icon-slot'
  iconSlot.setAttribute('aria-hidden', 'true')
  const icon = document.createElement('img')
  icon.className = 'composer-mention-icon'
  icon.alt = ''
  icon.loading = 'lazy'
  applyLinkIcon(icon, payload)
  iconSlot.append(icon)

  const label = document.createElement('span')
  label.className = 'composer-mention-label'
  label.textContent = payload.label

  element.append(iconSlot, label)
  return element
}
