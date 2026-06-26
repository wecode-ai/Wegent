import { useCallback, useEffect, useState } from 'react'

const MAX_STORED_EXPANSION_STATES = 2000
const expansionStateByKey = new Map<string, boolean>()

type ExpansionUpdate = boolean | ((value: boolean) => boolean)

export function usePersistentProcessingExpansion(
  key: string | undefined,
  initialValue = false
): readonly [boolean, (update: ExpansionUpdate) => void] {
  const [expanded, setExpanded] = useState(() => readExpansionState(key, initialValue))

  useEffect(() => {
    setExpanded(readExpansionState(key, initialValue))
  }, [initialValue, key])

  const setPersistentExpanded = useCallback(
    (update: ExpansionUpdate) => {
      setExpanded(current => {
        const next = typeof update === 'function' ? update(current) : update
        if (key) {
          rememberExpansionState(key, next)
        }
        return next
      })
    },
    [key]
  )

  return [expanded, setPersistentExpanded]
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
