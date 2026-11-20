import { useCallback, useMemo, useSyncExternalStore } from 'react'

/** Subscribe to the browser's media state; server rendering keeps a stable default. */
export function useMediaQuery(query: string, serverMatches = false): boolean {
  const media = useMemo(
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query)
        : null,
    [query]
  )
  const subscribe = useCallback(
    (listener: () => void) => {
      media?.addEventListener('change', listener)
      return () => media?.removeEventListener('change', listener)
    },
    [media]
  )
  return useSyncExternalStore(
    subscribe,
    () => media?.matches ?? serverMatches,
    () => serverMatches
  )
}
