import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ScrollableMessageAreaProps } from '@wegent/collaboration/conversation'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { resolveAsyncRequestUserInputReplies } from '@wegent/chat-core/runtime-user-input'
import {
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from '@wegent/collaboration/conversation/conversationDiagnostics'
import { getPlatform } from '@/lib/platform'
import { isImeComposingEvent } from '@/lib/ime'
import { conversationSearchText, findConversationMatches } from './conversationSearch'

type SearchSnapshot = {
  request: { query: string }
  result: ReturnType<typeof findConversationMatches>
}

const EMPTY_RESULT: SearchSnapshot['result'] = {
  matches: [],
  totalMatches: 0,
  isCapped: false,
}

const searchTextByMessage = new WeakMap<WorkbenchMessage, string>()

function cachedSearchText(message: WorkbenchMessage): string {
  const cached = searchTextByMessage.get(message)
  if (cached !== undefined) return cached
  const text = conversationSearchText(message)
  searchTextByMessage.set(message, text)
  return text
}

function sameSearchResult(left: SearchSnapshot['result'], right: SearchSnapshot['result']) {
  return (
    left.totalMatches === right.totalMatches &&
    left.isCapped === right.isCapped &&
    left.matches.length === right.matches.length &&
    left.matches.every(
      (match, index) =>
        match.messageId === right.matches[index].messageId &&
        match.occurrence === right.matches[index].occurrence
    )
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
  > & { transcriptError?: string | null },
  active: boolean
) {
  const [conversationKey, setConversationKey] = useState(props.conversationKey)
  const [open, setOpen] = useState(false)
  const [searchRequest, setSearchRequest] = useState({ query: '' })
  const [completedRequest, setCompletedRequest] = useState(searchRequest)
  const [publishedSnapshot, setPublishedSnapshot] = useState<SearchSnapshot>({
    request: searchRequest,
    result: EMPTY_RESULT,
  })
  const { query } = searchRequest
  const [focusRequest, setFocusRequest] = useState(0)
  const [selected, setSelected] = useState({ index: 0 })
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [retryRequest, setRetryRequest] = useState(0)
  const previousFocus = useRef<HTMLElement | null>(null)
  const attempted = useRef(new Set<string>())
  const historyGeneration = useRef(0)
  useLayoutEffect(() => {
    historyGeneration.current += 1
    previousFocus.current = null
    attempted.current.clear()
    return () => {
      historyGeneration.current += 1
    }
  }, [props.conversationKey])
  if (conversationKey !== props.conversationKey) {
    const request = { query: '' }
    setConversationKey(props.conversationKey)
    setOpen(false)
    setSearchRequest(request)
    setCompletedRequest(request)
    setPublishedSnapshot({ request, result: EMPTY_RESULT })
    setFocusRequest(0)
    setSelected({ index: 0 })
    setPending(false)
    setFailed(false)
    setRetryRequest(0)
  }
  const hasQuery = Boolean(query.trim())
  const queryPending = hasQuery && searchRequest !== completedRequest
  const { onLoadMoreBefore, onLoadTranscriptGap } = props
  const { gap, request } = useMemo(() => {
    const ranges = [...(props.loadedTranscriptRanges ?? [])].sort((a, b) => a.start - b.start)
    let end = ranges[0]?.end ?? 0
    let gap: { start: number; end: number } | undefined
    for (const range of ranges.slice(1)) {
      if (end < range.start) {
        gap = { start: end, end: range.start }
        break
      }
      end = Math.max(end, range.end)
    }
    const request =
      gap && onLoadTranscriptGap
        ? { key: `gap:${gap.start}:${gap.end}`, load: () => onLoadTranscriptGap(gap) }
        : props.hasMoreBefore && onLoadMoreBefore
          ? {
              key: `before:${ranges[0]?.start ?? props.messages[0]?.id}`,
              load: onLoadMoreBefore,
            }
          : null
    return { gap, request }
  }, [
    props.loadedTranscriptRanges,
    props.hasMoreBefore,
    props.messages,
    onLoadMoreBefore,
    onLoadTranscriptGap,
  ])
  const incomplete = Boolean(gap || props.hasMoreBefore)
  const historyFailed =
    (failed && incomplete) || Boolean(props.transcriptError) || (incomplete && !request)
  const historyLoading = Boolean(
    hasQuery &&
    (incomplete || props.loading || props.loadingMoreBefore || pending) &&
    !historyFailed
  )
  // Publish one complete transcript, never a partial page or an outdated query.
  const indexReady =
    open && active && Boolean(completedRequest.query.trim()) && !historyLoading && !historyFailed
  const searchReady = indexReady && hasQuery && !queryPending
  const searchIndex = useMemo(() => {
    if (!indexReady) return []
    return measureSearch('search-index', { messageCount: props.messages.length }, () => {
      const replies = resolveAsyncRequestUserInputReplies(props.messages)
      return props.messages.map(message => {
        const replyQuestions = replies.get(message.id)
        return {
          messageId: message.id,
          // Reply text also depends on questions in preceding messages.
          text: replyQuestions?.length
            ? conversationSearchText(message, replyQuestions)
            : cachedSearchText(message),
        }
      })
    })
  }, [indexReady, props.messages])
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
  const candidateResult = useMemo(() => {
    if (!searchReady) return null
    return measureSearch(
      'search-match',
      { queryLength: completedRequest.query.length, messageCount: searchIndex.length },
      () => findConversationMatches(searchIndex, completedRequest.query)
    )
  }, [searchReady, searchIndex, completedRequest])
  if (
    candidateResult &&
    (publishedSnapshot.request !== completedRequest ||
      !sameSearchResult(publishedSnapshot.result, candidateResult))
  ) {
    setPublishedSnapshot({ request: completedRequest, result: candidateResult })
  }
  const searchResult = open && active && hasQuery ? publishedSnapshot.result : EMPTY_RESULT
  const { matches, totalMatches, isCapped } = searchResult
  const index = selected.index < matches.length ? selected.index : 0
  const matchCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const match of matches) counts.set(match.messageId, (counts.get(match.messageId) ?? 0) + 1)
    return counts
  }, [matches])
  if (selected.index !== index) setSelected({ index })
  const searchTarget = useMemo(() => {
    const match = matches[selected.index]
    return match ? { query: publishedSnapshot.request.query, ...match, matchCounts } : null
  }, [matches, selected, publishedSnapshot.request, matchCounts])
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
      if (!matches.length) return
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

  useEffect(() => {
    if (
      !open ||
      !active ||
      queryPending ||
      !completedRequest.query.trim() ||
      props.loading ||
      props.loadingMoreBefore ||
      props.transcriptError ||
      pending ||
      !request
    )
      return
    const attemptKey = `${retryRequest}:${request.key}`
    if (attempted.current.has(attemptKey)) {
      setFailed(true)
      return
    }
    attempted.current.add(attemptKey)
    const generation = historyGeneration.current
    setPending(true)
    setFailed(false)
    Promise.resolve()
      .then(() => {
        if (historyGeneration.current === generation) return request.load()
      })
      .catch(() => {
        if (historyGeneration.current === generation) setFailed(true)
      })
      .finally(() => {
        if (historyGeneration.current === generation) setPending(false)
      })
  }, [
    active,
    open,
    queryPending,
    completedRequest,
    pending,
    props.loading,
    props.loadingMoreBefore,
    props.transcriptError,
    request,
    retryRequest,
  ])
  const isLoading = open && active && (queryPending || historyLoading)
  useEffect(() => {
    if (!open || !active) return
    recordConversationDiagnostic('search-status', {
      queryPending,
      historyLoading,
      historyIncomplete: incomplete,
      historyPending: pending,
      historyFailed,
      loading: Boolean(props.loading),
      loadingMoreBefore: Boolean(props.loadingMoreBefore),
    })
  }, [
    active,
    open,
    queryPending,
    historyLoading,
    incomplete,
    pending,
    historyFailed,
    props.loading,
    props.loadingMoreBefore,
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
    searchTarget,
    result: {
      matches: totalMatches,
      active: matches.length ? index + 1 : 0,
      isCapped,
    },
    isLoading,
    historyLoading,
    historyFailed: Boolean(query.trim() && historyFailed),
    retry: () => {
      setFailed(false)
      setRetryRequest(current => current + 1)
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
