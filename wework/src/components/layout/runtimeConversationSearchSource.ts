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

export interface RuntimeConversationSearchOptions {
  target: SearchTarget | null
  getTarget(): SearchTarget | null
  searchTranscript(
    address: RuntimeTaskAddress,
    query: string
  ): Promise<RuntimeTranscriptSearchResponse>
  loadTranscript: RuntimeTranscriptLoader
  reloadRevision?: number
}
export function createRuntimeConversationSearchSource(initial: RuntimeConversationSearchOptions) {
  let observation = initial
  let page: SearchPage | null = null
  let generation = 0
  let scopeRevision = 0
  let pageController = new AbortController()
  let requestedCursors = { before: new Set<string>(), after: new Set<string>() }
  let pendingContext: { generation: number; promise: Promise<void> } | null = null
  let pendingRead: Promise<unknown> = Promise.resolve()
  const listeners = new Set<() => void>()
  const project = () => {
    const transcript = page?.key === observation.target?.key ? page?.transcript : null
    return transcript
      ? {
          turns: transcript.turns,
          messages: projectRuntimeConversationTurns(transcript.turns),
          hasMoreBefore: Boolean(transcript.hasMoreBefore && transcript.beforeCursor),
          hasMoreAfter: Boolean(transcript.hasMoreAfter && transcript.afterCursor),
          loadingMoreBefore: page?.loading === 'before',
          loadingMoreAfter: page?.loading === 'after',
          loadError: page?.loadError ?? null,
        }
      : null
  }
  let snapshot = project()
  const publishPage = (next: SearchPage | null) => {
    page = next
    snapshot = project()
    listeners.forEach(listener => listener())
  }
  const bind = ({
    target,
    getTarget,
    searchTranscript,
    loadTranscript,
  }: RuntimeConversationSearchOptions) => {
    const ownerRevision = scopeRevision
    const releasePage = () => {
      pageController.abort()
      pageController = new AbortController()
      generation += 1
      requestedCursors = { before: new Set(), after: new Set() }
      pendingContext = null
      publishPage(null)
    }
    const assertCurrent = (signal: AbortSignal) => {
      signal.throwIfAborted()
      if (
        !listeners.size ||
        scopeRevision !== ownerRevision ||
        !target ||
        getTarget()?.key !== target.key
      ) {
        throw new DOMException('Conversation changed during search', 'AbortError')
      }
      return target
    }
    const queueRead = <T>(
      signal: AbortSignal,
      operation: (current: SearchTarget) => Promise<T>
    ) => {
      // Finish one disk read before starting another. Aborted queued queries or
      // selections are discarded so navigation cannot start concurrent scans.
      const request = pendingRead.catch(() => {}).then(() => operation(assertCurrent(signal)))
      pendingRead = request
      return request
    }
    const search = async (query: string, signal: AbortSignal) => {
      assertCurrent(signal)
      releasePage()
      const requestGeneration = generation
      const result = await queueRead(signal, current => searchTranscript(current.address, query))
      assertCurrent(signal)
      if (generation !== requestGeneration) throw new DOMException('Search changed', 'AbortError')
      return result
    }
    const ensureMatch = async (match: RuntimeTranscriptSearchMatch, signal: AbortSignal) => {
      assertCurrent(signal)
      releasePage()
      const requestGeneration = generation
      const controller = pageController
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      try {
        const transcript = await queueRead(controller.signal, current =>
          loadTranscript(current.address, {
            beforeCursor: match.cursor,
            limit: 5,
            isolated: true,
            signal: controller.signal,
          })
        )
        const current = assertCurrent(signal)
        controller.signal.throwIfAborted()
        if (generation !== requestGeneration) throw new DOMException('Search changed', 'AbortError')
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
    }
    const loadMoreContext = (direction: ContextDirection): Promise<void> => {
      const current = page
      if (!current || current.key !== getTarget()?.key) return Promise.resolve()
      if (pendingContext?.generation === current.generation) return pendingContext.promise
      const cursor =
        direction === 'before' ? current.transcript.beforeCursor : current.transcript.afterCursor
      const hasMore =
        direction === 'before' ? current.transcript.hasMoreBefore : current.transcript.hasMoreAfter
      if (!hasMore || !cursor) return Promise.resolve()
      const controller = pageController
      const requestGeneration = current.generation
      const assertPage = () => {
        assertCurrent(controller.signal)
        const latest = page
        if (
          !latest ||
          latest.generation !== requestGeneration ||
          generation !== requestGeneration
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
          signal: controller.signal,
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
            (nextCursor && (nextCursor === cursor || requestedCursors[direction].has(nextCursor)))
          ) {
            throw new Error('Conversation context returned a repeated or missing cursor')
          }
          requestedCursors[direction].add(cursor)
          publishPage({
            ...latest,
            transcript: mergeContextPage(latest.transcript, incoming, direction),
            loading: null,
            loadError: null,
          })
        })
        .catch(error => {
          if (controller.signal.aborted || generation !== requestGeneration) {
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
          if (pendingContext?.promise === request) pendingContext = null
        })
      pendingContext = { generation: requestGeneration, promise: request }
      return request
    }
    return { search, ensureMatch, releasePage, loadMoreContext }
  }
  const commands = {
    search: (...args: Parameters<ReturnType<typeof bind>['search']>) =>
      bind(observation).search(...args),
    ensureMatch: (...args: Parameters<ReturnType<typeof bind>['ensureMatch']>) =>
      bind(observation).ensureMatch(...args),
    releasePage: () => bind(observation).releasePage(),
    loadMoreContext: (...args: Parameters<ReturnType<typeof bind>['loadMoreContext']>) =>
      bind(observation).loadMoreContext(...args),
  }
  return {
    commands,
    getSnapshot: () => snapshot,
    updateOptions(next: RuntimeConversationSearchOptions) {
      const changed =
        observation.target?.key !== next.target?.key ||
        (observation.reloadRevision ?? 0) !== (next.reloadRevision ?? 0)
      observation = next
      if (changed) {
        scopeRevision++
        commands.releasePage()
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          pageController.abort()
          generation++
          scopeRevision++
          page = null
          snapshot = null
        })
      }
    },
  }
}
