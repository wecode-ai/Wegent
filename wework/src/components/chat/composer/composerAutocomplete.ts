import type { ComponentType } from 'react'
import type { LocalDeviceApp, LocalDeviceSkill } from '@/types/api'

export type ComposerTriggerKind = 'mention' | 'skill' | 'slash'

export interface ComposerTextTrigger {
  kind: ComposerTriggerKind
  start: number
  query: string
}

export interface SlashCommand {
  id: string
  title: string
  description?: string
  metaLabel?: string
  group?: string
  searchAliases?: string[]
  requiresEmptyComposer?: boolean
  Icon: ComponentType<{ className?: string }>
  enabled?: boolean
  testId: string
  skill?: LocalDeviceSkill
  app?: LocalDeviceApp
  onSelect?: () => void
}

const SLASH_ONLY_PATTERN = /^\s*\/[^/\r\n]*\s*$/

export function findStandaloneTrigger(
  value: string,
  cursor: number,
  trigger: '@' | '$' | '/',
  kind: ComposerTriggerKind
): ComposerTextTrigger | null {
  const beforeCursor = value.slice(0, cursor)
  const triggerIndex = beforeCursor.lastIndexOf(trigger)
  if (triggerIndex < 0) return null

  const previousChar = triggerIndex > 0 ? value[triggerIndex - 1] : ''
  if (triggerIndex > 0 && !/\s/.test(previousChar)) return null

  const query = value.slice(triggerIndex + 1, cursor)
  if (/\s/.test(query)) return null
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

export function hasDraftTextForSlashCommands(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && !SLASH_ONLY_PATTERN.test(value)
}

export function filterSlashCommands(
  commands: SlashCommand[],
  query: string,
  hasDraftText: boolean
): SlashCommand[] {
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
      return left.command.title.localeCompare(right.command.title)
    })
    .map(item => item.command)
}

export function groupedSlashCommands(commands: SlashCommand[]) {
  const groups: Array<{ label: string | null; commands: SlashCommand[] }> = []
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
