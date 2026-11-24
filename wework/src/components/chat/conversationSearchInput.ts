import { recordConversationDiagnostic } from '@wegent/collaboration/conversation/conversationDiagnostics'
import type { ConversationSearchScope } from './conversationSearchResources'

export type ConversationSearchRequest = { query: string }

/** Input and committed queries have distinct identities until debounce or explicit submission. */
export function createConversationSearchInput(scope: ConversationSearchScope) {
  const initial: ConversationSearchRequest = { query: '' }
  let snapshot = { scope, request: initial, completed: initial }
  const listeners = new Set<() => void>()
  const active = new Set<() => void>()
  const pageOwners = new Map<() => void, () => void>()
  let pageObservationActive = false
  let pageActivation = 0
  let released:
    | {
        request: ConversationSearchRequest
        completed: ConversationSearchRequest
        activation: number
      }
    | undefined
  const releasePages = (callbacks: Iterable<() => void>) => {
    if (
      released?.request === snapshot.request &&
      released.completed === snapshot.completed &&
      released.activation === pageActivation
    )
      return
    const owners = new Set(callbacks)
    if (!owners.size) return
    released = {
      request: snapshot.request,
      completed: snapshot.completed,
      activation: pageActivation,
    }
    owners.forEach(release => release())
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const publish = () => listeners.forEach(listener => listener())
  const schedule = () => {
    cancel()
    if (!active.size || snapshot.request === snapshot.completed) return
    const request = snapshot.request
    const startedAt = performance.now()
    timer = setTimeout(() => {
      timer = undefined
      if (!active.size || snapshot.request !== request) return
      snapshot = { ...snapshot, completed: request }
      recordConversationDiagnostic('search-debounce', {
        queryLength: request.query.length,
        elapsedMs: performance.now() - startedAt,
      })
      publish()
    }, 150)
  }
  const subscribe = (listener: () => void, enabled: boolean, onReleasePage?: () => void) => {
    let attached = true
    const notify = () => {
      if (attached) listener()
    }
    listeners.add(notify)
    if (onReleasePage) {
      if (enabled && !pageObservationActive) pageActivation++
      pageObservationActive = enabled
      pageOwners.set(notify, onReleasePage)
    }
    if (enabled) {
      active.add(notify)
      if (active.size === 1) schedule()
    }
    if (
      onReleasePage &&
      (!enabled || !snapshot.request.query.trim() || snapshot.request !== snapshot.completed)
    )
      releasePages([onReleasePage])
    return () => {
      attached = false
      pageOwners.delete(notify)
      const stop = () => {
        listeners.delete(notify)
        if (enabled) active.delete(notify)
        if (!active.size) cancel()
      }
      // Page callback replacement must not restart a live input's debounce interval.
      if (onReleasePage) queueMicrotask(stop)
      else stop()
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void, onReleasePage?: () => void) =>
      subscribe(listener, false, onReleasePage),
    subscribeActive: (listener: () => void, onReleasePage?: () => void) =>
      subscribe(listener, true, onReleasePage),
    change(query: string) {
      const request = { query }
      snapshot = { ...snapshot, request, completed: query.trim() ? snapshot.completed : request }
      releasePages(pageOwners.values())
      schedule()
      publish()
      return request
    },
    commit() {
      cancel()
      if (snapshot.request !== snapshot.completed) {
        snapshot = { ...snapshot, completed: snapshot.request }
        publish()
      }
      return snapshot.request
    },
  }
}
