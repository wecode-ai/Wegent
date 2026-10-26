import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeTranscriptSearchResponse } from '@wegent/chat-core/runtime'
import {
  matchConversationText,
  type ConversationSearchRegion,
  type ConversationTextRange,
} from '@wegent/chat-core/conversation-search'
import {
  resolveAsyncRequestUserInputReplies,
  type AsyncRequestUserInputReply,
} from '@wegent/chat-core/runtime-user-input'
import {
  getAssistantRenderProjection,
  getUserMessageTextProjection,
  projectConversationSearchRegion,
} from '@wegent/collaboration/conversation'

export interface ConversationSearchMatch {
  messageId: string
  occurrence: number
  regionId?: string
  range?: ConversationTextRange
}

export interface ConversationFindMatch extends ConversationSearchMatch {
  itemId?: string
  itemOccurrence?: number
  turnId?: string
  replyQuestions?: string[]
  cursor?: string
  source?: 'page'
}

const MAX_NAVIGABLE_MATCHES = 250
const repliesByMessages = new WeakMap<
  WorkbenchMessage[],
  Map<string, AsyncRequestUserInputReply[]>
>()
const projectionsByMessage = new WeakMap<WorkbenchMessage, ConversationSearchRegion[]>()

/** Associate replies within the same reading window that MessageList renders. */
export function conversationReplyQuestions(messages: WorkbenchMessage[]) {
  const cached = repliesByMessages.get(messages)
  if (cached) return cached
  const replies = resolveAsyncRequestUserInputReplies(messages)
  repliesByMessages.set(messages, replies)
  return replies
}

/** Each row is one actual Markdown render region, never one independently parsed item. */
export function getConversationSearchProjection(
  message: WorkbenchMessage,
  replyQuestions?: AsyncRequestUserInputReply[]
): ConversationSearchRegion[] {
  if (message.role === 'system') return []
  if (!replyQuestions?.length) {
    const cached = projectionsByMessage.get(message)
    if (cached) return cached
  }
  let regions: ConversationSearchRegion[]
  if (message.role === 'assistant') {
    regions = getAssistantRenderProjection(message).regions.map(region =>
      projectConversationSearchRegion(region)
    )
  } else {
    const id = message.runtimeItemId ?? message.id
    const request = getUserMessageTextProjection(message.content)
    const content = replyQuestions?.length
      ? replyQuestions.map(row => `${row.question}\n${row.answer}`).join('\n')
      : request.content
    let answerOffset = 0
    const replySources = replyQuestions?.flatMap(row => {
      const start = answerOffset + row.question.length + 1
      answerOffset = start + row.answer.length + 1
      const sourceStart = message.content.indexOf(row.answer)
      return sourceStart < 0 || !row.answer
        ? []
        : [
            {
              itemId: id,
              start,
              end: start + row.answer.length,
              sourceStart,
              sourceEnd: sourceStart + row.answer.length,
            },
          ]
    })
    const region = {
      id,
      content,
      sources: replySources ?? [
        {
          itemId: id,
          start: 0,
          end: content.length,
          sourceStart: request.sourceStart,
          sourceEnd: request.sourceEnd,
        },
      ],
    }
    regions = replyQuestions?.length
      ? [{ id, text: content, sources: region.sources }]
      : [projectConversationSearchRegion(region, false)]
  }
  if (!replyQuestions?.length) projectionsByMessage.set(message, regions)
  return regions
}

export function conversationSearchText(
  message: WorkbenchMessage,
  replyQuestions?: AsyncRequestUserInputReply[]
): string {
  return getConversationSearchProjection(message, replyQuestions)
    .map(region => region.text)
    .join('\n')
}

type SearchIndexEntry = {
  messageId: string
  text?: string
  message: WorkbenchMessage
  itemId?: string
  regionId?: string
  replyQuestions?: AsyncRequestUserInputReply[]
  source?: 'page'
}

/** Stable region ids survive overlap between loaded context and live messages. */
export function deduplicateConversationSearchIndex(
  entries: SearchIndexEntry[]
): Array<SearchIndexEntry & { text: string }> {
  const seen = new Set<string>()
  return entries.flatMap(entry =>
    getConversationSearchProjection(entry.message, entry.replyQuestions).flatMap(region => {
      if (seen.has(region.id)) return []
      seen.add(region.id)
      return [
        {
          ...entry,
          messageId: region.id,
          itemId: region.id,
          regionId: region.id,
          text: region.text,
        },
      ]
    })
  )
}

export function findConversationMatches(
  index: Array<{ messageId: string; text: string; regionId?: string }>,
  query: string
): { matches: ConversationSearchMatch[]; totalMatches: number; isCapped: boolean } {
  const matches: ConversationSearchMatch[] = []
  let totalMatches = 0
  for (const entry of index) {
    const ranges = matchConversationText(entry.text, query)
    ranges.forEach((range, occurrence) => {
      if (matches.length < MAX_NAVIGABLE_MATCHES) {
        matches.push({
          messageId: entry.messageId,
          occurrence,
          regionId: entry.regionId ?? entry.messageId,
          range,
        })
      }
    })
    totalMatches += ranges.length
  }
  return { matches, totalMatches, isCapped: totalMatches > matches.length }
}

export function conversationMatchKey(match: ConversationFindMatch): string {
  return `${match.regionId ?? match.itemId ?? match.messageId}:${match.itemOccurrence ?? match.occurrence}`
}

export function mergeConversationMatches(
  local: ReturnType<typeof findConversationMatches>,
  index: SearchIndexEntry[],
  _query: string,
  persisted?: RuntimeTranscriptSearchResponse
): { matches: ConversationFindMatch[]; totalMatches: number; isCapped: boolean } {
  const byId = new Map(index.map(entry => [entry.messageId, entry]))
  const userItemIds = new Map(
    persisted?.matches.flatMap(match =>
      match.messageId && match.itemId
        ? [[match.messageId, match.regionId ?? match.itemId] as const]
        : []
    )
  )
  const loaded = local.matches.map<ConversationFindMatch>(match => {
    const entry = byId.get(match.messageId)
    const regionId =
      entry?.message.role === 'user'
        ? (userItemIds.get(entry.message.id) ?? match.regionId)
        : match.regionId
    return {
      ...match,
      messageId: entry?.message.id ?? match.messageId,
      regionId,
      itemId: regionId,
      itemOccurrence: match.occurrence,
      source: entry?.source,
    }
  })
  if (!persisted) return { ...local, matches: loaded }
  const matches: ConversationFindMatch[] = persisted.matches.map(match => ({
    ...match,
    messageId: match.messageId ?? '',
    regionId: match.regionId ?? match.itemId,
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
  const totalMatches = persisted.isCapped
    ? Math.max(persisted.totalMatches, local.totalMatches)
    : persisted.totalMatches + local.totalMatches - duplicates
  return {
    matches: matches.slice(0, MAX_NAVIGABLE_MATCHES),
    totalMatches,
    isCapped: persisted.isCapped || local.isCapped || totalMatches > MAX_NAVIGABLE_MATCHES,
  }
}

function resolveMessageMatch(
  match: ConversationFindMatch,
  messages: WorkbenchMessage[],
  query: string
): ConversationSearchMatch | null {
  const id = match.regionId ?? match.itemId
  const replies = conversationReplyQuestions(messages)
  for (const message of messages) {
    if (
      message.id !== match.messageId &&
      id &&
      message.id !== id &&
      message.runtimeItemId !== id &&
      !message.runtimeDisplayItems?.some(item => item.id === id) &&
      !message.blocks?.some(block => block.id === id)
    )
      continue
    if (!id && message.id !== match.messageId) continue
    const replyQuestions = replies.get(message.id)
    if (
      match.replyQuestions &&
      (match.replyQuestions.length !== (replyQuestions?.length ?? 0) ||
        match.replyQuestions.some(
          (question, index) => question !== replyQuestions?.[index]?.question
        ))
    )
      continue
    let preceding = 0
    for (const region of getConversationSearchProjection(message, replyQuestions)) {
      const ranges = matchConversationText(region.text, query)
      const regionMatches =
        !id ||
        region.id === id ||
        region.sources.some(source => source.itemId === id) ||
        (message.role === 'user' && message.id === match.messageId)
      if (regionMatches) {
        const occurrence = match.itemOccurrence ?? match.occurrence
        const range = ranges[occurrence]
        if (
          range &&
          (!match.range || (range.start === match.range.start && range.end === match.range.end))
        ) {
          return {
            messageId: message.id,
            occurrence: preceding + occurrence,
            regionId: region.id,
            range,
          }
        }
      }
      preceding += ranges.length
    }
  }
  return null
}

export function resolveConversationMatch(
  match: ConversationFindMatch,
  messages: WorkbenchMessage[],
  query: string,
  searchMessages?: WorkbenchMessage[]
): (ConversationSearchMatch & { source?: 'page' }) | null {
  if (
    searchMessages?.length &&
    (match.regionId || match.itemId || match.cursor || match.source === 'page')
  ) {
    const target = resolveMessageMatch(match, searchMessages, query)
    if (target) return { ...target, source: 'page' }
  }
  return resolveMessageMatch(match, messages, query)
}
