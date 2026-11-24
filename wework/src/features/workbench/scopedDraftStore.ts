import { useCallback, useSyncExternalStore } from 'react'

interface DraftSnapshot {
  value: string
  revision: number
  replacement: number
}

const emptyDraft: DraftSnapshot = { value: '', revision: 0, replacement: 0 }

type Listener = () => void

export function createScopedDraftStore() {
  const drafts = new Map<string, DraftSnapshot>()
  const listenersByScope = new Map<string, Set<Listener>>()
  const read = (scope: string) => drafts.get(scope) ?? emptyDraft
  const update = (scope: string, value: string, replace: boolean) => {
    const previous = read(scope)
    if (value === previous.value && !replace) return false
    drafts.set(scope, {
      value,
      revision: previous.revision + 1,
      replacement: previous.replacement + Number(replace),
    })
    return true
  }
  const publish = (scope: string) => listenersByScope.get(scope)?.forEach(listener => listener())
  return {
    read,
    write(scope: string, value: string) {
      if (update(scope, value, false)) publish(scope)
    },
    replace(scope: string, value: string) {
      update(scope, value, true)
      publish(scope)
    },
    restore(values: Record<string, string>) {
      const incoming = new Map(Object.entries(values))
      const scopes = new Set([...drafts.keys(), ...incoming.keys(), ...listenersByScope.keys()])
      // Make the entire handoff visible before notifying any composer.
      for (const scope of scopes) update(scope, incoming.get(scope) ?? '', true)
      for (const scope of scopes) publish(scope)
    },
    exportInputs() {
      return Object.fromEntries(
        Array.from(drafts, ([scope, draft]) => [scope, draft.value] as const).filter(
          ([, value]) => value !== ''
        )
      )
    },
    subscribe(scope: string, listener: Listener) {
      const listeners = listenersByScope.get(scope) ?? new Set<Listener>()
      listenersByScope.set(scope, listeners)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) listenersByScope.delete(scope)
      }
    },
  }
}

export type ScopedDraftStore = ReturnType<typeof createScopedDraftStore>

export function useScopedDraft(store: ScopedDraftStore, scope: string) {
  const subscribe = useCallback(
    (listener: Listener) => store.subscribe(scope, listener),
    [store, scope]
  )
  const read = useCallback(() => store.read(scope), [store, scope])
  return useSyncExternalStore(subscribe, read, read)
}
