import type { ComponentType } from 'react'

export type ComposerTriggerKind = 'mention' | 'skill' | 'slash'

export interface ComposerTextTrigger {
  kind: ComposerTriggerKind
  start: number
  query: string
}

export interface SlashCommand<App = unknown, Skill = unknown> {
  id: string
  title: string
  description?: string
  metaLabel?: string
  group?: string
  searchAliases?: string[]
  requiresEmptyComposer?: boolean
  Icon: ComponentType<{ className?: string }>
  iconUrl?: string | null
  iconContrastPad?: boolean
  trailingIcon?: ComponentType<{ className?: string }>
  enabled?: boolean
  testId: string
  skill?: Skill
  app?: App
  extensionCommand?: {
    command: string
    menuId: string
  }
  onSelect?: () => void
}

const SLASH_ONLY_PATTERN = /^\s*\/[^/\r\n]*\s*$/

export function findStandaloneTrigger(
  value: string,
  cursor: number,
  trigger: '@' | '$' | '/' | '#',
  kind: ComposerTriggerKind,
  allowWhitespaceInQuery?: (query: string) => boolean
): ComposerTextTrigger | null {
  const beforeCursor = value.slice(0, cursor)
  const triggerIndex = beforeCursor.lastIndexOf(trigger)
  if (triggerIndex < 0) return null

  const previousChar = triggerIndex > 0 ? value[triggerIndex - 1] : ''
  if (triggerIndex > 0 && !/\s/.test(previousChar)) return null

  const query = value.slice(triggerIndex + 1, cursor)
  if (/\s/.test(query) && !allowWhitespaceInQuery?.(query)) return null
  if (trigger === '/' && query.includes('/')) return null

  return { kind, start: triggerIndex, query }
}

export function chooseNearestTrigger(
  triggers: Array<ComposerTextTrigger | null>
): ComposerTextTrigger | null {
  return (
    triggers
      .filter((trigger): trigger is ComposerTextTrigger => trigger !== null)
      .sort((left, right) => right.start - left.start)[0] ?? null
  )
}

/**
 * Parses the `@项目空间:keyword` / `@项目空间 keyword` scope syntax. Returns
 * the keyword after the separator when the query starts with one of the given
 * scope labels followed by a half-width/full-width colon or whitespace,
 * otherwise null. Labels are matched longest-first so labels containing
 * spaces (e.g. "project space") win over shorter prefixes.
 */
export function parseCloudProjectScopeQuery(query: string, scopeLabels: string[]): string | null {
  const labels = scopeLabels
    .map(label => label.trim().toLowerCase())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  const normalizedQuery = query.toLowerCase()
  for (const label of labels) {
    if (!normalizedQuery.startsWith(label)) continue
    const rest = query.slice(label.length)
    const separatorMatch = rest.match(/^[:：]|\s+/)
    if (!separatorMatch) return null
    return rest.slice(separatorMatch[0].length)
  }
  return null
}

export function hasDraftTextForSlashCommands(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && !SLASH_ONLY_PATTERN.test(value)
}

export function filterSlashCommands<T extends SlashCommand>(
  commands: T[],
  query: string,
  hasDraftText: boolean,
  compareApps?: (left: T, right: T) => number
): T[] {
  const draftCompatibleCommands = hasDraftText
    ? commands.filter(command => !command.requiresEmptyComposer)
    : commands
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return draftCompatibleCommands

  const groupOrder = new Map<string | null, number>()
  draftCompatibleCommands.forEach(command => {
    const group = command.group ?? null
    if (!groupOrder.has(group)) groupOrder.set(group, groupOrder.size)
  })

  return draftCompatibleCommands
    .map(command => ({ command, score: scoreSlashCommand(command, normalizedQuery) }))
    .filter(item => item.score > 0)
    .sort((left, right) => {
      const leftGroupOrder = groupOrder.get(left.command.group ?? null) ?? Number.MAX_SAFE_INTEGER
      const rightGroupOrder = groupOrder.get(right.command.group ?? null) ?? Number.MAX_SAFE_INTEGER
      if (leftGroupOrder !== rightGroupOrder) return leftGroupOrder - rightGroupOrder
      if (left.score !== right.score) return right.score - left.score
      if (left.command.app && right.command.app && compareApps) {
        return compareApps(left.command, right.command)
      }
      return left.command.title.localeCompare(right.command.title)
    })
    .map(item => item.command)
}

export function groupedSlashCommands<T extends SlashCommand>(commands: T[]) {
  const groups: Array<{ label: string | null; commands: T[] }> = []
  commands.forEach(command => {
    const label = command.group ?? null
    const current = groups.at(-1)
    if (current && current.label === label) {
      current.commands.push(command)
      return
    }
    groups.push({ label, commands: [command] })
  })
  return groups
}

function scoreSlashCommand(command: SlashCommand, query: string): number {
  const aliases = command.searchAliases ?? []
  return Math.max(
    scoreText(command.title, query),
    scoreText(command.id, query),
    ...aliases.map(alias => scoreText(alias, query))
  )
}

function scoreText(value: string, query: string): number {
  const text = value.toLowerCase()
  if (text === query) return 100
  if (text.startsWith(query)) return 80
  if (text.split(/[-_\s]+/).some(part => part.startsWith(query))) return 65
  if (text.includes(query)) return 45
  return 0
}

export function resolveComposerAutocompleteTrigger(
  current: { value: string; selectionOffset: number },
  currentMenu: { kind: ComposerTriggerKind; trigger: ComposerTextTrigger } | null,
  supportsSkills: boolean,
  cloudProjectScopeLabels: string[],
  supportsIssueReferences = false
) {
  const nextTrigger = chooseNearestTrigger([
    supportsIssueReferences
      ? findStandaloneTrigger(current.value, current.selectionOffset, '#', 'mention')
      : null,
    findStandaloneTrigger(
      current.value,
      current.selectionOffset,
      '@',
      'mention',
      // Keep the trigger alive across whitespace once the query is inside
      // the `@项目空间 keyword` scope so typed phrases like
      // `@项目空间 新建项目` keep filtering instead of closing the menu.
      query => parseCloudProjectScopeQuery(query, cloudProjectScopeLabels) !== null
    ),
    supportsSkills
      ? findStandaloneTrigger(current.value, current.selectionOffset, '$', 'skill')
      : null,
    findStandaloneTrigger(current.value, current.selectionOffset, '/', 'slash'),
  ])
  const currentTriggerEnd = currentMenu
    ? currentMenu.trigger.start + 1 + currentMenu.trigger.query.length
    : null
  const nextTriggerEnd = nextTrigger ? nextTrigger.start + 1 + nextTrigger.query.length : null
  const triggerUnchanged =
    currentMenu &&
    nextTrigger &&
    currentMenu.kind === nextTrigger.kind &&
    currentMenu.trigger.start === nextTrigger.start &&
    currentTriggerEnd === nextTriggerEnd &&
    currentMenu.trigger.query === nextTrigger.query

  return { nextTrigger, triggerUnchanged: Boolean(triggerUnchanged) }
}
