import { useCallback, useState, useSyncExternalStore } from 'react'

const MAX_STORED_EXPANSION_STATES = 2000
const expansionStateByKey = new Map<string, boolean>()
const expansionStateListeners = new Set<() => void>()

type ExpansionUpdate = boolean | ((value: boolean) => boolean)

export function usePersistentProcessingExpansion(
  key: string | undefined,
  initialValue = false
): readonly [boolean, (update: ExpansionUpdate) => void] {
  const [localExpanded, setLocalExpanded] = useState(initialValue)
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {}
      expansionStateListeners.add(listener)
      return () => expansionStateListeners.delete(listener)
    },
    [key]
  )
  const getSnapshot = useCallback(() => readExpansionState(key, initialValue), [initialValue, key])
  const persistedExpanded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const expanded = key ? persistedExpanded : localExpanded

  const setPersistentExpanded = useCallback(
    (update: ExpansionUpdate) => {
      if (!key) {
        setLocalExpanded(current => (typeof update === 'function' ? update(current) : update))
        return
      }

      const current = readExpansionState(key, initialValue)
      const next = typeof update === 'function' ? update(current) : update
      rememberExpansionState(key, next)
      emitExpansionStateChange()
    },
    [initialValue, key]
  )

  return [expanded, setPersistentExpanded]
}

export function clearPersistentProcessingExpansions() {
  if (expansionStateByKey.size === 0) return
  expansionStateByKey.clear()
  emitExpansionStateChange()
}

function readExpansionState(key: string | undefined, initialValue: boolean): boolean {
  if (!key) return initialValue
  return expansionStateByKey.get(key) ?? initialValue
}

function rememberExpansionState(key: string, value: boolean) {
  if (!expansionStateByKey.has(key) && expansionStateByKey.size >= MAX_STORED_EXPANSION_STATES) {
    const oldestKey = expansionStateByKey.keys().next().value
    if (oldestKey) expansionStateByKey.delete(oldestKey)
  }
  expansionStateByKey.set(key, value)
}

function emitExpansionStateChange() {
  for (const listener of Array.from(expansionStateListeners)) {
    listener()
  }
}
