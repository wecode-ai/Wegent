import { useCallback, useSyncExternalStore } from 'react'

type Listener = () => void

export interface ScopedDraftStore {
  getValue(scopeKey: string): string
  setValue(scopeKey: string, value: string): void
  replaceValue(scopeKey: string, value: string): void
  replaceInputs(values: Record<string, string>): void
  getRevision(scopeKey: string): number
  getReplaceRevision(scopeKey: string): number
  getInputsSnapshot(): Readonly<Record<string, string>>
  subscribe(scopeKey: string, listener: Listener): () => void
  subscribeReplace(scopeKey: string, listener: Listener): () => void
  subscribeAll(listener: Listener): () => void
}

/** Keep draft publications outside provider state and notify only scope subscribers. */
export function createScopedDraftStore(
  initialInputs: Record<string, string> = {}
): ScopedDraftStore {
  let inputs = withoutEmptyValues(initialInputs)
  const revisions = new Map<string, number>()
  const replaceRevisions = new Map<string, number>()
  const listeners = new Map<string, Set<Listener>>()
  const replaceListeners = new Map<string, Set<Listener>>()
  const allListeners = new Set<Listener>()

  const notify = (scopeKey: string) => {
    listeners.get(scopeKey)?.forEach(listener => listener())
    allListeners.forEach(listener => listener())
  }
  const notifyReplace = (scopeKey: string) => {
    replaceListeners.get(scopeKey)?.forEach(listener => listener())
  }
  const subscribe = (scopeKey: string, listener: Listener) => {
    let scoped = listeners.get(scopeKey)
    if (!scoped) {
      scoped = new Set()
      listeners.set(scopeKey, scoped)
    }
    scoped.add(listener)
    return () => {
      scoped.delete(listener)
      if (scoped.size === 0) listeners.delete(scopeKey)
    }
  }
  const subscribeReplace = (scopeKey: string, listener: Listener) => {
    let scoped = replaceListeners.get(scopeKey)
    if (!scoped) {
      scoped = new Set()
      replaceListeners.set(scopeKey, scoped)
    }
    scoped.add(listener)
    return () => {
      scoped.delete(listener)
      if (scoped.size === 0) replaceListeners.delete(scopeKey)
    }
  }
  const replaceInputs = (values: Record<string, string>) => {
    const next = withoutEmptyValues(values)
    const changedScopes: string[] = []
    const scopes = new Set([...Object.keys(inputs), ...Object.keys(next)])
    for (const scopeKey of scopes) {
      if ((inputs[scopeKey] ?? '') === (next[scopeKey] ?? '')) continue
      revisions.set(scopeKey, (revisions.get(scopeKey) ?? 0) + 1)
      changedScopes.push(scopeKey)
    }
    if (changedScopes.length === 0) return
    inputs = next
    changedScopes.forEach(notify)
  }
  const setValue = (scopeKey: string, value: string) => {
    if ((inputs[scopeKey] ?? '') === value) return
    const next = { ...inputs }
    if (value) next[scopeKey] = value
    else delete next[scopeKey]
    inputs = next
    revisions.set(scopeKey, (revisions.get(scopeKey) ?? 0) + 1)
    notify(scopeKey)
  }
  const replaceValue = (scopeKey: string, value: string) => {
    setValue(scopeKey, value)
    replaceRevisions.set(scopeKey, (replaceRevisions.get(scopeKey) ?? 0) + 1)
    notifyReplace(scopeKey)
  }

  return {
    getValue: scopeKey => inputs[scopeKey] ?? '',
    setValue,
    replaceValue,
    replaceInputs,
    getRevision: scopeKey => revisions.get(scopeKey) ?? 0,
    getReplaceRevision: scopeKey => replaceRevisions.get(scopeKey) ?? 0,
    getInputsSnapshot: () => inputs,
    subscribe,
    subscribeReplace,
    subscribeAll(listener) {
      allListeners.add(listener)
      return () => allListeners.delete(listener)
    },
  }
}

export function useScopedDraftValue(store: ScopedDraftStore, scopeKey: string): string {
  const subscribe = useCallback(
    (listener: Listener) => store.subscribe(scopeKey, listener),
    [scopeKey, store]
  )
  const getSnapshot = useCallback(() => store.getValue(scopeKey), [scopeKey, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useScopedDraftRevision(store: ScopedDraftStore, scopeKey: string): number {
  const subscribe = useCallback(
    (listener: Listener) => store.subscribe(scopeKey, listener),
    [scopeKey, store]
  )
  const getSnapshot = useCallback(() => store.getRevision(scopeKey), [scopeKey, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useScopedDraftReplaceRevision(store: ScopedDraftStore, scopeKey: string): number {
  const subscribe = useCallback(
    (listener: Listener) => store.subscribeReplace(scopeKey, listener),
    [scopeKey, store]
  )
  const getSnapshot = useCallback(() => store.getReplaceRevision(scopeKey), [scopeKey, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function withoutEmptyValues(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value))
}
