import {
  activateWorkbenchPane,
  createWorkbenchSplitGroupsState,
  getActiveWorkbenchLayout,
  migratePersistedWorkbenchSplitLayout,
  parsePersistedWorkbenchSplitGroups,
  pruneWorkbenchSplitGroups,
  serializeWorkbenchSplitGroups,
  type WorkbenchSplitGroupsState,
} from './workbenchSplitGroups'
import { collectWorkbenchPaneKeys } from './workbenchSplitLayout'

export interface SplitGroupsInput {
  storageKey: string
  legacyStorageKey: string
  activePaneKey: string
  validRuntimeKeys: string[]
  runtimeKeysReady: boolean
}
function load(input: SplitGroupsInput): WorkbenchSplitGroupsState {
  if (typeof window !== 'undefined') {
    try {
      const stored =
        parsePersistedWorkbenchSplitGroups(
          localStorage.getItem(input.storageKey),
          input.activePaneKey
        ) ??
        migratePersistedWorkbenchSplitLayout(
          localStorage.getItem(input.legacyStorageKey),
          input.activePaneKey
        )
      if (stored) return stored
    } catch (error) {
      console.warn('Failed to read workbench split groups:', error)
    }
  }
  return createWorkbenchSplitGroupsState(input.activePaneKey)
}
function createScope(input: SplitGroupsInput) {
  let state = load(input)
  const observedRuntimeKeys = new Set<string>()
  const listeners = new Set<() => void>()
  let initialPersistenceAttempted = false
  const persist = () => {
    initialPersistenceAttempted = true
    try {
      window.localStorage.setItem(input.storageKey, serializeWorkbenchSplitGroups(state))
    } catch (error) {
      console.warn('Failed to persist workbench split groups:', error)
    }
  }
  return {
    observedRuntimeKeys,
    getSnapshot: () => state,
    ensurePersisted() {
      if (!initialPersistenceAttempted) persist()
    },
    commit(update: (current: WorkbenchSplitGroupsState) => WorkbenchSplitGroupsState) {
      const next = update(state)
      if (next !== state) {
        state = next
        persist()
        listeners.forEach(listener => listener())
      }
      return state
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** One hook owns its per-tab layouts; each action stays bound to its original storage scope. */
export function createWorkbenchSplitGroupsOwner() {
  const scopes = new Map<string, ReturnType<typeof createScope>>()
  let previous: { scopeKey: string; paneKey: string } | undefined
  const forScope = (input: SplitGroupsInput) => {
    const key = JSON.stringify([input.storageKey, input.legacyStorageKey])
    let scope = scopes.get(key)
    if (!scope) {
      scope = createScope(input)
      scopes.set(key, scope)
    }
    return scope
  }
  return {
    forScope,
    observe(input: SplitGroupsInput, listener: () => void) {
      const scope = forScope(input)
      const stop = scope.subscribe(listener)
      const scopeKey = JSON.stringify([input.storageKey, input.legacyStorageKey])
      const sameScope = previous?.scopeKey === scopeKey
      const unchanged = sameScope && previous?.paneKey === input.activePaneKey
      const keepRestored =
        input.activePaneKey.startsWith('blank:') &&
        collectWorkbenchPaneKeys(getActiveWorkbenchLayout(scope.getSnapshot()).root).some(key =>
          key.startsWith('runtime:')
        ) &&
        (!sameScope || previous?.paneKey.startsWith('blank:'))
      previous = { scopeKey, paneKey: input.activePaneKey }
      if (input.runtimeKeysReady)
        input.validRuntimeKeys.forEach(key => scope.observedRuntimeKeys.add(key))
      scope.commit(current => {
        let next =
          unchanged || keepRestored ? current : activateWorkbenchPane(current, input.activePaneKey)
        if (!input.runtimeKeysReady) return next
        const validKeys = new Set([...input.validRuntimeKeys, input.activePaneKey])
        const layouts = [getActiveWorkbenchLayout(next), ...next.groups.map(group => group.layout)]
        layouts.forEach(layout =>
          collectWorkbenchPaneKeys(layout.root).forEach(key => {
            if (key.startsWith('runtime:') && !scope.observedRuntimeKeys.has(key))
              validKeys.add(key)
          })
        )
        next = pruneWorkbenchSplitGroups(next, validKeys, input.activePaneKey)
        return next
      })
      scope.ensurePersisted()
      return stop
    },
  }
}
