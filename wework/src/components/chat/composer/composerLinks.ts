import { getRecognizedLink, type RecognizedLink } from '@/lib/link-preview'

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

const MARKDOWN_LINK_REGEX = new RegExp('\\[!?([^\\]]*)\\]\\((https?:\\/\\/[^\\s)\\]]+)\\)', 'gi')
const BARE_URL_REGEX = new RegExp('https?:\\/\\/[^\\s)\\]}]+', 'gi')

function recognizedToParsed(
  recognized: RecognizedLink,
  start: number,
  end: number,
  label?: string
): ParsedComposerLink {
  return {
    url: recognized.url,
    label: label ?? recognized.label,
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
    const url = match[2] ?? ''
    const recognized = getRecognizedLink(url)
    if (!recognized) continue
    const start = match.index ?? 0
    links.push(recognizedToParsed(recognized, start, start + raw.length, label || undefined))
  }
  for (const match of value.matchAll(BARE_URL_REGEX)) {
    const raw = match[0]
    const recognized = getRecognizedLink(raw)
    if (!recognized) continue
    const start = match.index ?? 0
    if (links.some(link => start >= link.start && start < link.end)) continue
    links.push(recognizedToParsed(recognized, start, start + raw.length))
  }
  return links.sort((a, b) => a.start - b.start)
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
  icon.src = payload.iconUrl
  icon.alt = ''
  icon.loading = 'lazy'
  iconSlot.append(icon)

  const label = document.createElement('span')
  label.className = 'composer-mention-label'
  label.textContent = payload.label

  element.append(iconSlot, label)
  return element
}
