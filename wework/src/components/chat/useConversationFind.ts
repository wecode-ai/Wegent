import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import {
  createTranscriptSearchResource,
  createMatchHydrationResource,
  type MatchHydration,
  type ConversationSearchScope,
} from './conversationSearchResources'
import {
  createConversationSearchInput,
  type ConversationSearchRequest as SearchRequest,
} from './conversationSearchInput'
import { getIdleResourceSnapshot, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { useDeadlineExpired } from '@wegent/collaboration/clock'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import type {
  ConversationSearchTarget,
  ScrollableMessageAreaProps,
} from '@wegent/collaboration/conversation'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type {
  RuntimeTranscriptSearchMatch,
  RuntimeTranscriptSearchResponse,
} from '@wegent/chat-core/runtime'
import {
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from '@wegent/collaboration/conversation/conversationDiagnostics'
import { getPlatform } from '@/lib/platform'
import { isImeComposingEvent } from '@/lib/ime'
import {
  conversationMatchKey,
  conversationReplyQuestions,
  deduplicateConversationSearchIndex,
  findConversationMatches,
  mergeConversationMatches,
  resolveConversationMatch,
} from './conversationSearch'

type SearchResult = ReturnType<typeof mergeConversationMatches>
type SearchSnapshot = { request: SearchRequest; result: SearchResult }
type Selection = { index: number }
type SearchTarget = NonNullable<ReturnType<typeof resolveConversationMatch>> & {
  query: string
  matchCounts: ReadonlyMap<string, number>
}
type Hydration = {
  request: SearchRequest
  selection: Selection
  key: string
  status: 'pending' | 'done' | 'failed' | 'unresolved'
}
type HydrationRequest = Omit<Hydration, 'status'> & {
  conversationKey: ConversationSearchScope
  match: RuntimeTranscriptSearchMatch
  load?: MatchHydration
}
type LocationFailure = { request: SearchRequest; selection: Selection; key: string }

const EMPTY_RESULT: SearchResult = { matches: [], totalMatches: 0, isCapped: false }

function sameSearchResult(left: SearchResult, right: SearchResult) {
  return (
    left.totalMatches === right.totalMatches &&
    left.isCapped === right.isCapped &&
    left.matches.length === right.matches.length &&
    left.matches.every((match, index) => {
      const other = right.matches[index]
      return (
        conversationMatchKey(match) === conversationMatchKey(other) &&
        match.messageId === other.messageId &&
        match.occurrence === other.occurrence &&
        match.regionId === other.regionId &&
        match.range?.start === other.range?.start &&
        match.range?.end === other.range?.end &&
        match.cursor === other.cursor &&
        match.replyQuestions?.length === other.replyQuestions?.length &&
        (match.replyQuestions?.every(
          (question, index) => question === other.replyQuestions?.[index]
        ) ??
          true)
      )
    })
  )
}

function sameSearchTarget(left: SearchTarget | null, right: SearchTarget | null) {
  if (left === right) return true
  return Boolean(
    left &&
    right &&
    left.query === right.query &&
    left.messageId === right.messageId &&
    left.occurrence === right.occurrence &&
    left.regionId === right.regionId &&
    left.range?.start === right.range?.start &&
    left.range?.end === right.range?.end &&
    left.source === right.source &&
    left.matchCounts.size === right.matchCounts.size &&
    [...left.matchCounts].every(([id, count]) => right.matchCounts.get(id) === count)
  )
}

export function useConversationFind(
  props: Pick<
    ScrollableMessageAreaProps,
    | 'conversationKey'
    | 'messages'
    | 'loading'
    | 'loadingMoreBefore'
    | 'loadedTranscriptRanges'
    | 'hasMoreBefore'
    | 'onLoadMoreBefore'
    | 'onLoadTranscriptGap'
  > & {
    onReleaseSearchPage?: () => void
    transcriptError?: string | null
    searchMessages?: WorkbenchMessage[]
    onSearchTranscript?: (
      query: string,
      signal: AbortSignal
    ) => Promise<RuntimeTranscriptSearchResponse>
    onEnsureSearchMatch?: (
      match: RuntimeTranscriptSearchMatch,
      signal: AbortSignal
    ) => Promise<void>
  },
  active: boolean
) {
  const [conversationKey, setConversationKey] = useState(props.conversationKey)
  const [open, setOpen] = useState(false)
  const input = useMemo(
    () => createConversationSearchInput(props.conversationKey),
    [props.conversationKey]
  )
  const releaseSearchPage = props.onReleaseSearchPage
  const subscribeInput = useCallback(
    (listener: () => void) =>
      open && active
        ? input.subscribeActive(listener, releaseSearchPage)
        : input.subscribe(listener, releaseSearchPage),
    [input, open, active, releaseSearchPage]
  )
  const { request: searchRequest, completed: completedRequest } = useSyncExternalStore(
    subscribeInput,
    input.getSnapshot,
    input.getSnapshot
  )
  const [publishedSnapshot, setPublishedSnapshot] = useState<SearchSnapshot>({
    request: searchRequest,
    result: EMPTY_RESULT,
  })
  const [hydrationRequest, setHydrationRequest] = useState<HydrationRequest | null>(null)
  const [locationFailure, setLocationFailure] = useState<LocationFailure | null>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  const [selected, setSelected] = useState<Selection>({ index: 0 })
  const [navigationTarget, setNavigationTarget] = useState<{
    selection: Selection
    target: SearchTarget | null
  }>({ selection: selected, target: null })
  const [focusOwner, setFocusOwner] = useState(() => ({
    conversationKey: props.conversationKey,
    element: null as HTMLElement | null,
  }))
  const { query } = searchRequest
  if (conversationKey !== props.conversationKey) {
    const request = searchRequest
    setConversationKey(props.conversationKey)
    setFocusOwner({ conversationKey: props.conversationKey, element: null })
    setOpen(false)
    setPublishedSnapshot({ request, result: EMPTY_RESULT })
    setHydrationRequest(null)
    setLocationFailure(null)
    setFocusRequest(0)
    setSelected({ index: 0 })
  }
  const hasQuery = Boolean(query.trim())
  const queryPending = hasQuery && searchRequest !== completedRequest
  const enabled = open && active && hasQuery
  const { onSearchTranscript, onEnsureSearchMatch } = props
  const indexReady = open && active && Boolean(completedRequest.query.trim()) && !props.loading
  const searchIndex = useMemo(() => {
    if (!indexReady) return []
    return measureSearch('search-index', { messageCount: props.messages.length }, () => {
      const pageMessages = props.searchMessages ?? []
      const liveReplies = conversationReplyQuestions(props.messages)
      const pageReplies = conversationReplyQuestions(pageMessages)
      return deduplicateConversationSearchIndex(
        [
          ...props.messages.map(message => ({ message, source: undefined })),
          ...(onSearchTranscript
            ? []
            : pageMessages.map(message => ({ message, source: 'page' as const }))),
        ].map(({ message, ...source }) => {
          const replyQuestions = (source.source === 'page' ? pageReplies : liveReplies).get(
            message.id
          )
          return {
            messageId: message.id,
            message,
            replyQuestions,
            ...source,
          }
        })
      )
    })
  }, [indexReady, onSearchTranscript, props.messages, props.searchMessages])
  const transcriptSource = useMemo(
    () =>
      createTranscriptSearchResource(conversationKey, completedRequest.query, onSearchTranscript),
    [conversationKey, completedRequest, onSearchTranscript]
  )
  const remoteSearch = useSyncExternalStore(
    enabled && !queryPending
      ? (transcriptSource?.subscribe ?? subscribeIdleResource)
      : subscribeIdleResource,
    transcriptSource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )

  const candidateResult = useMemo(() => {
    if (!indexReady || queryPending) return null
    if (onSearchTranscript && remoteSearch.status !== 'ready') return null
    return measureSearch(
      'search-match',
      { queryLength: completedRequest.query.length, messageCount: searchIndex.length },
      () =>
        mergeConversationMatches(
          findConversationMatches(searchIndex, completedRequest.query),
          searchIndex,
          completedRequest.query,
          onSearchTranscript ? remoteSearch.data : undefined
        )
    )
  }, [indexReady, queryPending, onSearchTranscript, remoteSearch, completedRequest, searchIndex])
  if (
    candidateResult &&
    (publishedSnapshot.request !== completedRequest ||
      !sameSearchResult(publishedSnapshot.result, candidateResult))
  ) {
    setPublishedSnapshot({ request: completedRequest, result: candidateResult })
  }
  const searchResult = enabled ? publishedSnapshot.result : EMPTY_RESULT
  const { matches, totalMatches, isCapped } = searchResult
  const index = selected.index < matches.length ? selected.index : 0
  if (selected.index !== index) setSelected({ index })
  const match = matches[index]
  const matchKey = match ? conversationMatchKey(match) : ''
  const resolvedMatch = useMemo(
    () =>
      match
        ? resolveConversationMatch(
            match,
            props.messages,
            publishedSnapshot.request.query,
            props.searchMessages
          )
        : null,
    [match, props.messages, props.searchMessages, publishedSnapshot.request]
  )
  const hydrationEnabled =
    enabled && !queryPending && publishedSnapshot.request === completedRequest
  const sameHydrationScope =
    hydrationRequest?.request === completedRequest &&
    hydrationRequest.request === publishedSnapshot.request &&
    hydrationRequest.selection === selected &&
    hydrationRequest.key === matchKey &&
    hydrationRequest.load === onEnsureSearchMatch &&
    hydrationRequest.conversationKey === conversationKey
  if (hydrationEnabled && match?.cursor && !resolvedMatch && !sameHydrationScope) {
    setHydrationRequest({
      request: publishedSnapshot.request,
      selection: selected,
      key: matchKey,
      conversationKey,
      match: match as RuntimeTranscriptSearchMatch,
      load: onEnsureSearchMatch,
    })
  } else if (hydrationRequest && (!hydrationEnabled || !sameHydrationScope)) {
    setHydrationRequest(null)
  }
  const hydrationSource = useMemo(
    () =>
      hydrationRequest
        ? createMatchHydrationResource(
            hydrationRequest.conversationKey,
            hydrationRequest.match,
            hydrationRequest.load
          )
        : undefined,
    [hydrationRequest]
  )
  const hydrationQuery = useSyncExternalStore(
    hydrationEnabled && sameHydrationScope
      ? (hydrationSource?.subscribe ?? subscribeIdleResource)
      : subscribeIdleResource,
    hydrationSource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const projectionExpired = useDeadlineExpired(
    hydrationEnabled &&
      sameHydrationScope &&
      !resolvedMatch &&
      hydrationQuery.status === 'ready' &&
      hydrationQuery.data
      ? hydrationQuery.data.completedAt + 1500
      : undefined
  )
  const hydrationStatus: Hydration['status'] =
    hydrationQuery.status === 'error'
      ? 'failed'
      : hydrationQuery.status === 'ready'
        ? projectionExpired
          ? 'unresolved'
          : 'done'
        : 'pending'
  const currentHydration = useMemo<Hydration | null>(
    () =>
      hydrationEnabled && sameHydrationScope && hydrationRequest
        ? {
            request: hydrationRequest.request,
            selection: hydrationRequest.selection,
            key: hydrationRequest.key,
            status: hydrationStatus,
          }
        : null,
    [hydrationEnabled, sameHydrationScope, hydrationRequest, hydrationStatus]
  )

  const matchCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const match of matches) {
      const target = resolveConversationMatch(
        match,
        props.messages,
        publishedSnapshot.request.query,
        props.searchMessages
      )
      if (target)
        counts.set(
          target.messageId,
          Math.max(counts.get(target.messageId) ?? 0, target.occurrence + 1)
        )
    }
    return counts
  }, [matches, props.messages, props.searchMessages, publishedSnapshot.request])
  const candidateTarget = useMemo(() => {
    if (
      publishedSnapshot.request !== completedRequest ||
      selected.index !== index ||
      !resolvedMatch ||
      currentHydration?.status === 'pending' ||
      currentHydration?.status === 'failed'
    )
      return null
    return { query: publishedSnapshot.request.query, ...resolvedMatch, matchCounts }
  }, [
    completedRequest,
    resolvedMatch,
    currentHydration,
    publishedSnapshot.request,
    matchCounts,
    selected,
    index,
  ])
  // Only a changed hit or an explicit selection should restart navigation.
  if (
    navigationTarget.selection !== selected ||
    !sameSearchTarget(navigationTarget.target, candidateTarget)
  )
    setNavigationTarget({ selection: selected, target: candidateTarget })
  const searchTarget = navigationTarget.target
  const reportNavigationFailure = useCallback(
    (target: ConversationSearchTarget) => {
      if (
        !enabled ||
        queryPending ||
        publishedSnapshot.request !== completedRequest ||
        !searchTarget ||
        target.query !== searchTarget.query ||
        target.messageId !== searchTarget.messageId ||
        target.regionId !== searchTarget.regionId ||
        target.range?.start !== searchTarget.range?.start ||
        target.range?.end !== searchTarget.range?.end ||
        target.occurrence !== searchTarget.occurrence
      )
        return
      setLocationFailure({ request: completedRequest, selection: selected, key: matchKey })
    },
    [
      enabled,
      queryPending,
      publishedSnapshot.request,
      searchTarget,
      completedRequest,
      selected,
      matchKey,
    ]
  )
  const changeQuery = useCallback(
    (value: string) => {
      const request = input.change(value)
      if (!value.trim()) {
        setPublishedSnapshot({ request, result: EMPTY_RESULT })
        setSelected({ index: 0 })
      }
    },
    [input]
  )
  const close = useCallback(() => {
    setOpen(false)
    const request = input.change('')
    setPublishedSnapshot({ request, result: EMPTY_RESULT })
    setSelected({ index: 0 })
    const element = focusOwner.element
    setFocusOwner({ conversationKey, element: null })
    if (focusOwner.conversationKey === conversationKey && element?.isConnected)
      element.focus({ preventScroll: true })
  }, [conversationKey, focusOwner, input])
  const step = useCallback(
    (direction: 1 | -1) => {
      if (matches.length)
        setSelected({ index: (index + direction + matches.length) % matches.length })
    },
    [index, matches.length]
  )
  const submit = useCallback(
    (direction: 1 | -1) => {
      if (publishedSnapshot.request.query.trim() !== query.trim()) {
        input.commit()
        setSelected({ index: 0 })
        return
      }
      step(direction)
    },
    [query, input, publishedSnapshot.request, step]
  )
  useWindowEvent(
    'keydown',
    event => {
      if (event.defaultPrevented || isImeComposingEvent(event)) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (
        target?.closest(
          '.cm-editor, .xterm, [data-editor-search-surface], [data-pierre-editor-surface], dialog[open], [role="dialog"], [data-testid="workspace-browser-find-bar"]'
        )
      )
        return
      const primary =
        getPlatform() === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        if (!open)
          setFocusOwner({
            conversationKey,
            element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
          })
        const selection = window.getSelection()?.toString().trim()
        if (selection && !/[\r\n]/.test(selection)) changeQuery(selection)
        setOpen(true)
        setFocusRequest(current => current + 1)
      } else if (open && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    },
    { enabled: active }
  )

  const searchFailed = !queryPending && remoteSearch.status === 'error'
  const failure =
    !enabled || queryPending
      ? null
      : searchFailed
        ? 'request'
        : currentHydration?.status === 'failed'
          ? 'load'
          : (currentHydration?.status === 'unresolved' && !resolvedMatch) ||
              (locationFailure?.request === completedRequest &&
                locationFailure.selection === selected &&
                locationFailure.key === matchKey)
            ? 'locate'
            : null
  const historyFailed = failure === 'load'
  const remotePending = Boolean(
    onSearchTranscript && (remoteSearch.status === 'idle' || remoteSearch.status === 'loading')
  )
  const historyLoading = Boolean(
    enabled &&
    !queryPending &&
    !failure &&
    (remotePending ||
      (publishedSnapshot.request === completedRequest && match?.cursor && !resolvedMatch) ||
      currentHydration?.status === 'pending')
  )
  const isLoading = enabled && (queryPending || historyLoading || Boolean(props.loading))
  return {
    open: open && active,
    query,
    queryPending,
    focusRequest,
    changeQuery,
    close,
    step,
    submit,
    navigationRequest: selected,
    searchTarget,
    reportNavigationFailure,
    result: { matches: totalMatches, active: matches.length ? index + 1 : 0, isCapped },
    isLoading,
    historyLoading,
    historyFailed: Boolean(historyFailed),
    failure,
    retry: () => {
      if (searchFailed) {
        if (transcriptSource?.getSnapshot().status === 'error') void transcriptSource.reload()
      } else if (currentHydration?.status === 'failed') {
        if (hydrationSource?.getSnapshot().status === 'error') void hydrationSource.reload()
      } else if (failure === 'locate') {
        // Rebuild the result and its anchor; reloading the same stale hit cannot repair it.
        input.change(query)
        setSelected({ index: 0 })
        setLocationFailure(null)
      }
    },
  }
}

// Diagnostic timing never participates in the memoized search result.
function measureSearch<T>(
  name: 'search-index' | 'search-match',
  details: Record<string, number>,
  compute: () => T
): T {
  if (!isConversationDiagnosticsEnabled()) return compute()
  const startedAt = performance.now()
  const result = compute()
  recordConversationDiagnostic(name, { ...details, elapsedMs: performance.now() - startedAt })
  return result
}
