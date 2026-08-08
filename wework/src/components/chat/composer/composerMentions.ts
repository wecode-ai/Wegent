import { parsePluginMentionReference, parsePluginUri } from '@/features/plugins/pluginNavigation'
import {
  currentPluginLogoAppearanceMode,
  resolvePluginLogoUrl,
} from '@/components/plugins/plugin-assets'

const LOCAL_MENTION_REFERENCE_PATTERN =
  /\[\$([^\]]+)]\(((?:skill:\/\/[^)]+SKILL\.md)|(?:\/[^)\n]*SKILL\.md)|(?:app:\/\/[^)]+)|(?:plugin:\/\/[^)]+)|(?:file:\/\/[^)]+)|(?:folder:\/\/[^)]+)|(?:cloud:\/\/[^)]+)|(?:wework-conversation:\/\/[^)]+))\)/g
const COMPOSER_REFERENCE_PATTERN = /^\[\$[^\]]+]\(([^)\n]+)\)$/
const composerMentionIconUrls = new Map<string, string>()
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const COMPOSER_MENTION_ICON_PATHS = [
  'M16.5 9.4 7.55 4.24',
  'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
  'M3.29 7 12 12l8.71-5',
  'M12 22V12',
]
const COMPOSER_CONVERSATION_ICON_PATHS = [
  'M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z',
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

export function registerComposerMentionIcon(reference: string, iconUrl?: string | null): void {
  const href = reference.match(COMPOSER_REFERENCE_PATTERN)?.[1]
  const normalizedIconUrl = iconUrl?.trim()
  if (!href || !normalizedIconUrl) return
  composerMentionIconUrls.set(href, normalizedIconUrl)
}

export function getComposerMentionIconUrl(href: string): string | undefined {
  return composerMentionIconUrls.get(href)
}

/** Brand logo for plugin/app mentions; skills and other kinds return null (use the generic cube). */
export function resolveComposerMentionBrandIconUrl(href: string): string | null {
  const registered = getComposerMentionIconUrl(href)?.trim()
  if (registered) return registered

  const appearanceMode = currentPluginLogoAppearanceMode()
  const pluginReference = parsePluginUri(href)
  if (pluginReference) {
    return resolvePluginLogoUrl({
      pluginKey: pluginReference.pluginName,
      appearanceMode,
    })
  }

  if (href.startsWith('app://')) {
    const appId = href.slice('app://'.length).trim()
    return appId ? resolvePluginLogoUrl({ pluginKey: appId, appearanceMode }) : null
  }

  return null
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
    const uri = match[2]
    const isPathReference = uri.startsWith('file://') || uri.startsWith('folder://')
    const isConversationReference = uri.startsWith('wework-conversation://')
    return {
      name,
      label: isPathReference || isConversationReference ? name : displaySkillNameFromName(name),
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

export function composerPathReference(reference: string): {
  path: string
  directory: boolean
} | null {
  const href = reference.match(COMPOSER_REFERENCE_PATTERN)?.[1]
  if (!href) return null
  const directory = href.startsWith('folder://')
  if (!directory && !href.startsWith('file://')) return null
  const encodedPath = href.slice(directory ? 'folder://'.length : 'file://'.length)
  try {
    return { path: decodeURIComponent(encodedPath), directory }
  } catch {
    return null
  }
}

export function resolveComposerWorkspacePath(root: string, path: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(path)) return path
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${path.replace(/^[\\/]+/, '')}`
}

export function createComposerPathReference(path: string, directory: boolean): string {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.split('/').filter(Boolean).at(-1) ?? normalized
  const encodedPath = encodeURIComponent(path).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `[$${name}](${directory ? 'folder' : 'file'}://${encodedPath})`
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
  const pathReference = composerPathReference(payload.reference)
  const pluginReference = parsePluginMentionReference(payload.reference)
  const conversationReference = payload.reference.includes('](wework-conversation://')
  const displayLabel = pathReference ? composerPathDisplayName(pathReference.path) : payload.label
  element.setAttribute(
    'data-testid',
    pathReference
      ? `composer-path-chip-${localSkillTestId(payload.name)}`
      : pluginReference
        ? `composer-plugin-chip-${localSkillTestId(pluginReference.pluginName)}`
        : conversationReference
          ? `conversation-chip-${localSkillTestId(payload.name)}`
          : `local-skill-chip-${localSkillTestId(payload.name)}`
  )
  element.setAttribute('data-composer-skill-reference', payload.reference)
  element.setAttribute('data-composer-skill-name', payload.name)
  element.setAttribute('data-composer-skill-label', displayLabel)
  const skillFilePath = composerSkillFilePath(payload.reference)
  if (skillFilePath) element.setAttribute('data-composer-skill-path', skillFilePath)
  if (pathReference) {
    element.setAttribute('data-composer-path', pathReference.path)
    element.setAttribute('data-composer-path-kind', pathReference.directory ? 'folder' : 'file')
  }
  if (pluginReference) {
    element.setAttribute('data-composer-plugin-name', pluginReference.pluginName)
    element.setAttribute('data-composer-plugin-marketplace', pluginReference.marketplaceName)
    element.setAttribute('role', 'link')
  }
  element.setAttribute('contenteditable', 'false')
  element.setAttribute('aria-label', displayLabel)
  element.setAttribute('spellcheck', 'false')
  element.setAttribute('tabindex', pluginReference ? '0' : '-1')

  const iconSlot = document.createElement('span')
  iconSlot.className = 'composer-mention-icon-slot'
  iconSlot.setAttribute('aria-hidden', 'true')
  const mentionHref = payload.reference.match(COMPOSER_REFERENCE_PATTERN)?.[1]
  const brandIconUrl = mentionHref ? resolveComposerMentionBrandIconUrl(mentionHref) : null
  iconSlot.append(
    pathReference?.directory
      ? createComposerFolderIcon()
      : conversationReference
        ? createComposerConversationIcon()
        : brandIconUrl
          ? createComposerBrandIcon(brandIconUrl)
          : createComposerMentionIcon()
  )

  const label = document.createElement('span')
  label.className = 'composer-mention-label'
  label.textContent = displayLabel

  element.append(iconSlot, label)
  return element
}

function createComposerBrandIcon(iconUrl: string): HTMLImageElement {
  const icon = document.createElement('img')
  icon.className = 'composer-mention-icon composer-mention-brand-icon'
  icon.src = iconUrl
  icon.alt = ''
  return icon
}

function composerPathDisplayName(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '')
  return normalized.split('/').filter(Boolean).at(-1) ?? path
}

function createComposerFolderIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg')
  icon.classList.add('composer-mention-icon')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('fill', 'none')
  icon.setAttribute('stroke', 'currentColor')
  icon.setAttribute('stroke-width', '2')
  icon.setAttribute('stroke-linecap', 'round')
  icon.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS(SVG_NAMESPACE, 'path')
  path.setAttribute(
    'd',
    'M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'
  )
  icon.append(path)
  return icon
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

function createComposerConversationIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, 'svg')
  icon.classList.add('composer-mention-icon')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('fill', 'none')
  icon.setAttribute('stroke', 'currentColor')
  icon.setAttribute('stroke-width', '2')
  icon.setAttribute('stroke-linecap', 'round')
  icon.setAttribute('stroke-linejoin', 'round')
  COMPOSER_CONVERSATION_ICON_PATHS.forEach(pathData => {
    const path = document.createElementNS(SVG_NAMESPACE, 'path')
    path.setAttribute('d', pathData)
    icon.append(path)
  })
  return icon
}
