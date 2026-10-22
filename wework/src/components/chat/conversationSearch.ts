import type { Root, RootContent } from 'mdast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import {
  resolveAsyncRequestUserInputReplies,
  type AsyncRequestUserInputReply,
} from '@wegent/chat-core/runtime-user-input'
import { stripPluginWorkspaceResultMarkers } from '@wegent/chat-core/plugin-workspace-result'
import {
  getAssistantSearchPresentation,
  getAssistantSearchTextSources,
  getUserMessageTextContent,
} from '@wegent/collaboration/conversation'
import { stripUnsupportedContentReferenceCitations } from '@wegent/collaboration/markdown'

const parser = unified().use(remarkParse).use(remarkGfm)
const BLOCK_TYPES = new Set(['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow'])

export interface ConversationSearchMatch {
  messageId: string
  occurrence: number
}

const MAX_NAVIGABLE_MATCHES = 250
const repliesByMessages = new WeakMap<
  WorkbenchMessage[],
  Map<string, AsyncRequestUserInputReply[]>
>()

/** Associate replies within the same reading window that MessageList renders. */
export function conversationReplyQuestions(messages: WorkbenchMessage[]) {
  const cached = repliesByMessages.get(messages)
  if (cached) return cached
  const replies = resolveAsyncRequestUserInputReplies(messages)
  repliesByMessages.set(messages, replies)
  return replies
}

function nodeText(node: Root | RootContent): string {
  if (node.type === 'image' || node.type === 'imageReference' || node.type === 'html') return ''
  if ('value' in node) return node.value
  if (!('children' in node)) return ''
  return node.children
    .map(child => nodeText(child as RootContent))
    .join(BLOCK_TYPES.has(node.type) ? '\n' : '')
}

export function conversationSearchText(
  message: WorkbenchMessage,
  replyQuestions?: AsyncRequestUserInputReply[]
): string {
  if (message.role === 'system') return ''
  if (message.role === 'user' && replyQuestions?.length) {
    return replyQuestions.map(row => `${row.question}\n${row.answer}`).join('\n')
  }
  const sources =
    message.role === 'user'
      ? [getUserMessageTextContent(message.content)]
      : getAssistantSearchTextSources(message).map(stripUnsupportedContentReferenceCitations)
  return sources.map(text => nodeText(parser.parse(text))).join('\n')
}

export function findConversationMatches(
  index: Array<{ messageId: string; text: string }>,
  query: string
): { matches: ConversationSearchMatch[]; totalMatches: number; isCapped: boolean } {
  const needle = query.trim().toLowerCase()
  const matches: ConversationSearchMatch[] = []
  let totalMatches = 0
  if (!needle) return { matches, totalMatches, isCapped: false }
  for (const entry of index) {
    const text = entry.text.toLowerCase()
    let occurrence = 0
    for (
      let offset = text.indexOf(needle);
      offset >= 0;
      offset = text.indexOf(needle, offset + needle.length)
    ) {
      if (matches.length < MAX_NAVIGABLE_MATCHES) {
        matches.push({ messageId: entry.messageId, occurrence })
      }
      occurrence += 1
      totalMatches += 1
    }
  }
  return { matches, totalMatches, isCapped: totalMatches > matches.length }
}

export interface ConversationFindMatch extends ConversationSearchMatch {
  itemId?: string
  itemOccurrence?: number
  turnId?: string
  replyQuestions?: string[]
  cursor?: string
  source?: 'page'
}

type SearchIndexEntry = {
  messageId: string
  text: string
  message: WorkbenchMessage
  itemId?: string
  source?: 'page'
}
type SearchUnit = { itemId: string; text: string }
const searchUnitsByMessage = new WeakMap<WorkbenchMessage, SearchUnit[] | null>()

/** Stable runtime item ids survive projection changes when an older page joins a turn. */
function searchUnits(message: WorkbenchMessage, text?: string): SearchUnit[] | null {
  if (!message.runtimeDisplayItems?.length || message.role !== 'assistant') return null
  const cached = searchUnitsByMessage.get(message)
  if (cached !== undefined) return cached
  const { blocks: displayBlocks } = getAssistantSearchPresentation(message)
  const blocks = new Map(displayBlocks.map(block => [block.id, block]))
  const units = message.runtimeDisplayItems.flatMap<SearchUnit>(item => {
    const block = blocks.get(item.id)
    const source =
      item.type === 'assistant_text'
        ? stripPluginWorkspaceResultMarkers(item.content)
        : block?.type === 'text'
          ? block.content
          : ''
    return source
      ? [
          {
            itemId: item.id,
            text: nodeText(parser.parse(stripUnsupportedContentReferenceCitations(source))),
          },
        ]
      : []
  })
  const actual = text ?? conversationSearchText(message)
  const result = units.map(unit => unit.text).join('\n') === actual ? units : null
  searchUnitsByMessage.set(message, result)
  return result
}

/** Index provider items once even when the reading window overlaps live messages. */
export function deduplicateConversationSearchIndex(
  entries: SearchIndexEntry[]
): SearchIndexEntry[] {
  const seen = new Set<string>()
  return entries.flatMap(entry => {
    const units = searchUnits(entry.message, entry.text)
    const rows = units
      ? units.map(unit => ({
          ...entry,
          messageId: unit.itemId,
          itemId: unit.itemId,
          text: unit.text,
        }))
      : [entry]
    return rows.filter(row => {
      const key = row.itemId ?? row.message.id
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })
}

function countOccurrences(text: string, query: string): number {
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  const haystack = text.toLowerCase()
  let count = 0
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    count += 1
  return count
}

type UnitMatchCount = { itemId: string; preceding: number; count: number }
const unitCountsByMessage = new WeakMap<
  WorkbenchMessage,
  { query: string; counts: UnitMatchCount[] }
>()

function unitMatchCounts(
  message: WorkbenchMessage,
  query: string,
  text?: string
): UnitMatchCount[] {
  const cached = unitCountsByMessage.get(message)
  if (cached?.query === query) return cached.counts
  let preceding = 0
  const counts = (searchUnits(message, text) ?? []).map(unit => {
    const count = countOccurrences(unit.text, query)
    const result = { itemId: unit.itemId, preceding, count }
    preceding += count
    return result
  })
  unitCountsByMessage.set(message, { query, counts })
  return counts
}

export function conversationMatchKey(match: ConversationFindMatch): string {
  return `${match.itemId ?? match.messageId}:${match.itemOccurrence ?? match.occurrence}`
}

export function mergeConversationMatches(
  local: ReturnType<typeof findConversationMatches>,
  index: SearchIndexEntry[],
  query: string,
  persisted?: import('@wegent/chat-core/runtime').RuntimeTranscriptSearchResponse
): { matches: ConversationFindMatch[]; totalMatches: number; isCapped: boolean } {
  const byId = new Map(index.map(entry => [entry.messageId, entry]))
  const userItemIds = new Map(
    persisted?.matches.flatMap(match =>
      match.messageId && match.itemId ? [[match.messageId, match.itemId] as const] : []
    )
  )
  const loaded = local.matches.map<ConversationFindMatch>(match => {
    const entry = byId.get(match.messageId)
    if (entry?.itemId)
      return {
        messageId: entry.message.id,
        occurrence: match.occurrence,
        itemId: entry.itemId,
        itemOccurrence: match.occurrence,
      }
    if (entry?.message.role === 'user' && userItemIds.has(match.messageId))
      return {
        ...match,
        itemId: userItemIds.get(match.messageId),
        itemOccurrence: match.occurrence,
      }
    const units = entry ? unitMatchCounts(entry.message, query, entry.text) : []
    for (const unit of units) {
      if (match.occurrence < unit.preceding + unit.count)
        return { ...match, itemId: unit.itemId, itemOccurrence: match.occurrence - unit.preceding }
    }
    return entry?.source ? { ...match, messageId: entry.message.id, source: entry.source } : match
  })
  if (!persisted) return { ...local, matches: loaded }
  const matches: ConversationFindMatch[] = persisted.matches.map(match => ({
    ...match,
    messageId: match.messageId ?? '',
    itemOccurrence: match.occurrence,
  }))
  const keys = new Set(matches.map(conversationMatchKey))
  let duplicates = 0
  for (const match of loaded) {
    const key = conversationMatchKey(match)
    if (keys.has(key)) duplicates += 1
    else {
      keys.add(key)
      matches.push(match)
    }
  }
  // A capped response cannot identify overlap outside its retained navigation window.
  const totalMatches = persisted.isCapped
    ? Math.max(persisted.totalMatches, local.totalMatches)
    : persisted.totalMatches + local.totalMatches - duplicates
  return {
    matches: matches.slice(0, MAX_NAVIGABLE_MATCHES),
    totalMatches,
    isCapped: persisted.isCapped || local.isCapped || totalMatches > MAX_NAVIGABLE_MATCHES,
  }
}

const visibleTextByMessage = new WeakMap<WorkbenchMessage, string>()
function cachedMessageText(
  message: WorkbenchMessage,
  replyQuestions?: AsyncRequestUserInputReply[]
): string {
  // A reply's presentation can change while its own message object stays unchanged.
  if (replyQuestions?.length) return conversationSearchText(message, replyQuestions)
  const cached = visibleTextByMessage.get(message)
  if (cached !== undefined) return cached
  const text = conversationSearchText(message)
  visibleTextByMessage.set(message, text)
  return text
}

function resolveMessageMatch(
  match: ConversationFindMatch,
  messages: WorkbenchMessage[],
  query: string
): ConversationSearchMatch | null {
  const message = match.itemId
    ? messages.find(
        message =>
          message.id === match.itemId ||
          (message.role === 'user' && message.id === match.messageId) ||
          message.runtimeDisplayItems?.some(item => item.id === match.itemId)
      )
    : messages.find(message => message.id === match.messageId)
  if (!message) return null
  const replyQuestions = conversationReplyQuestions(messages).get(message.id)
  if (
    match.replyQuestions &&
    (match.replyQuestions.length !== (replyQuestions?.length ?? 0) ||
      match.replyQuestions.some(
        (question, index) => question !== replyQuestions?.[index]?.question
      ))
  )
    return null
  if (!match.itemId || message.role === 'user' || !message.runtimeDisplayItems?.length) {
    if (
      match.cursor &&
      countOccurrences(cachedMessageText(message, replyQuestions), query) <= match.occurrence
    )
      return null
    return { messageId: message.id, occurrence: match.occurrence }
  }
  const unit = unitMatchCounts(message, query).find(unit => unit.itemId === match.itemId)
  const occurrence = match.itemOccurrence ?? match.occurrence
  if (unit && occurrence < unit.count)
    return { messageId: message.id, occurrence: unit.preceding + occurrence }
  return null
}

export function resolveConversationMatch(
  match: ConversationFindMatch,
  messages: WorkbenchMessage[],
  query: string,
  searchMessages?: WorkbenchMessage[]
): (ConversationSearchMatch & { source?: 'page' }) | null {
  if (searchMessages?.length && (match.itemId || match.cursor || match.source === 'page')) {
    const target = resolveMessageMatch(match, searchMessages, query)
    if (target) return { ...target, source: 'page' }
  }
  return resolveMessageMatch(match, messages, query)
}
