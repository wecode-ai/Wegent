import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { createCodeHighlightStore } from './codeHighlightStore'
import type { HighlightedCode } from './highlightCode'

/** Coalesce streaming updates while a worker is busy and reject stale language/text results. */
export function useCodeHighlight(code: string, language: string): HighlightedCode | null {
  const store = useMemo(() => createCodeHighlightStore(), [])
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener, { code, language }),
    [store, code, language]
  )
  const result = useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot)
  return result?.language === language ? result : null
}
