import { traceConversationSearch } from './conversationSearchTrace'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type {
  RuntimeTranscriptSearchMatch,
  RuntimeTranscriptSearchResponse,
} from '@wegent/chat-core/runtime'

export type ConversationSearchScope = string | number | null | undefined

export type TranscriptSearch = (
  query: string,
  signal: AbortSignal
) => Promise<RuntimeTranscriptSearchResponse>
export type MatchHydration = (
  match: RuntimeTranscriptSearchMatch,
  signal: AbortSignal
) => Promise<void>

export function createTranscriptSearchResource(
  conversationKey: ConversationSearchScope,
  query: string,
  search?: TranscriptSearch
) {
  if (!search) return undefined
  return createAsyncResource(
    `conversation-search/${conversationKey ?? ''}`,
    signal =>
      traceConversationSearch(
        'search-transcript-request',
        signal,
        { queryLength: query.length },
        () => search(query, signal)
      ),
    {
      refreshOnSubscribe: true,
    }
  )
}

export function createMatchHydrationResource(
  conversationKey: ConversationSearchScope,
  match: RuntimeTranscriptSearchMatch,
  hydrate?: MatchHydration
) {
  return createAsyncResource(`conversation-match/${conversationKey ?? ''}`, signal =>
    traceConversationSearch('search-hydration-request', signal, {}, async () => {
      if (!hydrate) throw new Error('Transcript match loading is unavailable')
      await hydrate(match, signal)
      return { completedAt: Date.now() }
    })
  )
}
