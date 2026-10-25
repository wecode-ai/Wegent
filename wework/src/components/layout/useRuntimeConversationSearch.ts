import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type {
  RuntimeTaskAddress,
  RuntimeTranscriptSearchMatch,
  RuntimeTranscriptSearchResponse,
} from '@wegent/chat-core/runtime'
import type { RuntimePaneTranscript, RuntimeTranscriptLoader } from '@/types/workbench'
import {
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
} from '@wegent/chat-core/runtime-conversation-turns'

interface SearchTarget {
  key: string
  address: RuntimeTaskAddress
}

type ContextDirection = 'before' | 'after'

interface SearchPage {
  key: string
  generation: number
  transcript: RuntimePaneTranscript
  loading: ContextDirection | null
  loadError: string | null
}

function mergeContextPage(
  current: RuntimePaneTranscript,
  incoming: RuntimePaneTranscript,
  direction: ContextDirection
): RuntimePaneTranscript {
  const incomingTurns = incoming.turns.map(turn => ({
    ...turn,
    itemMerge: direction === 'before' ? ('prepend' as const) : undefined,
  }))
  const merged = mergeRuntimeConversationTurns(current.turns, incomingTurns)
  const mergedById = new Map(merged.map(turn => [turn.id, turn]))
  // Legacy pages may have no provider timestamps or global indexes. Their
  // direction is authoritative; snapshot merge's timestamp sort is not.
  const ordered =
    direction === 'before'
      ? [...incomingTurns, ...current.turns]
      : [...current.turns, ...incomingTurns]
  const ids = Array.from(new Set(ordered.map(turn => turn.id)))
  const turns = ids.flatMap(id => {
    const turn = mergedById.get(id)
    return turn ? [turn] : []
  })
  return {
    ...current,
    turns,
    messages: projectRuntimeConversationTurns(turns),
    ...(direction === 'before'
      ? { beforeCursor: incoming.beforeCursor, hasMoreBefore: incoming.hasMoreBefore }
      : { afterCursor: incoming.afterCursor, hasMoreAfter: incoming.hasMoreAfter }),
  }
}

export function useRuntimeConversationSearch({
  target,
  targetRef,
  searchTranscript,
  loadTranscript,
}: {
  target: SearchTarget | null
  targetRef: RefObject<SearchTarget | null>
  searchTranscript: (
    address: RuntimeTaskAddress,
    query: string
  ) => Promise<RuntimeTranscriptSearchResponse>
  loadTranscript: RuntimeTranscriptLoader
}) {
  const [page, setPage] = useState<SearchPage | null>(null)
  const pageRef = useRef<SearchPage | null>(null)
  const generation = useRef(0)
  const pageController = useRef(new AbortController())
  const requestedCursors = useRef({ before: new Set<string>(), after: new Set<string>() })
  const pendingContext = useRef<{ generation: number; promise: Promise<void> } | null>(null)
  const pendingRead = useRef<Promise<unknown>>(Promise.resolve())
  const publishPage = useCallback((next: SearchPage | null) => {
    pageRef.current = next
    setPage(next)
  }, [])
  const releasePage = useCallback(() => {
    pageController.current.abort()
    pageController.current = new AbortController()
    generation.current += 1
    requestedCursors.current = { before: new Set(), after: new Set() }
    pendingContext.current = null
    publishPage(null)
  }, [publishPage])
  const previousTargetKey = useRef(target?.key)
  useLayoutEffect(() => {
    if (previousTargetKey.current === target?.key) return
    previousTargetKey.current = target?.key
    releasePage()
  }, [target?.key, releasePage])
  useLayoutEffect(
    () => () => {
      pageController.current.abort()
      generation.current += 1
      pageRef.current = null
    },
    []
  )
  const assertCurrent = useCallback(
    (signal: AbortSignal) => {
      signal.throwIfAborted()
      if (!target || targetRef.current?.key !== target.key) {
        throw new DOMException('Conversation changed during search', 'AbortError')
      }
      return target
    },
    [target, targetRef]
  )
  const queueRead = useCallback(
    <T>(signal: AbortSignal, operation: (current: SearchTarget) => Promise<T>) => {
      // Finish one disk read before starting another. Aborted queued queries or
      // selections are discarded so navigation cannot start concurrent scans.
      const request = pendingRead.current
        .catch(() => {})
        .then(() => operation(assertCurrent(signal)))
      pendingRead.current = request
      return request
    },
    [assertCurrent]
  )
  const search = useCallback(
    async (query: string, signal: AbortSignal) => {
      assertCurrent(signal)
      releasePage()
      const result = await queueRead(signal, current => searchTranscript(current.address, query))
      assertCurrent(signal)
      return result
    },
    [assertCurrent, queueRead, releasePage, searchTranscript]
  )
  const ensureMatch = useCallback(
    async (match: RuntimeTranscriptSearchMatch, signal: AbortSignal) => {
      assertCurrent(signal)
      releasePage()
      const requestGeneration = generation.current
      const controller = pageController.current
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      try {
        const transcript = await queueRead(controller.signal, current =>
          loadTranscript(current.address, { beforeCursor: match.cursor, limit: 5, isolated: true })
        )
        const current = assertCurrent(signal)
        controller.signal.throwIfAborted()
        if (generation.current !== requestGeneration)
          throw new DOMException('Search changed', 'AbortError')
        // Keep context isolated from the live conversation cache. A different
        // selection replaces this bounded page instead of joining disjoint slices.
        publishPage({
          key: current.key,
          generation: requestGeneration,
          transcript,
          loading: null,
          loadError: null,
        })
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },
    [assertCurrent, queueRead, loadTranscript, publishPage, releasePage]
  )
  const loadMoreContext = useCallback(
    (direction: ContextDirection): Promise<void> => {
      const current = pageRef.current
      if (!current || current.key !== targetRef.current?.key) return Promise.resolve()
      if (pendingContext.current?.generation === current.generation)
        return pendingContext.current.promise
      const cursor =
        direction === 'before' ? current.transcript.beforeCursor : current.transcript.afterCursor
      const hasMore =
        direction === 'before' ? current.transcript.hasMoreBefore : current.transcript.hasMoreAfter
      if (!hasMore || !cursor) return Promise.resolve()
      const controller = pageController.current
      const requestGeneration = current.generation
      const assertPage = () => {
        assertCurrent(controller.signal)
        const latest = pageRef.current
        if (
          !latest ||
          latest.generation !== requestGeneration ||
          generation.current !== requestGeneration
        ) {
          throw new DOMException('Search changed', 'AbortError')
        }
        return latest
      }
      publishPage({ ...current, loading: direction, loadError: null })
      const request: Promise<void> = queueRead(controller.signal, active =>
        loadTranscript(active.address, {
          limit: 5,
          isolated: true,
          ...(direction === 'before' ? { beforeCursor: cursor } : { afterCursor: cursor }),
        })
      )
        .then(incoming => {
          const latest = assertPage()
          const nextCursor = direction === 'before' ? incoming.beforeCursor : incoming.afterCursor
          const nextHasMore =
            direction === 'before' ? incoming.hasMoreBefore : incoming.hasMoreAfter
          if (
            (nextHasMore && !nextCursor) ||
            (nextCursor &&
              (nextCursor === cursor || requestedCursors.current[direction].has(nextCursor)))
          ) {
            throw new Error('Conversation context returned a repeated or missing cursor')
          }
          requestedCursors.current[direction].add(cursor)
          publishPage({
            ...latest,
            transcript: mergeContextPage(latest.transcript, incoming, direction),
            loading: null,
            loadError: null,
          })
        })
        .catch(error => {
          if (controller.signal.aborted || generation.current !== requestGeneration) {
            throw new DOMException('Search changed', 'AbortError')
          }
          const latest = assertPage()
          publishPage({
            ...latest,
            loading: null,
            loadError:
              error instanceof Error && error.name === 'AbortError'
                ? null
                : error instanceof Error
                  ? error.message
                  : String(error),
          })
          throw error
        })
        .finally(() => {
          if (pendingContext.current?.promise === request) pendingContext.current = null
        })
      pendingContext.current = { generation: requestGeneration, promise: request }
      return request
    },
    [assertCurrent, loadTranscript, publishPage, queueRead, targetRef]
  )
  const transcript = page?.key === target?.key ? page?.transcript : null
  const searchPage = useMemo(
    () =>
      transcript
        ? {
            turns: transcript.turns,
            messages: projectRuntimeConversationTurns(transcript.turns),
            hasMoreBefore: Boolean(transcript.hasMoreBefore && transcript.beforeCursor),
            hasMoreAfter: Boolean(transcript.hasMoreAfter && transcript.afterCursor),
            loadingMoreBefore: page?.loading === 'before',
            loadingMoreAfter: page?.loading === 'after',
            loadError: page?.loadError ?? null,
          }
        : null,
    [transcript, page?.loading, page?.loadError]
  )
  return {
    search,
    ensureMatch,
    page: searchPage,
    releasePage,
    loadMoreContext,
  }
}
