import { useCallback, useState } from 'react'
import { createScopedDraftStore } from './scopedDraftStore'

export function useScopedDraftInput(initialInputs: () => Record<string, string>) {
  const [store] = useState(() => createScopedDraftStore(initialInputs()))
  const setInput = useCallback(
    (scopeKey: string, value: string) => store.setValue(scopeKey, value),
    [store]
  )
  return {
    store,
    setInput,
    replaceInputs: store.replaceInputs,
    getRevision: store.getRevision,
  }
}
