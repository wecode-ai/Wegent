import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

type SearchRequest = { query: string }
type SearchResult = ReturnType<typeof mergeConversationMatches>
type SearchSnapshot = { request: SearchRequest; result: SearchResult }
type RemoteSearch = {
  request: SearchRequest
  status: 'pending' | 'done' | 'failed'
  result?: RuntimeTranscriptSearchResponse
}
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
  const [searchRequest, setSearchRequest] = useState<SearchRequest>({ query: '' })
  const [completedRequest, setCompletedRequest] = useState(searchRequest)
  const [publishedSnapshot, setPublishedSnapshot] = useState<SearchSnapshot>({
    request: searchRequest,
    result: EMPTY_RESULT,
  })
  const [remoteSearch, setRemoteSearch] = useState<RemoteSearch | null>(null)
  const [hydration, setHydration] = useState<Hydration | null>(null)
  const [locationFailure, setLocationFailure] = useState<LocationFailure | null>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  const [selected, setSelected] = useState<Selection>({ index: 0 })
  const [navigationTarget, setNavigationTarget] = useState<{
    selection: Selection
    target: SearchTarget | null
  }>({ selection: selected, target: null })
  const [searchRetry, setSearchRetry] = useState(0)
  const [hydrationRetry, setHydrationRetry] = useState(0)
  const previousFocus = useRef<HTMLElement | null>(null)
  const { query } = searchRequest
  useLayoutEffect(() => {
    previousFocus.current = null
  }, [conversationKey])
  if (conversationKey !== props.conversationKey) {
    const request = { query: '' }
    setConversationKey(props.conversationKey)
    setOpen(false)
    setSearchRequest(request)
    setCompletedRequest(request)
    setPublishedSnapshot({ request, result: EMPTY_RESULT })
    setRemoteSearch(null)
    setHydration(null)
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
  useEffect(() => {
    if (!open || !active || !queryPending) return
    const startedAt = performance.now()
    const timer = window.setTimeout(() => {
      recordConversationDiagnostic('search-debounce', {
        queryLength: searchRequest.query.length,
        elapsedMs: performance.now() - startedAt,
      })
      setCompletedRequest(searchRequest)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [active, open, queryPending, searchRequest])

  useEffect(() => {
    if (!enabled || queryPending || !onSearchTranscript) return
    const controller = new AbortController()
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return
        setRemoteSearch({ request: completedRequest, status: 'pending' })
        return onSearchTranscript(completedRequest.query, controller.signal)
      })
      .then(result => {
        if (!controller.signal.aborted && result)
          setRemoteSearch({ request: completedRequest, status: 'done', result })
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRemoteSearch({ request: completedRequest, status: 'failed' })
      })
    return () => controller.abort()
  }, [enabled, queryPending, completedRequest, onSearchTranscript, searchRetry, conversationKey])

  const candidateResult = useMemo(() => {
    if (!indexReady || queryPending) return null
    if (
      onSearchTranscript &&
      (remoteSearch?.request !== completedRequest || remoteSearch.status !== 'done')
    )
      return null
    return measureSearch(
      'search-match',
      { queryLength: completedRequest.query.length, messageCount: searchIndex.length },
      () =>
        mergeConversationMatches(
          findConversationMatches(searchIndex, completedRequest.query),
          searchIndex,
          completedRequest.query,
          onSearchTranscript ? remoteSearch?.result : undefined
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
  const matchesRef = useRef({ match, resolvedMatch })
  useLayoutEffect(() => {
    matchesRef.current = { match, resolvedMatch }
  }, [match, resolvedMatch])
  const currentHydration =
    hydration?.selection === selected &&
    hydration.request === completedRequest &&
    hydration.request === publishedSnapshot.request &&
    hydration.key === matchKey
      ? hydration
      : null
  useEffect(() => {
    const { match, resolvedMatch } = matchesRef.current
    if (
      !enabled ||
      queryPending ||
      publishedSnapshot.request !== completedRequest ||
      !match?.cursor ||
      resolvedMatch
    )
      return
    const controller = new AbortController()
    const state = { request: publishedSnapshot.request, selection: selected, key: matchKey }
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return
        if (!onEnsureSearchMatch) throw new Error('Transcript match loading is unavailable')
        setHydration({ ...state, status: 'pending' })
        return onEnsureSearchMatch(match as RuntimeTranscriptSearchMatch, controller.signal)
      })
      .then(() => {
        if (!controller.signal.aborted) setHydration({ ...state, status: 'done' })
      })
      .catch(() => {
        if (!controller.signal.aborted) setHydration({ ...state, status: 'failed' })
      })
    return () => controller.abort()
  }, [
    enabled,
    queryPending,
    matchKey,
    selected,
    publishedSnapshot.request,
    completedRequest,
    onEnsureSearchMatch,
    hydrationRetry,
    conversationKey,
  ])
  // A successful load may dispatch React state before the projected message commits.
  useEffect(() => {
    if (currentHydration?.status !== 'done' || resolvedMatch || !enabled || queryPending) return
    const timer = window.setTimeout(() => {
      setHydration(state =>
        state === currentHydration ? { ...state, status: 'unresolved' } : state
      )
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [currentHydration, resolvedMatch, enabled, queryPending])

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
      queryPending ||
      publishedSnapshot.request !== completedRequest ||
      selected.index !== index ||
      !resolvedMatch ||
      currentHydration?.status === 'pending' ||
      currentHydration?.status === 'failed'
    )
      return null
    return { query: publishedSnapshot.request.query, ...resolvedMatch, matchCounts }
  }, [
    queryPending,
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
  const changeQuery = useCallback((value: string) => {
    const request = { query: value }
    setSearchRequest(request)
    if (!value.trim()) {
      setCompletedRequest(request)
      setPublishedSnapshot({ request, result: EMPTY_RESULT })
      setSelected({ index: 0 })
    }
  }, [])
  const close = useCallback(() => {
    setOpen(false)
    const request = { query: '' }
    setSearchRequest(request)
    setCompletedRequest(request)
    setPublishedSnapshot({ request, result: EMPTY_RESULT })
    setSelected({ index: 0 })
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true })
  }, [])
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
        setCompletedRequest(searchRequest)
        setSelected({ index: 0 })
        return
      }
      step(direction)
    },
    [query, searchRequest, publishedSnapshot.request, step]
  )
  useEffect(() => {
    if (!active) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposingEvent(event)) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (
        target?.closest(
          '.cm-editor, .xterm, [data-editor-search-surface], [data-pierre-editor-surface], [role="dialog"], [data-testid="workspace-browser-find-bar"]'
        )
      )
        return
      const primary =
        getPlatform() === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        if (!open) previousFocus.current = document.activeElement as HTMLElement | null
        const selection = window.getSelection()?.toString().trim()
        if (selection && !/[\r\n]/.test(selection)) changeQuery(selection)
        setOpen(true)
        setFocusRequest(current => current + 1)
      } else if (open && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [active, changeQuery, close, open])

  const searchFailed =
    !queryPending && remoteSearch?.request === completedRequest && remoteSearch.status === 'failed'
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
    onSearchTranscript &&
    (remoteSearch?.request !== completedRequest || remoteSearch.status === 'pending')
  )
  const historyLoading = Boolean(
    enabled &&
    !queryPending &&
    !failure &&
    (remotePending ||
      currentHydration?.status === 'pending' ||
      (currentHydration?.status === 'done' && !resolvedMatch))
  )
  const isLoading = enabled && (queryPending || historyLoading || Boolean(props.loading))
  useEffect(() => {
    if (!open || !active) return
    recordConversationDiagnostic('search-status', {
      queryPending,
      historyLoading,
      historyFailed,
      requestFailed: failure === 'request',
      locationFailed: failure === 'locate',
      loading: Boolean(props.loading),
      messageCount: props.messages.length,
    })
  }, [
    active,
    open,
    queryPending,
    historyLoading,
    historyFailed,
    failure,
    props.loading,
    props.messages.length,
  ])
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
        setRemoteSearch({ request: completedRequest, status: 'pending' })
        setSearchRetry(value => value + 1)
      } else if (currentHydration?.status === 'failed') {
        setHydration({ ...currentHydration, status: 'pending' })
        setHydrationRetry(value => value + 1)
      } else if (failure === 'locate') {
        // Rebuild the result and its anchor; reloading the same stale hit cannot repair it.
        setSearchRequest({ query })
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
