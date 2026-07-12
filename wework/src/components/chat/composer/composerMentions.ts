const LOCAL_MENTION_REFERENCE_PATTERN =
  /\[\$([^\]]+)]\(((?:skill:\/\/[^)]+SKILL\.md)|(?:\/[^)\n]*SKILL\.md)|(?:app:\/\/[^)]+)|(?:plugin:\/\/[^)]+))\)/g
const COMPOSER_REFERENCE_PATTERN = /^\[\$[^\]]+]\(([^)\n]+)\)$/
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const COMPOSER_MENTION_ICON_PATHS = [
  'M16.5 9.4 7.55 4.24',
  'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
  'M3.29 7 12 12l8.71-5',
  'M12 22V12',
]

export interface ComposerMentionPayload {
  name: string
  label: string
  reference: string
}

export interface ParsedComposerMention extends ComposerMentionPayload {
  start: number
  end: number
}

export function localSkillTestId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function displaySkillNameFromName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function parseComposerMentions(value: string): ParsedComposerMention[] {
  return Array.from(value.matchAll(LOCAL_MENTION_REFERENCE_PATTERN)).map(match => {
    const start = match.index ?? 0
    const reference = match[0]
    const name = match[1]
    return {
      name,
      label: displaySkillNameFromName(name),
      reference,
      start,
      end: start + reference.length,
    }
  })
}

export function composerSkillFilePath(reference: string): string | null {
  const href = reference.match(COMPOSER_REFERENCE_PATTERN)?.[1]
  if (!href) return null
  const filePath = href.startsWith('skill://') ? href.slice('skill://'.length) : href
  return filePath.startsWith('/') && filePath.endsWith('/SKILL.md') ? filePath : null
}

export function replaceComposerMentionTrigger(
  value: string,
  reference: string,
  triggerStart: number,
  selectionEnd: number
): { value: string; cursor: number } {
  const replacement = `${reference} `
  return {
    value: value.slice(0, triggerStart) + replacement + value.slice(selectionEnd),
    cursor: triggerStart + replacement.length,
  }
}

export function findComposerMentionDeletionRange(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  key: 'Backspace' | 'Delete'
): { start: number; end: number; cursor: number } | null {
  const mentions = parseComposerMentions(value)
  if (selectionStart !== selectionEnd) {
    let start = selectionStart
    let end = selectionEnd
    let intersects = false
    mentions.forEach(mention => {
      if (mention.end <= start || mention.start >= end) return
      intersects = true
      start = Math.min(start, mention.start)
      end = Math.max(end, mention.end)
    })
    return intersects ? { start, end, cursor: start } : null
  }

  const cursor = selectionStart
  const mention = mentions.find(item =>
    key === 'Backspace'
      ? cursor > item.start && cursor <= item.end
      : cursor >= item.start && cursor < item.end
  )
  if (!mention) return null

  return { start: mention.start, end: mention.end, cursor: mention.start }
}

export function createComposerMentionElement(payload: ComposerMentionPayload): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = 'composer-mention-node composer-mention-link'
  element.setAttribute('data-testid', `local-skill-chip-${localSkillTestId(payload.name)}`)
  element.setAttribute('data-composer-skill-reference', payload.reference)
  element.setAttribute('data-composer-skill-name', payload.name)
  element.setAttribute('data-composer-skill-label', payload.label)
  const skillFilePath = composerSkillFilePath(payload.reference)
  if (skillFilePath) element.setAttribute('data-composer-skill-path', skillFilePath)
  element.setAttribute('contenteditable', 'false')
  element.setAttribute('aria-label', payload.label)
  element.setAttribute('spellcheck', 'false')
  element.setAttribute('tabindex', '-1')

  const iconSlot = document.createElement('span')
  iconSlot.className = 'composer-mention-icon-slot'
  iconSlot.setAttribute('aria-hidden', 'true')
  iconSlot.append(createComposerMentionIcon())

  const label = document.createElement('span')
  label.className = 'composer-mention-label'
  label.textContent = payload.label

  element.append(iconSlot, label)
  return element
}

function createComposerMentionIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg')
  icon.classList.add('composer-mention-icon')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('fill', 'none')
  icon.setAttribute('stroke', 'currentColor')
  icon.setAttribute('stroke-width', '2')
  icon.setAttribute('stroke-linecap', 'round')
  icon.setAttribute('stroke-linejoin', 'round')
  COMPOSER_MENTION_ICON_PATHS.forEach(pathData => {
    const path = document.createElementNS(SVG_NAMESPACE, 'path')
    path.setAttribute('d', pathData)
    icon.append(path)
  })
  return icon
}
