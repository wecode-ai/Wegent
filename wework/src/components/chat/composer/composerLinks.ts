import { getRecognizedLink } from '@/lib/link-preview'

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

const URL_REGEX = new RegExp('https?:\\/\\/[^\\s)\\]}]+', 'gi')

export function parseComposerLinks(value: string): ParsedComposerLink[] {
  const links: ParsedComposerLink[] = []
  for (const match of value.matchAll(URL_REGEX)) {
    const raw = match[0]
    const recognized = getRecognizedLink(raw)
    if (!recognized) continue
    const start = match.index ?? 0
    links.push({
      url: recognized.url,
      label: recognized.label,
      iconUrl: recognized.iconUrl,
      provider: recognized.provider,
      start,
      end: start + raw.length,
    })
  }
  return links
}

export function createComposerLinkElement(payload: ComposerLinkPayload): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = 'composer-link-node composer-mention-link'
  element.setAttribute('data-testid', 'composer-link-chip')
  element.setAttribute('data-composer-link-url', payload.url)
  element.setAttribute('data-composer-link-provider', payload.provider)
  element.setAttribute('contenteditable', 'false')
  element.setAttribute('aria-label', payload.label)
  element.setAttribute('spellcheck', 'false')
  element.setAttribute('tabindex', '-1')

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
