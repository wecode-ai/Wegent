import type { ConversationSummaryResource } from './conversationHostServices'
import type { WeworkDshSlotEntry } from './dshUiSlots'

export type ConversationSummaryContextValue = string | number | boolean | null | undefined

export interface ConversationSummaryContext {
  readonly [key: string]: ConversationSummaryContextValue
}

export interface ConversationSummarySurfaceServices {
  canExecuteCommand(id: string): boolean
  executeCommand(id: string, args?: unknown): Promise<unknown>
  getService<T>(id: string): T | undefined
  openResource(resource: ConversationSummaryResource): Promise<void>
}

export interface ConversationSummarySurfaceProps {
  readonly context: ConversationSummaryContext
  readonly docked: boolean
  readonly onClose: () => void
  readonly services: ConversationSummarySurfaceServices
}

export function matchesConversationSummaryContext(
  context: ConversationSummaryContext,
  expression: unknown
): boolean {
  if (expression === undefined || expression === null) return true
  if (typeof expression === 'string') return Boolean(context[expression])
  if (Array.isArray(expression)) {
    return expression.every(item => matchesConversationSummaryContext(context, item))
  }
  if (typeof expression !== 'object') return false

  const record = expression as Record<string, unknown>
  if (Array.isArray(record.all)) {
    return record.all.every(item => matchesConversationSummaryContext(context, item))
  }
  if (Array.isArray(record.any)) {
    return record.any.some(item => matchesConversationSummaryContext(context, item))
  }
  if ('not' in record) return !matchesConversationSummaryContext(context, record.not)
  if (typeof record.key !== 'string' || !record.key) return false

  const value = context[record.key]
  if ('equals' in record) return Object.is(value, record.equals)
  if ('notEquals' in record) return !Object.is(value, record.notEquals)
  if (Array.isArray(record.in)) return record.in.some(candidate => Object.is(value, candidate))
  return Boolean(value)
}

export function hasMatchingConversationSummaryHostService(
  entries: readonly WeworkDshSlotEntry[],
  context: ConversationSummaryContext,
  serviceId: string
): boolean {
  return entries.some(
    entry =>
      entry.requiredHostServices?.includes(serviceId) &&
      matchesConversationSummaryContext(context, entry.when)
  )
}
