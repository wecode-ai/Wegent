import { useCallback, useSyncExternalStore } from 'react'

interface DraftSnapshot {
  value: string
  revision: number
  replacement: number
}

const emptyDraft: DraftSnapshot = { value: '', revision: 0, replacement: 0 }
const DRAFT_STORAGE_PREFIX = 'wework.composerDrafts.v1'
const DRAFT_PERSIST_DELAY_MS = 250

type Listener = () => void

export interface ScopedDraftStoreOptions {
  storageScope?: string
}

function draftStorageKey(storageScope?: string): string | undefined {
  return storageScope ? `${DRAFT_STORAGE_PREFIX}:${encodeURIComponent(storageScope)}` : undefined
}

function readPersistedDrafts(key: string | undefined): Map<string, string> {
  if (!key) return new Map()
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Map()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''
      )
    )
  } catch (error) {
    console.warn('[Wework] Ignoring unreadable composer draft storage:', error)
    return new Map()
  }
}

function persistDrafts(key: string | undefined, drafts: Map<string, string>): void {
  if (!key) return
  try {
    if (drafts.size === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(Object.fromEntries(drafts)))
  } catch (error) {
    console.error('[Wework] Failed to persist composer drafts:', error)
  }
}

export function createScopedDraftStore(options: ScopedDraftStoreOptions = {}) {
  const storageKey = draftStorageKey(options.storageScope)
  const persistedDrafts = readPersistedDrafts(storageKey)
  const drafts = new Map(
    Array.from(persistedDrafts, ([scope, value]) => [scope, { value, revision: 0, replacement: 0 }])
  )
  const listenersByScope = new Map<string, Set<Listener>>()
  let persistTimeout: ReturnType<typeof setTimeout> | undefined
  const read = (scope: string) => drafts.get(scope) ?? emptyDraft
  const persistNow = () => {
    if (persistTimeout !== undefined) {
      clearTimeout(persistTimeout)
      persistTimeout = undefined
    }
    persistDrafts(storageKey, persistedDrafts)
  }
  const schedulePersist = (immediate = false) => {
    if (!storageKey) return
    if (persistTimeout !== undefined) clearTimeout(persistTimeout)
    if (immediate) {
      persistNow()
      return
    }
    persistTimeout = setTimeout(persistNow, DRAFT_PERSIST_DELAY_MS)
  }
  const setPersistedDraft = (scope: string, value: string) => {
    if (value) persistedDrafts.set(scope, value)
    else persistedDrafts.delete(scope)
  }
  const update = (scope: string, value: string, replace: boolean) => {
    const previous = read(scope)
    if (value === previous.value && !replace) return false
    const alreadyScheduled = (persistedDrafts.get(scope) ?? '') === value
    drafts.set(scope, {
      value,
      revision: previous.revision + 1,
      replacement: previous.replacement + Number(replace),
    })
    setPersistedDraft(scope, value)
    if (!alreadyScheduled) schedulePersist(value === '')
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
      schedulePersist(true)
      publish(scope)
    },
    persistDraft(scope: string, value: string) {
      const previous = persistedDrafts.get(scope) ?? ''
      if (previous === value) return
      setPersistedDraft(scope, value)
      schedulePersist(value === '')
    },
    flush() {
      persistNow()
    },
    restore(values: Record<string, string>) {
      const incoming = new Map(Object.entries(values))
      const scopes = new Set([...drafts.keys(), ...incoming.keys(), ...listenersByScope.keys()])
      // Make the entire handoff visible before notifying any composer.
      for (const scope of scopes) update(scope, incoming.get(scope) ?? '', true)
      persistNow()
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
